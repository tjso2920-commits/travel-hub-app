/**
 * 검색·붙여넣기 한 칸.
 * 붙여넣은 것이 주소면 담고, 아니면 거른다. 사용자가 먼저 판단하지 않아도 되어야 한다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!/scrollTo|Not implemented/.test(e.message))errs.push(e.message);});
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const FM=()=>w.eval('foodMap');
const d=w.document;
let fail=0;const t=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c||x===undefined?'':' → '+JSON.stringify(x)));if(!c)fail++;};
w.alert=m=>{w.__a=m;}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
t('런타임 오류 0',errs.length===0);

w.eval(`foodMap.places=[
 {id:'a',name:'우동 타이라',cat:'맛집·식당',note:'가케우동',lat:33.59,lng:130.39,address:''},
 {id:'b',name:'커피 카운티',cat:'카페·디저트',note:'',lat:33.59,lng:130.40,address:''}];
 foodMap.filter='전체';foodMap.q='';foodMap.region='전체 지역';foodMap.kind='전체 음식·술';foodMap.status='기본 상태';
 foodMap.inbox=[];renderFoodMap();`);

const url=v=>w.eval(`fmIsUrl(${JSON.stringify(v)})`);
t('http 주소 인식', url('https://www.instagram.com/p/abc123/'));
t('구글맵 단축주소 인식', url('https://maps.app.goo.gl/xyz'));
t('www 로 시작해도 인식', url('www.tiktok.com/@a/video/1'));
t('유튜브 단축주소 인식', url('youtu.be/abc'));
t('가게 이름은 주소 아님', !url('우동 타이라'));
t('띄어쓰기 있으면 주소 아님', !url('https://a.com 메모'));
t('빈 값은 주소 아님', !url('')&&!url('   '));
t('점 있는 한 단어는 주소 아님', !url('스타벅스.리저브'), '한글 도메인은 지금 안 받는다');

/* 검색 */
const shown=()=>d.querySelectorAll('#fmList .place').length;
w.eval("fmOneInput('우동')");
t('글자를 넣으면 걸러짐', shown()===1&&FM().q==='우동', [shown(),FM().q]);
t('힌트 없음', d.getElementById('fmOneHint').textContent==='');
w.eval("fmOneInput('')");
t('비우면 전부 복귀', shown()===2);

/* 주소를 넣으면 거르지 않는다 — 거르면 목록이 통째로 비어 놀란다 */
w.eval("fmOneInput('https://maps.app.goo.gl/zzz')");
t('주소는 검색어로 안 씀', FM().q===''&&shown()===2, [FM().q,shown()]);
t('링크라고 알려줌', d.getElementById('fmOneHint').textContent.includes('링크'));

/* 담기 */
w.eval(`document.getElementById('fmSearch').value='https://www.instagram.com/p/xyz/';fmOneGo();`);
t('인박스에 담김', w.eval('ibList().length')===1, w.eval('ibList().length'));
t('주소가 그대로 저장', w.eval('ibList()[0].url')==='https://www.instagram.com/p/xyz/');
t('플랫폼 판정', w.eval('ibList()[0].platform')==='인스타그램', w.eval('ibList()[0].platform'));
t('입력칸 비워짐', d.getElementById('fmSearch').value==='');
t('인박스 패널이 열림', FM().panels&&FM().panels.inbox===true);
t('장소 목록은 그대로', shown()===2);

/* 구글맵 링크는 이름까지 읽는다 */
w.eval(`document.getElementById('fmSearch').value='https://www.google.com/maps/place/%EC%9A%B0%EB%8F%99/data=!x';fmOneGo();`);
t('구글맵 링크에서 이름 읽음', (w.eval('ibList()[0].guess')||{}).name==='우동', w.eval('JSON.stringify(ibList()[0].guess)'));

/* 검색어 상태에서 버튼을 누르면 지운다 */
w.eval("fmOneInput('커피');document.getElementById('fmSearch').value='커피';fmOneGo();");
t('검색 중 버튼 = 지우기', FM().q===''&&shown()===2&&d.getElementById('fmSearch').value==='');
t('그때는 담기지 않음', w.eval('ibList().length')===2, w.eval('ibList().length'));

/* 빈 칸에서 눌러도 죽지 않는다 */
w.eval("document.getElementById('fmSearch').value='';fmOneGo();");
t('빈 칸에서 눌러도 안전', w.eval('ibList().length')===2);

t('안내 문구가 바뀜', d.getElementById('fmSearch').placeholder.includes('링크'));
t('최종 런타임 오류 0', errs.length===0, errs.slice(0,2));
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
