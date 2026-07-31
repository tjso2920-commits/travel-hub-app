import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const csv=fs.readFileSync('private/후쿠오카_137.csv','utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,600));
const FM=()=>w.eval('foodMap');
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
w.alert=()=>{};
t('런타임 오류 0',errs.length===0);

/* 무료판 장소 한도는 t33 에서 따로 본다. 여기서는 137곳 전부가 필요하다. */
w.eval("foodMap.lic={name:'검사',date:'2026-01-01'};");
w.fmMerge(w.fmCsv(csv));
// 좌표 부여 (보강 완료 상태 재현)
FM().places.forEach((p,i)=>{p.lat=33.58+i*0.0007;p.lng=130.39+i*0.0007;});
const hotel=FM().places.find(p=>p.name.includes('리브맥스'));
FM().selected=hotel.id; w.eval('fmSetHotelFromSpot()');
t('숙소=리브맥스', FM().hotel.name.includes('리브맥스'));

const near=FM().places[1], far=FM().places[120];
t('가까운 곳 거리 계산됨', w.eval('fm2DistTxt(foodMap.places[1])').length>0);
const e1=w.eval('JSON.stringify(fm2Eta(foodMap.places[1]))'), e2=w.eval('JSON.stringify(fm2Eta(foodMap.places[120]))');
console.log('   가까운 곳:',w.eval('fm2DistTxt(foodMap.places[1])'), e1);
console.log('   먼 곳    :',w.eval('fm2DistTxt(foodMap.places[120])'), e2);
const a=JSON.parse(e1), b=JSON.parse(e2);
t('도보 시간 정수·1분 이상', Number.isInteger(a.walk)&&a.walk>=1);
t('자전거가 도보보다 빠름', a.bike<a.walk && b.bike<b.walk);
t('먼 곳이 더 오래 걸림', b.walk>a.walk);
t('좌표 없으면 빈 문자열', w.eval("fm2EtaTxt({lat:null,lng:null})")==='');

// 길찾기 링크
const lw=w.eval("fmDirectionsLink(foodMap.places[1],'walking')");
const lt=w.eval("fmDirectionsLink(foodMap.places[1],'transit')");
const lb=w.eval("fmDirectionsLink(foodMap.places[1],'bicycling')");
const ld=w.eval("fmDirectionsLink(foodMap.places[1])");
t('도보 링크', lw.includes('travelmode=walking'));
t('대중교통 링크', lt.includes('travelmode=transit'));
t('자전거 링크', lb.includes('travelmode=bicycling'));
t('인자 없으면 기존대로 도보', ld.includes('travelmode=walking'));
t('출발지=숙소 좌표', lw.includes('origin=')&&decodeURIComponent(lw).includes(String(FM().hotel.lat)));
t('목적지 좌표', decodeURIComponent(lw).includes(String(near.lat)));
t('API 키 안 들어감', !/key=|X-Goog/.test(lw));

// 렌더 실행 (문법 오류·예외 없는지)
w.eval('foodMap.originMode="hotel";renderFoodMap();');
const listHtml=w.document.getElementById('fmList').innerHTML;
t('목록 렌더됨', listHtml.length>500);
t('목록에 추정 시간 배지', listHtml.includes('도보')&&listHtml.includes('자전거'));
w.eval('fmRenderSpotTools()');
const spot=w.document.getElementById('fmSpotTools').innerHTML;
t('스팟카드 이동수단 3종', spot.includes('도보')&&spot.includes('대중교통')&&spot.includes('자전거'));
t('스팟카드 안내문구', spot.includes('직선거리 기준 추정'));
t('렌더 후 런타임 오류 0', errs.length===0);

console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
