/**
 * 실제 지도 타일.
 * 이 환경은 프록시가 tile.openstreetmap.org 를 막아 타일 이미지를 볼 수 없다.
 * 그래서 "그림이 예쁜가"가 아니라 **좌표 계산이 맞는가**를 검사한다.
 * 투영이 맞으면 핀은 지도 위 제자리에 찍힌다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!/scrollTo|Not implemented/.test(e.message))errs.push(e.message);});
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const d=w.document;
let fail=0;const t=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c||x===undefined?'':' → '+JSON.stringify(x)));if(!c)fail++;};
w.alert=()=>{}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
t('런타임 오류 0',errs.length===0);

/* ── 웹 메르카토르가 맞는가 ─────────────────────────────────────────────── */
const merc=(lat,lng,z)=>w.eval(`fmMercator(${lat},${lng},${z})`);
const Z=15,N=256*Math.pow(2,Z);

t('경도 0 = 세계 가로 중앙', Math.abs(merc(0,0,Z).x-N/2)<1e-6);
t('위도 0 = 세계 세로 중앙', Math.abs(merc(0,0,Z).y-N/2)<1e-6);
t('경도 180 = 오른쪽 끝', Math.abs(merc(0,180,Z).x-N)<1e-6);
t('경도 -180 = 왼쪽 끝', Math.abs(merc(0,-180,Z).x)<1e-6);
t('북쪽이 위', merc(35,130,Z).y < merc(33,130,Z).y);
t('동쪽이 오른쪽', merc(33,131,Z).x > merc(33,130,Z).x);

/* 왕복 변환 — 픽셀에서 경도를 되돌렸을 때 원래 값이 나와야 한다 */
const back=(x)=>x/N*360-180;
t('경도 왕복 일치', Math.abs(back(merc(33.5931,130.4014,Z).x)-130.4014)<1e-9);

/* 줌이 1 올라가면 세계가 2배 */
t('줌 +1 = 좌표 2배', Math.abs(merc(33.6,130.4,Z+1).x - merc(33.6,130.4,Z).x*2)<1e-6);

/* 앱의 계산이 표준 웹 메르카토르 식과 같은지 — 검사에서 독립으로 계산해 맞춘다 */
const ref=(lat,lng,z)=>{const n=256*Math.pow(2,z),s=Math.sin(lat*Math.PI/180);
  return {x:(lng+180)/360*n, y:(.5-Math.log((1+s)/(1-s))/(4*Math.PI))*n};};
const cases=[[33.5902,130.4207,14],[35.6812,139.7671,16],[-33.8688,151.2093,12],[51.5074,-0.1278,10]];
t('표준 식과 일치', cases.every(([la,ln,z])=>{
  const a=merc(la,ln,z),b2=ref(la,ln,z);
  return Math.abs(a.x-b2.x)<1e-6&&Math.abs(a.y-b2.y)<1e-6;}));
t('남반구·서경도 좌표도 화면 안', cases.every(([la,ln,z])=>{
  const a=merc(la,ln,z),n=256*Math.pow(2,z);
  return a.x>=0&&a.x<=n&&a.y>=0&&a.y<=n;}));

/* ── 줌 고르기 ─────────────────────────────────────────────────────────── */
const fit=(b,W,H)=>w.eval(`fmFitZoom(${JSON.stringify(b)},${W},${H})`);
const wide={minLat:33.0,maxLat:34.2,minLng:130.0,maxLng:131.2};
const tight={minLat:33.590,maxLat:33.596,minLng:130.400,maxLng:130.408};
t('넓은 범위는 낮은 줌', fit(wide,860,600) < fit(tight,860,600), [fit(wide,860,600),fit(tight,860,600)]);
t('줌이 상한 안', fit(tight,860,600)<=17 && fit(wide,860,600)>=3);
/* 고른 줌에서 범위가 실제로 화면 안에 들어와야 한다 */
const zz=fit(wide,860,600);
const a=merc(wide.maxLat,wide.minLng,zz),c=merc(wide.minLat,wide.maxLng,zz);
t('고른 줌에서 범위가 화면 안', (c.x-a.x)<=860 && (c.y-a.y)<=600, [c.x-a.x,c.y-a.y]);

