import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};

function boot(url){
  return new Promise(res=>{
    const errs=[];const vc=new VirtualConsole();
    vc.on('jsdomError',e=>{if(!/scrollTo|Not implemented/.test(e.message))errs.push(e.message);});
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url});
    const w=dom.window;
    w.alert=()=>{}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
    setTimeout(()=>res({w,d:w.document,errs}),700);
  });
}

// ── 아이폰 단축어 안내 ────────────────────────────────
let r=await boot('https://tjso.github.io/travel/index.html');
const guide=()=>[...r.d.querySelectorAll('#fmCollect details')].find(x=>x.textContent.includes('공유 버튼으로 바로 담기'));
t('공유 안내가 인박스에 있음', !!guide());
t('안드로이드 안내 포함', guide().textContent.includes('공유 목록에 이 앱이 바로'));
t('아이폰은 미지원임을 밝힘', guide().textContent.includes('공유 목록에 올리는 기능을 지원하지 않습니다'));
t('단축어 4단계', guide().querySelectorAll('.fm-guide-step').length===4);
t('붙여넣을 주소 생성', r.w.eval('shBase()')==='https://tjso.github.io/travel/index.html?url=');
t('주소 입력칸 노출', r.d.getElementById('shBaseIn').value==='https://tjso.github.io/travel/index.html?url=');
t('주소칸은 읽기 전용', r.d.getElementById('shBaseIn').hasAttribute('readonly'));

let copied=null;
Object.defineProperty(r.w.navigator,'clipboard',{value:{writeText:async v=>{copied=v;}},configurable:true});
await r.w.eval('shCopyBase()');
await new Promise(x=>setTimeout(x,120));
t('복사 버튼이 주소를 복사', copied==='https://tjso.github.io/travel/index.html?url=');
t('복사 성공 안내', r.d.getElementById('shCopyOut').textContent.includes('복사했습니다'));

// 클립보드가 막히면 직접 고를 수 있게 안내한다
Object.defineProperty(r.w.navigator,'clipboard',{value:{writeText:async()=>{throw new Error('거부');}},configurable:true});
await r.w.eval('shCopyBase()');
await new Promise(x=>setTimeout(x,120));
t('복사 실패 시 대체 안내', r.d.getElementById('shCopyOut').textContent.includes('길게 눌러 복사'));
t('안내 화면에서 오류 0', r.errs.length===0);

// 파일로 열면 주소를 만들 수 없다고 정직하게 알린다
r=await boot('file:///Users/x/app.html');
t('파일 실행 시 주소 빈값', r.w.eval('shBase()')==='');
t('파일 실행 시 주소칸 없음', r.d.getElementById('shBaseIn')===null);
t('파일 실행 시 이유 안내', guide().textContent.includes('인터넷 주소로 연 뒤'));
t('파일 실행에서도 오류 0', r.errs.length===0);

// ── 현지 상황 보기 ────────────────────────────────────
r=await boot('https://l/index.html');
const live=()=>[...r.d.querySelectorAll('#fmNow details.fm-panel')].find(x=>x.textContent.includes('현지 상황'));
t('현지 상황 패널 존재', !!live());
t('요약이 목적지', live().querySelector('summary i').textContent==='후쿠오카');
let links=[...live().querySelectorAll('a')];
t('링크 4종', links.length===4);
t('전부 새 탭으로', links.every(a=>a.target==='_blank'));
t('전부 noopener', links.every(a=>a.rel.includes('noopener')));
t('전부 https', links.every(a=>a.href.startsWith('https://')));
t('API 키를 요구하지 않음', links.every(a=>!/key=|token=/i.test(a.href)));
t('목적지가 링크에 반영', decodeURIComponent(links[1].href).includes('후쿠오카'));
t('영상을 앱에 심지 않음', live().querySelectorAll('iframe,video').length===0);
t('직접 틀지 않는다고 고지', live().textContent.includes('앱이 영상을 직접 틀지는 않고'));

// 목적지를 바꾸면 링크가 따라간다 — 다른 나라로 확장해도 손댈 곳이 없다
r.w.eval("affSetDest('오사카')");
links=[...live().querySelectorAll('a')];
t('목적지 변경이 요약에 반영', live().querySelector('summary i').textContent==='오사카');
t('목적지 변경이 링크에 반영', links.every(a=>decodeURIComponent(a.href).includes('오사카')));
t('바뀐 뒤에도 후쿠오카 잔재 없음', links.every(a=>!decodeURIComponent(a.href).includes('후쿠오카')));
t('현지 상황에서 오류 0', r.errs.length===0);

console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
