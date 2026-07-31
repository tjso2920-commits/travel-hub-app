/**
 * 장소 상세 시트.
 * 목록에서 장소를 누르면 그 자리에서 시트가 뜨고, 거기서 지도 앱으로 넘어갈 수 있어야 한다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!/scrollTo|Not implemented/.test(e.message))errs.push(e.message);});
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const FM=()=>w.eval('foodMap');
const d=w.document;
let fail=0;const t=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c||x===undefined?'':' → '+JSON.stringify(x)));if(!c)fail++;};
w.alert=()=>{}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
let opened=null; w.open=(u)=>{opened=u;return null;};
t('런타임 오류 0',errs.length===0);

w.eval(`foodMap.places=[
  {id:'a',name:'우동 타이라',cat:'맛집·식당',kind:'우동·소바',region:'하카타',
   address:'福岡市博多区1-2-3',note:'가케우동 곱빼기',rating:4.3,ratingCount:812,
   lat:33.5902,lng:130.3986},
  {id:'b',name:'좌표 없는 집',cat:'카페·디저트',address:'',note:'',lat:null,lng:null}];
 foodMap.places.forEach(p=>{p.address=p.address||'';p.note=p.note||'';});
 foodMap.hotel={name:'호텔',lat:33.5880,lng:130.4000};
 foodMap.originMode='hotel';
 foodMap.filter='전체';foodMap.q='';foodMap.region='전체 지역';foodMap.kind='전체 음식·술';foodMap.status='기본 상태';
 renderFoodMap();`);

const sheet=()=>d.getElementById('spSheet');
const shown=()=>d.getElementById('ovSpot').classList.contains('show');

t('처음엔 시트가 닫혀 있음', !shown());

/* 목록에서 카드를 누르면 시트가 뜬다 */
const card=d.querySelector('#fmList .place');
t('목록 카드 존재', !!card);
w.eval("fmSelect('a')");
t('카드를 누르면 시트가 뜸', shown());
t('선택 상태도 갱신됨', FM().selected==='a');

const txt=()=>sheet().textContent;
t('이름 표시', txt().includes('우동 타이라'));
t('주소 표시', txt().includes('福岡市博多区1-2-3'));
t('메모 표시', txt().includes('가케우동 곱빼기'));
t('평점 표시', txt().includes('4.3')&&txt().includes('812'));
t('분류 표시', txt().includes('우동·소바'));
t('거리 표시', /\d/.test(txt().split('이름')[0]));

/* 지도 미리보기 */
const map=sheet().querySelector('.sp-map svg');
t('지도 미리보기 존재', !!map);
t('타일이 실림', map&&map.querySelectorAll('image').length>0, map&&map.querySelectorAll('image').length);
t('핀이 하나', map&&map.querySelectorAll('circle').length===1);
const vb=map.getAttribute('viewBox').split(' ').map(Number);
const pin=map.querySelector('circle');
t('핀이 지도 한가운데 근처',
  Math.abs(+pin.getAttribute('cx')-vb[2]/2)<12 && Math.abs(+pin.getAttribute('cy')-vb[3]/2)<12,
  [+pin.getAttribute('cx'),vb[2]/2]);

/* 지도 앱 고르기 */
t('지도에서 열기 버튼', !!sheet().querySelector('.sp-open'));
w.confirm=()=>true;  // 애플 지도
w.eval('fmSpotMaps()');
t('확인 = 애플 지도', /^https:\/\/maps\.apple\.com\//.test(opened||''), opened);
t('애플 링크에 좌표', String(opened).includes('33.5902,130.3986'));
w.confirm=()=>false; // 구글 지도
w.eval('fmSpotMaps()');
t('취소 = 구글 지도', /google\.com\/maps/.test(opened||''), opened);

/* 시트 안에서 바로 토글 */
t('즐겨찾기 꺼진 상태로 시작', !FM().places[0].fav);
w.eval("fmSpotQuick('fav')");
t('즐겨찾기 켜짐', FM().places[0].fav===true);
t('시트가 그대로 열려 있음', shown());
t('버튼 표시도 바뀜', sheet().querySelector('.sp-quick button').className.includes('on'));

w.eval("fmSpotQuick('visited')");
t('방문 표시됨', FM().places[0].visited===true);
t('방문 시각 기록', String(FM().places[0].visitedAt||'').startsWith(w.eval('TODAY')));
t('시트에 방문함 표시', txt().includes('방문함'));
w.eval("fmSpotQuick('visited')");
t('방문 해제 시 시각 삭제', FM().places[0].visitedAt==null);

/* 저장까지 갔는가 */
const ls=JSON.parse(w.localStorage.getItem(w.eval('PFX')+'foodmap_v1'));
t('localStorage 반영', ls.places.find(p=>p.id==='a').fav===true);

/* 좌표 없는 장소 */
w.eval("fmSpotOpen('b')");
t('좌표 없어도 시트는 뜸', shown()&&txt().includes('좌표 없는 집'));
t('좌표 없으면 안내 문구', txt().includes('좌표가 없어'));
t('좌표 없으면 지도 SVG 없음', !sheet().querySelector('.sp-map svg'));
w.confirm=()=>true;
w.eval('fmSpotMaps()');
t('좌표 없어도 이름으로 열림', String(opened).includes('maps.apple.com')&&String(opened).includes('q='));

/* 닫기 */
w.eval("closeOv('ovSpot')");
t('닫힘', !shown());

/* 없는 id 로 열어도 죽지 않는다 */
w.eval("fmSpotOpen('없는id')");
t('없는 장소는 무시', !shown()||sheet().innerHTML==='');

t('새 저장소 키 없음', !Object.keys(w.localStorage).some(k=>/spsheet|ovspot/i.test(k)));
t('최종 런타임 오류 0', errs.length===0, errs.slice(0,2));
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
