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
const pad=n=>String(n).padStart(2,'0');
const hourAt=(offset)=>{const t=new Date(Date.now()+offset*3600*1000);
  return t.getFullYear()+'-'+pad(t.getMonth()+1)+'-'+pad(t.getDate())+'T'+pad(t.getHours())+':00';};
const mk=(pop,soonPop)=>({ok:true,json:async()=>({daily:{
  time:[T,'2026-07-31','2026-08-01'],
  weather_code:[3,61,0],
  temperature_2m_max:[31.2,28.4,33.0],
  temperature_2m_min:[24.1,23.0,25.5],
  precipitation_probability_max:[pop,80,5]},
  hourly:{time:[hourAt(0),hourAt(1),hourAt(2),hourAt(6)],
   precipitation_probability:[10,10,(soonPop===undefined?10:soonPop),95]}})});
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

// 시간별 예보 — 지금 나가도 되는지 판단하는 근거
t('URL 에 시간별 항목 요청', url.includes('hourly=precipitation_probability'));
t('시간별 저장됨', w.eval('wxHours().length')===4);
t('3시간 안 최대 강수 집계', (w.eval('wxSoon(3)')||{}).pop===10);
t('6시간 뒤 값은 3시간 창 밖', w.eval('wxSoonTxt(3)').includes('10%'));
w.fetch=async(u)=>{url=u;return mk(85,90);};
await w.eval('wxFetch(false)');
await new Promise(r=>setTimeout(r,250));
t('곧 비 오면 최대값 반영', (w.eval('wxSoon(3)')||{}).pop===90);
t('곧 비 오면 경고 문구', panel().textContent.includes('지금 나가면 비를 만날 수 있습니다'));
t('컨텍스트에 단기 예보', w.eval('asContext()').includes('[단기 예보]'));
/* 시간별이 빠진 응답이 와도 일별만으로 완결되어야 한다 */
w.fetch=async()=>({ok:true,json:async()=>({daily:{time:[T],weather_code:[0],
  temperature_2m_max:[30],temperature_2m_min:[22],precipitation_probability_max:[5]}})});
await w.eval('wxFetch(false)');
await new Promise(r=>setTimeout(r,250));
t('시간별 없어도 일별 동작', w.eval('wxTxt(TODAY)')==='맑음 · 30/22도 · 강수 5%');
t('시간별 없으면 단기 문구 빈값', w.eval('wxSoonTxt(3)')==='');
/* 뒤 검사를 위해 3일치 예보로 되돌린다 */
w.fetch=async(u)=>{url=u;return mk(85);};
await w.eval('wxFetch(false)');
await new Promise(r=>setTimeout(r,250));

// 지금부터 다시 짜기 — 현장에서 계획이 밀렸을 때
/* 앞선 검사들이 방문·일정 상태를 여러 번 바꿔 놓았다. 이 블록은 자기 상태를 직접 세운다. */
FM().places.forEach(x=>{x.visited=false;delete x.visitedAt;x.excluded=false;});
w.eval("foodMap.course=null;foodMap.plan=null;csSetStart(8);csBuild();");
t('사전 조건: 코스 생성됨', (FM().course&&FM().course.stops||[]).length>0);
t('시작 시각 8시 반영', FM().course.startHour===8);
t('courseStart 저장', FM().courseStart===8);
w.eval('csReplanNow()');
t('지금부터: courseStart 비움', FM().courseStart===null);
t('지금부터: 현재 시각으로 다시 짬', FM().course.startHour===new Date().getHours());
const firstId=FM().course.stops[0].id;
FM().places.find(x=>x.id===firstId).visited=true;
w.eval('csReplanNow()');
t('지금부터: 방문한 곳 제외', !FM().course.stops.some(x=>x.id===firstId));
w.eval('renderFoodMap()');
const csPanel=()=>[...w.document.querySelectorAll('#fmPlan details.fm-panel')].find(x=>x.textContent.includes('오늘 동선'));
t('지금부터 다시 버튼 노출', csPanel().textContent.includes('지금부터 다시'));
w.eval("foodMap.wx={lat:33.59,lng:130.4,src:'숙소',at:TODAY,days:[{d:TODAY,code:'비',tmax:28,tmin:23,pop:90}]};renderFoodMap();");
t('비 예보면 코스에 안내', csPanel().textContent.includes('강수확률 90%'));
w.eval("foodMap.wx.days[0].pop=10;renderFoodMap();");
t('맑으면 안내 없음', !csPanel().textContent.includes('강수확률'));

// 새 저장 키 없음 / 백업 포함
t('새 localStorage 키 없음', !html.includes("load('wx") && !html.includes("save('wx"));
w.eval("save('foodmap_v1',foodMap)");
let cap=null;
w.Blob=function(a){this.a=a;};
w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a[0]);return 'blob:x';};
w.eval('exportData()');
t('백업에 날씨 캐시 포함', cap.foodMap.wx&&Array.isArray(cap.foodMap.wx.days)&&cap.foodMap.wx.days.length>=1);

t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
