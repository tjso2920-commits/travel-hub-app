/**
 * 장소 사진.
 * 참고 앱은 장소를 누르면 가게 사진이 뜬다. 그건 유료 API 사진이고,
 * 여기서는 사용자가 자기 사진을 붙인다. 저장 공간이 작으므로 줄여 넣고,
 * 저장이 실패하면 되돌려야 한다 — 저장된 줄 알고 넘어가면 안 된다.
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
w.alert=m=>{w.__alert=m;}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
t('런타임 오류 0',errs.length===0);

w.eval(`foodMap.places=[
 {id:'a',name:'우동 타이라',cat:'맛집·식당',lat:33.5902,lng:130.3986,note:'',address:''},
 {id:'b',name:'커피 카운티',cat:'카페·디저트',lat:33.5931,lng:130.4014,note:'',address:''}];
 foodMap.filter='전체';foodMap.q='';foodMap.region='전체 지역';foodMap.kind='전체 음식·술';foodMap.status='기본 상태';
 renderFoodMap();fmSpotOpen('a');`);
const sheet=()=>d.getElementById('spSheet');

t('사진 없으면 추가 버튼', !!sheet().querySelector('.sp-addphoto'));
t('사진 없으면 사진 영역 없음', !sheet().querySelector('.sp-photo'));

/* save() 가 실패를 알려주는가 — 사진은 이 값에 기대어 되돌린다 */
t('save 가 성공을 알림', w.eval("save('__t',{a:1})")===true);
w.eval("delete localStorage[PFX+'__t']");

/* 사진을 직접 넣어 화면을 확인한다 (캔버스는 jsdom 에 없다) */
const tiny='data:image/jpeg;base64,/9j/4AAQSkZJRg==';
w.eval(`foodMap.places[0].photo=${JSON.stringify(tiny)};fmSpotRender();fmRenderList();`);
t('시트에 사진 표시', !!sheet().querySelector('.sp-photo img'));
t('사진이 지도보다 앞', (()=>{const h=sheet().innerHTML;
  return h.indexOf('sp-photo')>=0 && (h.indexOf('sp-map')<0 || h.indexOf('sp-photo')<h.indexOf('sp-map'));})());
t('사진 있으면 추가 버튼 없음', !sheet().querySelector('.sp-addphoto'));
t('사진 지우기 버튼', !!sheet().querySelector('.sp-photo button'));
t('목록 카드에 썸네일', !!d.querySelector('#fmList .place-thumb'));
t('사진 없는 카드엔 썸네일 없음', d.querySelectorAll('#fmList .place-thumb').length===1);

/* 선택 모드에서는 썸네일을 안 그린다 — 체크박스와 겹친다 */
w.eval('fmSelMode(true)');
t('선택 모드엔 썸네일 없음', !d.querySelector('#fmList .place-thumb'));
w.eval('fmSelMode(false)');

/* 삭제 */
w.confirm=()=>false;
w.eval('fmSpotOpen("a");fmSpotPhotoDel()');
t('확인 취소하면 안 지워짐', !!FM().places[0].photo);
w.confirm=()=>true;
w.eval('fmSpotPhotoDel()');
t('사진 지워짐', FM().places[0].photo===undefined);
t('지운 뒤 추가 버튼 복귀', !!sheet().querySelector('.sp-addphoto'));
t('저장에 반영', JSON.parse(w.localStorage.getItem(w.eval('PFX')+'foodmap_v1')).places[0].photo===undefined);

/* 판매용 스팟팩에는 사진이 안 들어간다 — 개인 사진이고 저작권도 걸린다 */
w.eval(`foodMap.places[0].photo=${JSON.stringify(tiny)};`);
let dl=null; w.fm2Download=(n,o)=>{dl=o;};
w.eval('fmExportSale()');
t('스팟팩에 사진 없음', dl&&dl.spots.every(x=>x.photo===undefined), dl&&Object.keys(dl.spots[0]));

/* 개인 백업에는 들어간다 — 내 데이터다 */
dl=null; w.eval('fmExport()');
t('개인 백업엔 사진 포함', !!(dl&&JSON.stringify(dl).includes('/9j/4AAQ')));

t('새 저장소 키 없음', !Object.keys(w.localStorage).some(k=>/photo/i.test(k)));
t('최종 런타임 오류 0', errs.length===0, errs.slice(0,2));
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
