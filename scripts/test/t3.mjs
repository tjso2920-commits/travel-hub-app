// TARGET: personal
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const csv=fs.readFileSync('private/후쿠오카_137.csv','utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,600));
const FM=()=>w.eval('foodMap');
let fail=0,alerts=[];const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
w.alert=m=>alerts.push(m);
t('런타임 오류 0',errs.length===0);

// D-day 기본값
t('D-day 목표일 기본 2026-10-25', w.eval("(prof.target||'2026-10-25')")==='2026-10-25');
t('D-day 계산 동작', typeof w.eval('ddayTxt()')==='string' && w.eval('ddayTxt()').startsWith('D-'));
console.log('   현재 표시:', w.eval('ddayTxt()'));

w.fmMerge(w.fmCsv(csv));
const hotel=FM().places.find(p=>p.name.includes('리브맥스'));
t('CSV에 리브맥스 있음', !!hotel);

// 좌표 없을 때 거부
FM().selected=hotel.id;
w.eval('fmSetHotelFromSpot()');
t('좌표 없으면 거부', alerts.length===1 && alerts[0].includes('좌표가 없습니다'));
t('숙소 미설정 유지', !FM().hotel || !FM().hotel.lat);

// 좌표 채운 뒤 지정
hotel.lat=33.5885; hotel.lng=130.3960; hotel.address='福岡県福岡市中央区天神';
alerts=[];
w.eval('fmSetHotelFromSpot()');
t('숙소 이름 반영', FM().hotel.name.includes('리브맥스'));
t('숙소 좌표 반영', FM().hotel.lat===33.5885 && FM().hotel.lng===130.3960);
t('기준점 호텔로 전환', FM().originMode==='hotel');
t('저장됨', JSON.parse(w.localStorage.getItem('cp1_foodmap_v1')).hotel.lat===33.5885);
t('거리 계산 동작', typeof w.eval('fm2Distance(foodMap.places[1])')==='number' || w.eval('fm2Distance(foodMap.places[1])')===null);

console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
