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
w.eval('fxAutoTried=true');  // 환율 자동 갱신이 호출 수를 흐리지 않게 막는다
w.alert=()=>{}; w.confirm=()=>true;
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

// 2026-07-29 = 수요일(3)
const HOURS={weekdayDescriptions:['월요일: 오전 11:00~오후 10:00','화요일: 오전 11:00~오후 10:00','수요일: 휴무일','목요일: 오후 5:00~오전 2:00','금요일: 오후 5:00~오전 2:00','토요일: 오후 5:00~오전 2:00','일요일: 휴무일'],
 periods:[{open:{day:1,hour:11,minute:0},close:{day:1,hour:22,minute:0}},
          {open:{day:2,hour:11,minute:0},close:{day:2,hour:22,minute:0}},
          {open:{day:4,hour:17,minute:0},close:{day:5,hour:2,minute:0}},
          {open:{day:5,hour:17,minute:0},close:{day:6,hour:2,minute:0}},
          {open:{day:6,hour:17,minute:0},close:{day:0,hour:2,minute:0}}]};
w.eval('window.__h='+JSON.stringify(HOURS));
const p0=w.eval('(function(){const p={name:"T"};fmStoreHours(p,{regularOpeningHours:window.__h,currentOpeningHours:{openNow:false}});return JSON.stringify(p);})()');
const P=JSON.parse(p0);
t('영업시간 저장', P.hours && P.hours.periods.length===5);
t('openNow 반영', P.openNow===false);
t('구글 휴무일 추출 = 수·일', JSON.stringify(w.eval('fmHoursClosedDays('+p0+')'))==='[0,3]');
t('오늘(수) 설명줄', w.eval('fmHoursTodayTxt('+p0+',"2026-07-29")').includes('휴무일'));
t('목요일 설명줄', w.eval('fmHoursTodayTxt('+p0+',"2026-07-30")').includes('오후 5:00'));
t('수요일 19시 닫힘', w.eval('fmOpenAt('+p0+',"2026-07-29",19)')===false);
t('목요일 19시 열림', w.eval('fmOpenAt('+p0+',"2026-07-30",19)')===true);
t('금요일 새벽 1시 = 목요일 심야 영업', w.eval('fmOpenAt('+p0+',"2026-07-31",1)')===true);
t('월요일 12시 열림', w.eval('fmOpenAt('+p0+',"2026-08-03",12)')===true);
t('월요일 23시 닫힘', w.eval('fmOpenAt('+p0+',"2026-08-03",23)')===false);
t('영업시간 없으면 null', w.eval('fmOpenAt({name:"x"},"2026-07-29",19)')===null);

// 구글 > 메모 우선
const both=JSON.stringify(Object.assign(JSON.parse(p0),{note:'월요일 휴무'}));
t('구글 데이터가 메모보다 우선', JSON.stringify(w.eval('fmClosedDays('+both+')'))==='[0,3]');
t('출처 표기 구글', w.eval('fmHoursSrc('+both+')')==='구글');
t('출처 표기 메모', w.eval("fmHoursSrc({note:'월요일 휴무'})")==='메모');

// 일괄 조회
w.fmMerge(w.fmCsv(csv));
FM().places.forEach((p,i)=>{p.lat=33.59+i*0.0004;p.lng=130.40+i*0.0004;p.placeId='PL'+i;});
FM().apiKey='TESTKEY';
/* 앱이 부팅 시 렌더하므로 #fmApiKey 입력칸이 이미 존재한다.
   fmEnrichAll 은 내부에서 fmSaveApi 로 그 입력칸 값을 다시 읽으므로,
   객체에만 키를 넣으면 빈 입력칸 값으로 덮여 호출이 0건이 된다. 입력칸도 함께 채운다. */
w.eval('renderFoodMap()');
{const k=w.document.getElementById('fmApiKey');if(k)k.value='TESTKEY';}
t('영업시간 없는 곳 137', w.eval('fmNoHoursCount()')===137);
let calls=0,urls=[],masks=[];
w.fetch=async(url,opt)=>{calls++;urls.push(url);masks.push(opt.headers['X-Goog-FieldMask']);
 if(calls===3)return{ok:true,json:async()=>({id:'PL2'})};
 return{ok:true,json:async()=>({id:'PL'+calls,regularOpeningHours:HOURS,currentOpeningHours:{openNow:true},businessStatus:'OPERATIONAL'})};};
FM().places=FM().places.slice(0,4);
await w.eval('fmFillHours()');
await new Promise(r=>setTimeout(r,400));
t('4건 조회', calls===4);
t('Place Details 경로 사용', urls[0].includes('/v1/places/PL0'));
t('영업시간 필드마스크', masks[0].includes('regularOpeningHours'));
t('성공 3건 저장', FM().places.filter(p=>w.eval('fmHasHours')(p)).length===3);
t('영업시간 없는 응답은 실패 처리', w.eval('fmBulk.fail.length')===1);
t('남은 개수 갱신', w.eval('fmNoHoursCount()')===1);
t('결과 표시', w.document.getElementById('fmBulkOut').innerHTML.includes('영업시간'));

// 좌표 보강도 영업시간 같이 받는지
t('좌표 보강 필드마스크에 영업시간', html.includes('places.regularOpeningHours,places.currentOpeningHours'));

// 컨텍스트
FM().selected=FM().places[0].id;
w.eval('fmSetHotelFromSpot();renderFoodMap();');
const ctx=w.eval('asContext()');
t('컨텍스트에 오늘 영업시간', ctx.includes('오늘 '));
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
