import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const csv=fs.readFileSync('private/후쿠오카_137.csv','utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const FM=()=>w.eval('foodMap');
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
w.alert=()=>{}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
const T=w.eval('TODAY');
const panel=()=>[...w.document.querySelectorAll('#fmNow details.fm-panel')].find(x=>x.querySelector('summary b')&&x.querySelector('summary b').textContent==='날씨');
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

// WMO 코드 → 한국어
t('코드 0 맑음', w.eval('wxCode(0)')==='맑음');
t('코드 3 흐림', w.eval('wxCode(3)')==='흐림');
t('코드 61 약한 비', w.eval('wxCode(61)')==='약한 비');
t('코드 71 눈', w.eval('wxCode(71)')==='눈');
t('코드 95 뇌우', w.eval('wxCode(95)')==='뇌우');
t('알 수 없는 코드는 빈 문자열', w.eval('wxCode(12345)')==='');

// 좌표가 없으면 조회하지 않는다
let called=0; w.fetch=async()=>{called++;throw new Error('불려서는 안 된다');};
t('좌표 없으면 기준점 없음', w.eval('wxPoint()')===null);
w.eval('renderFoodMap()');
await w.eval('wxFetch(false)');
await new Promise(r=>setTimeout(r,150));
t('좌표 없으면 호출 0', called===0);
t('좌표 없을 때 안내', w.document.getElementById('wxOut').textContent.includes('기준 좌표가 없습니다'));

// 숙소를 정하면 그 좌표를 쓴다
w.fmMerge(w.fmCsv(csv));
FM().places.forEach((p,i)=>{p.lat=33.59+i*0.001;p.lng=130.40+i*0.001;});
FM().selected=FM().places[0].id; w.eval('fmSetHotelFromSpot()');
const pt=w.eval('wxPoint()');
t('숙소 좌표를 기준으로 삼음', pt&&pt.src==='숙소');

// 조회 성공
let url=null;
const mk=(pop)=>({ok:true,json:async()=>({daily:{
  time:[T,'2026-07-31','2026-08-01'],
  weather_code:[3,61,0],
  temperature_2m_max:[31.2,28.4,33.0],
  temperature_2m_min:[24.1,23.0,25.5],
  precipitation_probability_max:[pop,80,5]}})});
w.fetch=async(u)=>{url=u;return mk(15);};
await w.eval('wxFetch(false)');
await new Promise(r=>setTimeout(r,250));
t('API 키를 요구하지 않음', !/key=|token/i.test(url));
t('좌표가 URL 에 실림', url.includes('latitude=33.5900')&&url.includes('longitude=130.4000'));
t('일별 예보 항목 요청', url.includes('precipitation_probability_max'));
t('3일 저장', w.eval('wxDays().length')===3);
t('받은 날 기록', w.eval('wxAt()')===T);
t('오늘 문구 조립', w.eval('wxTxt(TODAY)')==='흐림 · 31/24도 · 강수 15%');
t('예보 없는 날짜는 빈 문자열', w.eval("wxTxt('2030-01-01')")==='');

// 강수확률에 따른 실내 대안 안내
t('강수 15%는 비 아님', w.eval('wxRainy(TODAY)')===false);
t('강수 15%면 실내 권장 버튼 없음', !panel().textContent.includes('비 오는 날 후보'));
w.fetch=async(u)=>{url=u;return mk(85);};
await w.eval('wxFetch(false)');
await new Promise(r=>setTimeout(r,250));
t('강수 85%는 비로 판정', w.eval('wxRainy(TODAY)')===true);
t('강수 85%면 실내 권장 노출', panel().textContent.includes('비 오는 날 후보'));
t('요약에 오늘 날씨', panel().querySelector('summary i').textContent.includes('강수 85%'));

// 어시스턴트가 날씨를 근거로 받는다
const ctx=w.eval('asContext()');
t('컨텍스트에 오늘 날씨', ctx.includes('[오늘 날씨]'));
t('컨텍스트에 비 가능성 표시', ctx.includes('비 가능성 높음'));

// 일정 배분 일차별로 그 날 날씨가 붙는다 (34절 "일정 화면에 결합")
w.eval('bgSetDays(3);plBuild();renderFoodMap();');
const dayRows=[...w.document.querySelectorAll('#fmPlan details.fm-plan-day summary')].map(x=>x.textContent);
console.log('   일차 요약:', dayRows[0]);
t('1일차에 오늘 날씨', dayRows[0]&&dayRows[0].includes('강수 85%'));
t('2일차에 그 날 날씨', dayRows[1]&&dayRows[1].includes('약한 비'));
t('3일차에 그 날 날씨', dayRows[2]&&dayRows[2].includes('맑음'));

// 응답이 예상과 다르면 캐시를 지키고 조용히 넘어간다
w.fetch=async()=>({ok:true,json:async()=>({unexpected:true})});
await w.eval('wxFetch(false)');
await new Promise(r=>setTimeout(r,200));
t('형식 이상이면 안내', w.document.getElementById('wxOut').textContent.includes('실패'));
t('형식 이상이어도 캐시 유지', w.eval('wxDays().length')===3);
w.fetch=async()=>({ok:false,status:429,json:async()=>({reason:'너무 많은 요청'})});
await w.eval('wxFetch(false)');
await new Promise(r=>setTimeout(r,200));
t('HTTP 오류 시 사유 표시', w.document.getElementById('wxOut').textContent.includes('너무 많은 요청'));
t('HTTP 오류에도 캐시 유지', w.eval('wxDays().length')===3);
w.fetch=async()=>{throw new Error('네트워크 끊김');};
await w.eval('wxFetch(false)');
await new Promise(r=>setTimeout(r,200));
t('네트워크 실패해도 앱 생존', errs.length===0);
t('네트워크 실패에도 캐시 유지', w.eval('wxDays().length')===3);

// 자동 갱신은 세션당 한 번, 오늘 받았으면 건너뛴다
let autoCalls=0; w.fetch=async(u)=>{autoCalls++;return mk(15);};
w.eval('wxAutoTried=false');
await w.eval('wxAuto()');
await new Promise(r=>setTimeout(r,150));
t('오늘 이미 받았으면 자동 갱신 건너뜀', autoCalls===0);
w.eval("foodMap.wx.at='2026-01-01';wxAutoTried=false");
await w.eval('wxAuto()');
await new Promise(r=>setTimeout(r,200));
t('오래된 값이면 자동 갱신', autoCalls===1);
await w.eval('wxAuto()');
await new Promise(r=>setTimeout(r,150));
t('세션당 한 번만', autoCalls===1);

// 새 저장 키 없음 / 백업 포함
t('새 localStorage 키 없음', !html.includes("load('wx") && !html.includes("save('wx"));
w.eval("save('foodmap_v1',foodMap)");
let cap=null;
w.Blob=function(a){this.a=a;};
w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a[0]);return 'blob:x';};
w.eval('exportData()');
t('백업에 날씨 캐시 포함', cap.foodMap.wx&&Array.isArray(cap.foodMap.wx.days)&&cap.foodMap.wx.days.length===3);

t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
