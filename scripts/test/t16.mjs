import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const FM=()=>w.eval('foodMap');
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
let alerts=[]; w.alert=m=>alerts.push(m); w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

w.eval('bgSetTotal(80000);bgSetDays(4);renderFoodMap();');
t('환율 카드 렌더', w.document.body.textContent.includes('환율'));
t('기본 통화 JPY', w.eval('fxCur()')==='JPY');
t('기본 자국통화 KRW', w.eval('fxHome()')==='KRW');
t('환율 없으면 null', w.eval('fxRate()')===null);
t('환율 없으면 환산 없음', w.eval('fxHomeTxt(10000)')==='');
t('환율 없어도 엔 표시는 정상', w.eval('fxBoth(10000)')==='10,000엔');

// API 조회
let url=null;
w.fetch=async(u)=>{url=u;return{ok:true,json:async()=>({amount:1,base:'JPY',date:'2026-07-28',rates:{KRW:9.35}})};};
await w.eval('fxFetch()');
await new Promise(r=>setTimeout(r,200));
console.log('   요청:',url);
t('조회 URL 형식', url.includes('from=JPY')&&url.includes('to=KRW'));
t('환율 저장', w.eval('fxRate()')===9.35);
t('기준일 저장', w.eval('fxAt()')==='2026-07-28');
t('환산 계산', w.eval('fxHomeTxt(10000)')==='약 93,500원');
t('양쪽 표기', w.eval('fxBoth(10000)')==='10,000엔 (약 93,500원)');

// 예산에 반영
w.eval('renderFoodMap()');
const txt=w.document.getElementById('tab-map').textContent;
t('예산 요약에 원화 환산', txt.includes('원'));
const ctx=w.eval('asContext()');
t('컨텍스트에 환율', ctx.includes('[환율] 1JPY'));
t('컨텍스트 잔액에 원화', /남은 돈 80,000엔 \(약 748,000원\)/.test(ctx));

// 조회 실패해도 앱 생존
w.fetch=async()=>{throw new Error('네트워크 끊김');};
await w.eval('fxFetch()');
await new Promise(r=>setTimeout(r,200));
t('실패해도 기존 환율 유지', w.eval('fxRate()')===9.35);
t('실패 안내 표시', w.document.getElementById('fxOut').textContent.includes('조회 실패'));

// 직접 입력
w.eval('fxSetRate(9.5)');
t('직접 입력 반영', w.eval('fxRate()')===9.5 && w.eval("(foodMap.fx||{}).src")==='manual');
w.eval('fxSetRate(0)');
t('0 이하는 해제', w.eval('fxRate()')===null);
w.eval('fxSetRate("abc")');
t('숫자 아니면 해제', w.eval('fxRate()')===null);

// 오래된 환율 경고
w.eval("foodMap.fx={rate:9.3,at:'2026-07-01',src:'api'};renderFoodMap();");
t('7일 지난 값 경고', w.document.getElementById('tab-map').textContent.includes('7일 이상 지난 값'));
w.eval("foodMap.fx={rate:9.3,at:TODAY,src:'api'};renderFoodMap();");
t('오늘 값은 경고 없음', !w.document.getElementById('tab-map').textContent.includes('7일 이상 지난 값'));

// 통화 변경
w.eval("fxSetCur('EUR');fxSetHome('USD');");
t('통화 변경 저장', w.eval('fxCur()')==='EUR' && w.eval('fxHome()')==='USD');
t('통화 바꾸면 기존 환율 초기화', w.eval('fxRate()')===null);
alerts=[];
w.eval("fxSetCur('USD');");
await w.eval('fxFetch()');
t('같은 통화면 안내', alerts.some(a=>a.includes('같습니다')));

// 백업
w.eval("fxSetCur('JPY');fxSetHome('KRW');fxSetRate(9.4);");
let cap=null; w.Blob=function(a){this.a=a;}; w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a[0]);return 'blob:x';};
w.eval('exportData()');
t('백업에 환율 포함', cap.foodMap.fx && cap.foodMap.fx.rate===9.4);
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
