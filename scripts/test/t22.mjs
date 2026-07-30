import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};

/* 공유로 들어온 링크를 인박스에 담는 흐름은 "주소에 파라미터가 붙은 채로 앱이 열리는"
   상황이므로, 매번 그 주소로 새 창을 띄워 확인한다. */
function boot(search){
  return new Promise(res=>{
    const errs=[];const vc=new VirtualConsole();
    vc.on('jsdomError',e=>{if(!/scrollTo|Not implemented/.test(e.message))errs.push(e.message);});
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
      url:'https://local.test/index.html'+search});
    const w=dom.window;
    w.alert=()=>{}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
    setTimeout(()=>res({w,d:w.document,errs}),700);
  });
}
const inboxPanel=(d)=>[...d.querySelectorAll('#fmCollect details.fm-panel')]
  .find(x=>x.textContent.includes('여행 인박스'));

// 1) url 파라미터로 공유
let r=await boot('?url='+encodeURIComponent('https://www.instagram.com/reel/abc/')+'&title='+encodeURIComponent('텐진 라멘'));
let inbox=r.w.eval('foodMap.inbox');
t('공유 링크가 인박스에 담김', inbox.length===1);
t('URL 보존', inbox[0].url==='https://www.instagram.com/reel/abc/');
t('플랫폼 판정', inbox[0].platform==='인스타그램');
t('제목이 메모로', inbox[0].note==='텐진 라멘');
t('담기 탭이 열림', [...r.d.querySelectorAll('.tab.on')].map(x=>x.id).join()==='tab-collect');
t('인박스 패널 자동 펼침', inboxPanel(r.d).hasAttribute('open'));
t('담았다는 안내', inboxPanel(r.d).textContent.includes('공유한 링크를 담았습니다'));
t('주소에서 파라미터 제거', r.w.location.search==='');
t('부팅 완료(차단 대화상자 없음)', r.d.getElementById('app').style.display==='block');
t('런타임 오류 0', r.errs.length===0);

// 2) text 안에 링크가 섞여 오는 경우 (틱톡·인스타 공유가 이 형태)
r=await boot('?text='+encodeURIComponent('여기 진짜 맛있음 https://www.tiktok.com/@a/video/1 꼭 가보셈'));
inbox=r.w.eval('foodMap.inbox');
t('문장 속 링크 추출', inbox.length===1&&inbox[0].url==='https://www.tiktok.com/@a/video/1');
t('링크 뺀 나머지가 메모', inbox[0].note.includes('여기 진짜 맛있음')&&inbox[0].note.includes('꼭 가보셈'));
t('메모에 링크 중복 없음', !inbox[0].note.includes('http'));

// 3) 구글맵 정식 링크는 이름까지 뽑는다
r=await boot('?url='+encodeURIComponent('https://www.google.com/maps/place/%E4%B8%80%E6%A5%BD+%E5%A4%A9%E7%A5%9E%E5%BA%97/@33.5902,130.4017,17z'));
inbox=r.w.eval('foodMap.inbox');
t('구글맵 이름 자동 추출', inbox[0].guess&&inbox[0].guess.name==='一楽 天神店');
t('URL 출처로 표시', inbox[0].guess.src==='url');

// 4) 평소 실행은 아무 영향 없어야 한다
r=await boot('');
t('파라미터 없으면 인박스 그대로', r.w.eval('foodMap.inbox').length===0);
t('평소 실행도 담기 탭', [...r.d.querySelectorAll('.tab.on')].map(x=>x.id).join()==='tab-collect');
t('평소엔 안내 없음', !inboxPanel(r.d).textContent.includes('공유한 링크를 담았습니다'));
t('평소 실행 오류 0', r.errs.length===0);

// 5) 링크가 없는 공유는 무시한다
r=await boot('?text='+encodeURIComponent('그냥 글만 공유함'));
t('링크 없으면 담지 않음', r.w.eval('foodMap.inbox').length===0);
t('링크 없으면 안내도 없음', !inboxPanel(r.d).textContent.includes('공유한 링크를 담았습니다'));

// 6) 매니페스트에 공유 대상이 선언돼 있다
const mf=JSON.parse(fs.readFileSync('src/manifest.webmanifest','utf8'));
t('매니페스트에 share_target', !!mf.share_target);
t('GET 방식', mf.share_target.method==='GET');
t('url·text·title 파라미터', mf.share_target.params.url==='url'&&mf.share_target.params.text==='text'&&mf.share_target.params.title==='title');
t('앱 안으로 들어오는 action', String(mf.share_target.action).includes('index.html'));

console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
