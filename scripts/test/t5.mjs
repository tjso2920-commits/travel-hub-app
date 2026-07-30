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
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
w.alert=()=>{};
t('런타임 오류 0',errs.length===0);

w.fmMerge(w.fmCsv(csv));
// 3개 동네에 뭉치도록 좌표 배치 (텐진/하카타/야쿠인 근사)
const hubs=[[33.5902,130.3986],[33.5895,130.4200],[33.5790,130.3960]];
FM().places.forEach((p,i)=>{const h=hubs[i%3];p.lat=h[0]+((i%17)-8)*0.0004;p.lng=h[1]+((i%13)-6)*0.0004;});
w.eval('foodMap.clusterR=700;foodMap.cluster=null;renderFoodMap();');

const cl=JSON.parse(w.eval('JSON.stringify(fm2Clusters().map(c=>({n:c.name,c:c.members.length})))'));
console.log('   구역:',cl.slice(0,6).map(c=>c.n+'='+c.c).join(' / '));
t('구역이 생성됨', cl.length>=3);
t('모든 장소가 어느 구역엔가 속함', cl.reduce((s,c)=>s+c.c,0)===137);
t('큰 구역 우선 정렬', cl[0].c>=cl[cl.length-1].c);

const ov=w.document.getElementById('fmOverview').innerHTML;
t('개요 지도 렌더됨', ov.includes('<svg')&&ov.includes('<circle'));
const dots=(ov.match(/<circle/g)||[]).length;
console.log('   점 개수:',dots);
t('점 137개 이상 그려짐', dots>=137);
t('구역 칩 표시', ov.includes('전체 137'));

// 구역 선택 → 목록 필터 연동
const firstId=JSON.parse(w.eval('JSON.stringify(fm2Clusters()[0].id)'));
const firstCnt=cl[0].c;
w.eval("fm2SetCluster('"+firstId+"')");
t('구역 선택 저장', FM().cluster===firstId);
t('목록이 구역으로 좁혀짐', w.eval('fmFiltered().length')===firstCnt);
const list=w.document.getElementById('fmList').innerHTML;
t('목록 카운트 반영', list.includes('조건 결과 '+firstCnt));
// 토글 해제
w.eval("fm2SetCluster('"+firstId+"')");
t('같은 칩 다시 누르면 해제', FM().cluster===null && w.eval('fmFiltered().length')===137);

// 반경 변경
w.eval('fm2SetClusterR(1500)');
const cl2=JSON.parse(w.eval('JSON.stringify(fm2Clusters().map(c=>c.members.length))'));
t('반경 늘리면 구역 수 감소', cl2.length<=cl.length);
t('반경 저장됨', FM().clusterR===1500);
w.eval('fm2SetClusterR(700)');

// 숙소 마커
const hotel=FM().places.find(p=>p.name.includes('리브맥스'));
FM().selected=hotel.id; w.eval('fmSetHotelFromSpot();renderFoodMap();');
t('숙소 마커 표시', w.document.getElementById('fmOverview').innerHTML.includes('숙소'));

// 좌표 없는 장소 섞였을 때
FM().places[5].lat=null; FM().places[5].lng=null;
w.eval('renderFoodMap()');
const ov2=w.document.getElementById('fmOverview').innerHTML;
t('좌표 없음 안내', ov2.includes('좌표 없음'));
t('좌표 없어도 렌더 유지', ov2.includes('<svg'));

// 저장 키 확인
const saved=JSON.parse(w.localStorage.getItem('cp1_foodmap_v1'));
t('새 저장 키 없음(foodmap 내부 필드만)', 'cluster' in saved && 'clusterR' in saved);
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
