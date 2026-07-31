import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!/scrollTo|Not implemented/.test(e.message))errs.push(e.message);});
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
w.alert=()=>{}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
const d=w.document;
const isSale=w.eval('SALE_MODE')===true;
console.log('   대상:', isSale?'판매용(구매자)':'개인용(판매자)');

/* 구매자가 앱을 처음 열었을 때 — 저장 데이터가 하나도 없는 상태 */
t('저장 장소 0에서 시작', w.eval('foodMap.places.length')===0);
t('첫 화면이 담기 탭', [...d.querySelectorAll('.tab.on')].map(x=>x.id).join()==='tab-collect');
t('본문이 채워져 있음', d.getElementById('fmCollect').innerHTML.length>2000);
t('빈 데이터에서도 오류 0', errs.length===0);

const hero=d.querySelector('#fmCollect .xhero');
t('히어로 존재', !!hero);
/* 운동 기능은 35절에서 삭제됐다. 그 흔적이 구매자 화면에 남아 있으면 안 된다. */
t('히어로에 운동웹 언급 없음', !hero.textContent.includes('운동웹'));
t('앱 어디에도 운동웹 없음', !d.body.textContent.includes('운동웹'));
t('히어로가 하는 일을 설명', hero.textContent.includes('실제로 갈 수 있는 일정'));

/* 목적지는 설정을 따라야 한다 — 다른 도시 구매자에게도 맞아야 하고 나라 확장의 전제다 */
t('히어로 부제가 목적지 사용', hero.querySelector('.xmeta').textContent.includes('후쿠오카'));
t('아이브로우에 도시 하드코딩 없음', !hero.querySelector('.xeyebrow').textContent.includes('FUKUOKA'));
w.eval("affSetDest('오사카')");
const hero2=d.querySelector('#fmCollect .xhero');
t('목적지 바꾸면 히어로도 바뀜', hero2.querySelector('.xmeta').textContent.includes('오사카'));
t('바뀐 뒤 이전 도시 잔재 없음', !hero2.querySelector('.xmeta').textContent.includes('후쿠오카'));
w.eval("affSetDest('후쿠오카')");

/* 판매용 스팟팩은 판매자가 구매자에게 줄 파일을 만드는 도구다 — 구매자에게 보이면 안 된다 */
const imp=d.querySelector('#fmCollect .importbox');
t('가져오기 박스 존재', !!imp);
if(isSale){
  t('구매자에게 판매용 스팟팩 감춤', !imp.textContent.includes('판매용 스팟팩'));
} else {
  t('판매자에게는 판매용 스팟팩 보임', imp.textContent.includes('판매용 스팟팩'));
}
t('가져오기 버튼은 남아 있음', imp.textContent.includes('파일 넣기'));

/* 구매자는 '판매용 스팟팩' 같은 판매자 용어의 뜻을 알 수 없다. 화면 문구에 남으면 안 된다. */
if(isSale){
  w.eval("showTab('plan')"); w.eval("showTab('now')");
  const seen=['fmCollect','fmPlan','fmNow'].map(i=>d.getElementById(i).textContent).join(' ');
  for(const jargon of ['판매용','판매자','스팟팩','개인용','운동웹']){
    t('구매자 화면에 판매자 용어 없음: '+jargon, !seen.includes(jargon));
  }
}

/* 데이터가 없을 때 각 탭이 빈 화면으로 끝나지 않고 무엇을 하라고 알려 주는가 */
t('시작 안내가 자동으로 열림', d.getElementById('fmCollect').textContent.includes('처음 설정'));
t('구글 목록 받는 방법 안내', [...d.querySelectorAll('#fmCollect a[href]')].some(x=>x.href.includes('takeout.google.com')));
t('데이터가 기기에만 저장된다는 고지', d.getElementById('fmCollect').textContent.includes('이 기기에만 저장'));

for(const [id,label] of [['fmPlan','일정'],['fmNow','지금 여행']]){
  const el=d.getElementById(id);
  t(label+' 탭도 내용이 있음', el.innerHTML.length>1000);
  t(label+' 탭 빈 화면 아님', el.textContent.trim().length>200);
}
w.eval("showTab('jp');renderJapanese()");
t('일본어 탭 렌더', d.getElementById('jpRoot').innerHTML.length>1000);

/* 첫 실행에서 네트워크·키를 강요하지 않는지 */
t('Gemini 키 없이 시작', !w.eval('ai.key'));
t('키 없어도 오류 0', errs.length===0);

t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
