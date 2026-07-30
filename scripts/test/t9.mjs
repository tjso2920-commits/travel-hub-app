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
let alerts=[]; w.alert=m=>alerts.push(m); w.confirm=()=>true;
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

w.fmMerge(w.fmCsv(csv));
const CATS=['맛집·식당','바·이자카야','카페·디저트','관광·명소','쇼핑','사우나·온천'];
FM().places.forEach((p,i)=>{
  const h=[[33.5902,130.3986],[33.5895,130.4200],[33.5790,130.3960]][i%3];
  p.lat=h[0]+((i%17)-8)*0.0006;p.lng=h[1]+((i%13)-6)*0.0006;
  p.cat=CATS[i%CATS.length];p.visited=false;p.excluded=false;p.openNow=null;p.priority=i%4===0?2:0;
});
FM().selected=FM().places[0].id; w.eval('fmSetHotelFromSpot();bgSetTotal(80000);bgSetDays(4);');
w.eval("foodMap.courseGoals=['식사','술','카페'];foodMap.courseMax=4;foodMap.courseStart=18;renderFoodMap();");
t('코스 카드 렌더', w.document.body.innerHTML.includes('오늘 동선'));

w.eval('csBuild()');
let c=JSON.parse(w.eval('JSON.stringify(foodMap.course)'));
console.log('--- 코스 ---');
c.stops.forEach((s,i)=>console.log(`  ${i+1}. ${String(Math.floor(s.at/60)%24).padStart(2,'0')}:${String(s.at%60).padStart(2,'0')} ${s.name} (${s.goal}) 도보${s.walk}분 체류${s.dwell}분`));
console.log('   종료',c.endAt,'총도보',c.walkTotal);
t('코스 생성됨', c && c.stops.length>0);
t('최대 곳 수 준수', c.stops.length<=4);
t('시작 시각 반영', Math.floor(c.stops[0].at/60)>=18);
t('시간 단조 증가', c.stops.every((s,i)=>i===0||s.at>c.stops[i-1].at));
t('중복 장소 없음', new Set(c.stops.map(s=>s.id)).size===c.stops.length);
t('목적이 선택한 것들 안에', c.stops.every(s=>['식사','술','카페'].includes(s.goal)));
t('총 도보 = 구간 합', c.walkTotal===c.stops.reduce((a,s)=>a+s.walk,0));

// 순서 최적화가 실제로 거리를 줄이는가
const optD=w.eval(`(function(){const o=fmOrigin(),a=csPlaces();let s=fmGpsDistance(o,a[0]);for(let i=0;i<a.length-1;i++)s+=fmGpsDistance(a[i],a[i+1]);return Math.round(s);})()`);
const revD=w.eval(`(function(){const o=fmOrigin(),a=csPlaces().slice().reverse();let s=fmGpsDistance(o,a[0]);for(let i=0;i<a.length-1;i++)s+=fmGpsDistance(a[i],a[i+1]);return Math.round(s);})()`);
console.log('   최적화 경로',optD,'m / 역순',revD,'m');
t('최적화 경로가 역순보다 짧거나 같음', optD<=revD);

// 구글맵 링크
const link=w.eval('fmRouteLink(csPlaces())');
t('코스 링크 waypoints 포함', link.includes('waypoints=')||c.stops.length===1);
t('코스 링크 출발지 포함', link.includes('origin='));
t('코스 링크에 키 없음', !/key=|AIza/.test(link));

// 방문한 곳은 제외
FM().places.forEach((p,i)=>{if(i%2===0)p.visited=true;});
w.eval('csBuild()');
c=JSON.parse(w.eval('JSON.stringify(foodMap.course)'));
t('방문한 곳 제외', c.stops.every(s=>!FM().places.find(p=>p.id===s.id).visited));

// 구역 선택 시 그 구역 안에서만
FM().places.forEach(p=>{p.visited=false;});
const cl=JSON.parse(w.eval('JSON.stringify(fm2Clusters()[0].id)'));
w.eval("fm2SetCluster('"+cl+"');csBuild()");
const set=new Set(JSON.parse(w.eval('JSON.stringify([...fm2ClusterSet()])')));
c=JSON.parse(w.eval('JSON.stringify(foodMap.course)'));
t('구역 안에서만 선정', c.stops.every(s=>set.has(s.id)));
w.eval('fm2SetCluster(null)');

// 후보 없을 때
alerts=[];
w.eval("foodMap.places.forEach(p=>p.excluded=true);csBuild()");
t('후보 없으면 안내', alerts.length===1 && alerts[0].includes('조건에 맞는 장소가 없습니다'));
t('후보 없으면 코스 비움', w.eval('foodMap.course')===null);
w.eval("foodMap.places.forEach(p=>p.excluded=false);foodMap.courseStart=18;csBuild()");

// 어시스턴트 컨텍스트
const ctx=w.eval('asContext()');
t('컨텍스트에 코스', ctx.includes('[짜여 있는 오늘 동선]')&&ctx.includes('→'));
console.log('  ', ctx.split('\n').find(l=>l.includes('오늘 동선'))?.slice(0,110));

// 백업
let cap=null; w.Blob=function(a){this.a=a;}; w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a[0]);return 'blob:x';};
w.eval('exportData()');
t('백업에 코스 포함', cap.foodMap.course && cap.foodMap.course.stops.length>0);
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
