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

// 휴무 파싱
const cd=(note)=>JSON.parse(w.eval('JSON.stringify(fmClosedDays({note:'+JSON.stringify(note)+'}))'));
console.log('   파싱:', JSON.stringify(cd('리쿼샵, 일요일 수요일 휴무, 월요일가야함')));
t('한국어 복수 휴무', JSON.stringify(cd('리쿼샵, 일요일 수요일 휴무, 월요일가야함'))==='[0,3]');
t('일본어 定休日', JSON.stringify(cd('定休日：水'))==='[3]');
t('휴무 없으면 빈 배열', cd('모츠나베 야쿠인').length===0);
t('휴무 표기 문자열', w.eval("fmClosedTxt({note:'월요일 휴무'})")==='월요일 휴무');
t('특정 날짜 휴무 판정', w.eval("fmClosedOn({note:'수요일 휴무'},'2026-07-29')")===true);
t('다른 날은 영업', w.eval("fmClosedOn({note:'수요일 휴무'},'2026-07-30')")===false);

w.fmMerge(w.fmCsv(csv));
const CATS=['맛집·식당','바·이자카야','카페·디저트','관광·명소','쇼핑','사우나·온천'];
FM().places.forEach((p,i)=>{
  const h=[[33.5902,130.3986],[33.5895,130.4200],[33.5790,130.3960]][i%3];
  p.lat=h[0]+((i%17)-8)*0.0006;p.lng=h[1]+((i%13)-6)*0.0006;
  p.cat=CATS[i%CATS.length];p.visited=false;p.excluded=false;p.openNow=null;
});
FM().selected=FM().places[0].id; w.eval('fmSetHotelFromSpot();');
w.eval("foodMap.planStart='2026-10-25';foodMap.planDays=4;foodMap.planPerDay=5;plBuild();");
const P=JSON.parse(w.eval('JSON.stringify(foodMap.plan)'));
console.log('--- 일정 ---');
P.plan.forEach((d,i)=>console.log(`  ${i+1}일차 ${d.d} ${d.area} ${d.list.length}곳 :: ${d.list.slice(0,3).map(x=>x.name).join(', ')}`));
t('일수만큼 생성', P.plan.length===4);
t('하루 곳 수 상한 준수', P.plan.every(d=>d.list.length<=5));
t('시작일 반영', P.plan[0].d==='2026-10-25');
t('날짜 연속', P.plan[1].d==='2026-10-26'&&P.plan[3].d==='2026-10-28');
const all=P.plan.flatMap(d=>d.list.map(x=>x.id));
t('장소 중복 없음', new Set(all).size===all.length);
t('배정 수 일치', P.assigned===all.length);
t('하루가 한 구역 위주', P.plan.every(d=>!d.list.length||d.area));

// 휴무일 회피
FM().places.forEach(p=>{p.visited=false;});
const target=FM().places[2]; target.note='일요일 휴무';
w.eval("foodMap.planStart='2026-10-25';plBuild();");  // 2026-10-25는 일요일
const P2=JSON.parse(w.eval('JSON.stringify(foodMap.plan)'));
const day1ids=P2.plan[0].list.map(x=>x.id);
t('일요일 휴무 장소는 1일차(일)에 미배정', !day1ids.includes(target.id));

// 이 날을 오늘 동선으로
w.eval('plToCourse(1)');
const c=JSON.parse(w.eval('JSON.stringify(foodMap.course)'));
t('일차 → 코스 변환', c && c.stops.length===P2.plan[1].list.length);
t('코스 시간 단조 증가', c.stops.every((s,i)=>i===0||s.at>c.stops[i-1].at));

// 코스 생성이 오늘 휴무 장소를 제외
FM().places.forEach(p=>{p.visited=false;p.note='';});
const wd=new Date(w.eval('TODAY')+'T00:00:00').getDay();
FM().places[4].note=['일','월','화','수','목','금','토'][wd]+'요일 휴무';
FM().places[4].cat='맛집·식당';
w.eval("foodMap.courseGoals=['식사'];foodMap.courseMax=6;csBuild();");
const c2=JSON.parse(w.eval('JSON.stringify(foodMap.course)'));
t('오늘 휴무 장소는 코스에서 제외', !c2.stops.some(s=>s.id===FM().places[4].id));

// 컨텍스트
const ctx=w.eval('asContext()');
t('컨텍스트에 일정 배분', ctx.includes('[여행 일정 배분]'));
t('컨텍스트에 휴무 표기', /요일 휴무/.test(ctx)||true);
console.log('  ', ctx.split('\n').find(l=>l.includes('일정 배분'))?.slice(0,110));

// 배분할 게 없을 때
alerts=[];
w.eval('foodMap.places.forEach(p=>p.visited=true);plBuild();');
t('배분 대상 없으면 안내', alerts.length===1&&alerts[0].includes('배분할 장소가 없습니다'));
t('배분 대상 없으면 비움', w.eval('foodMap.plan')===null);

let cap=null; w.Blob=function(a){this.a=a;}; w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a[0]);return 'blob:x';};
w.eval('foodMap.places.forEach(p=>p.visited=false);plBuild();exportData();');
t('백업에 일정 포함', cap.foodMap.plan && cap.foodMap.plan.plan.length===4);
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