/* ── 타일 레이어 ───────────────────────────────────────────────────────── */
const L=w.eval(`(()=>{const L=fmTileLayer(${JSON.stringify(tight)},860,600);
 return {z:L.z,W:L.W,H:L.H,n:(L.tiles.match(/<image/g)||[]).length,
  first:(L.tiles.match(/href="([^"]+)"/)||[])[1]};})()`);
t('타일이 생성됨', L.n>0 && L.n<60, L.n);
t('타일 주소가 OSM 형식', /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(L.first||''), L.first);
t('타일 줌이 고른 줌과 같음', String(L.first).split('/')[3]===String(L.z), [L.first,L.z]);
t('뷰박스가 양수', L.W>0&&L.H>0);
t('API 키를 요구하지 않음', !/key=|token|apikey/i.test(L.first||''));

/* ── 실제 화면 ─────────────────────────────────────────────────────────── */
w.eval(`foodMap.places=[
  {id:'a',name:'하카타역',cat:'맛집·식당',lat:33.5902,lng:130.4207,region:'하카타'},
  {id:'b',name:'텐진',cat:'카페·디저트',lat:33.5914,lng:130.3986,region:'텐진'},
  {id:'c',name:'나카스',cat:'바·이자카야',lat:33.5930,lng:130.4050,region:'나카스'}];
 foodMap.places.forEach(p=>{p.note='';p.address='';});
 foodMap.hotel={name:'호텔',lat:33.5900,lng:130.4000};
 foodMap.filter='전체';foodMap.q='';foodMap.region='전체 지역';foodMap.kind='전체 음식·술';foodMap.status='기본 상태';
 renderFoodMap();`);
const svg=d.querySelector('#fmOverview svg');
t('지도 SVG 존재', !!svg);
t('타일 이미지가 실림', svg.querySelectorAll('image').length>0, svg&&svg.querySelectorAll('image').length);
t('장소 핀 3개', svg.querySelectorAll('circle').length>=3);
t('저작자 표시', d.getElementById('fmOverview').textContent.includes('OpenStreetMap'));

/* 핀이 뷰박스 안에 들어와야 한다 — 밖으로 나가면 안 보인다 */
const vb=svg.getAttribute('viewBox').split(' ').map(Number);
const inside=[...svg.querySelectorAll('circle')].every(el=>{
  const x=+el.getAttribute('cx'),y=+el.getAttribute('cy');
  return x>=0&&x<=vb[2]&&y>=0&&y<=vb[3];});
t('모든 핀이 화면 안', inside);

/* 동선을 만들면 번호가 붙는다 */
w.eval(`csApply([
  {p:foodMap.places[0],why:'첫 집'},
  {p:foodMap.places[1],why:'둘째'},
  {p:foodMap.places[2],why:'셋째'}],11,'검사용 코스');`);
const svg2=d.querySelector('#fmOverview svg');
const nums=[...svg2.querySelectorAll('text')].map(x=>x.textContent).filter(x=>/^\d+$/.test(x));
t('동선 번호 3개', nums.length===3, nums);
t('번호가 1부터 순서대로', nums.join(',')==='1,2,3', nums);
t('동선 선이 그려짐', svg2.querySelectorAll('polyline').length>0);
t('선이 정거장 수만큼 점을 지남',
  (svg2.querySelector('polyline').getAttribute('points').trim().split(/\s+/).length)===3);

/* 좌표 없는 장소만 있으면 지도를 그리지 않는다 */
w.eval(`foodMap.places.forEach(p=>{p.lat=null;p.lng=null;});renderFoodMap();`);
t('좌표 없으면 안내만', !d.querySelector('#fmOverview svg')&&
  d.getElementById('fmOverview').textContent.includes('2곳 이상'));

t('새 저장소 키 없음', !Object.keys(w.localStorage).some(k=>/tile|merc/i.test(k)));
t('최종 런타임 오류 0', errs.length===0, errs.slice(0,2));
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
