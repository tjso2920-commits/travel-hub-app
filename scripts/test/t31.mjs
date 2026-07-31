/**
 * 일본 밖으로 나가기.
 * 장소 조회·검색어·권역 판정이 일본으로 박혀 있었다. 목적지에서 끌어내야 한다.
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

const set=(dest,country)=>w.eval(`foodMap.dest=${JSON.stringify(dest)};foodMap.destCountry=${JSON.stringify(country||'')};`);

/* 도시 이름으로 나라를 짐작한다 */
const guess=(city)=>{set(city);return w.eval('fmCountry()');};
t('후쿠오카 → 일본', guess('후쿠오카')==='JP');
t('방콕 → 태국', guess('방콕')==='TH');
t('타이베이 → 대만', guess('타이베이')==='TW');
t('다낭 → 베트남', guess('다낭')==='VN');
t('파리 → 프랑스', guess('파리')==='FR');
t('제주 → 한국', guess('제주')==='KR');
t('모르는 도시는 일본으로', guess('어딘가시')==='JP', '기존 사용자 기준을 지킨다');

/* 사용자가 고른 나라가 짐작보다 우선한다 */
set('파리','TH');
t('직접 고른 나라가 우선', w.eval('fmCountry()')==='TH');
t('언어도 따라감', w.eval('fmPlaceLang()')==='th');
set('파리','');
t('비우면 다시 짐작', w.eval('fmCountry()')==='FR'&&w.eval('fmPlaceLang()')==='fr');
set('후쿠오카','ZZ');
t('없는 코드는 무시', w.eval('fmCountry()')==='JP');

/* 검색어 꼬리말이 목적지를 따라간다 */
set('방콕');
t('꼬리말이 목적지', w.eval('fmAreaHint()')==='방콕');
w.eval(`foodMap.places=[{id:'a',name:'솜땀 식당',cat:'맛집·식당',note:'',address:'',lat:null,lng:null}];
 foodMap.filter='전체';foodMap.q='';foodMap.region='전체 지역';foodMap.kind='전체 음식·술';foodMap.status='기본 상태';
 foodMap.selected='a';renderFoodMap();`);
const link=w.eval("fmDirectionsLink(foodMap.places[0])");
t('길찾기에 목적지가 붙음', decodeURIComponent(link).includes('솜땀 식당 방콕'), decodeURIComponent(link).slice(0,90));
t('길찾기에 일본이 안 붙음', !link.includes('%E7%A6%8F%E5%B2%A1'));
const yt=w.eval("(fmEnsureVideos(foodMap.places[0]),foodMap.places[0].videos[0].short)");
t('영상 검색어도 목적지', decodeURIComponent(yt).includes('방콕'), decodeURIComponent(yt).slice(-40));

/* 권역 칩 이름 */
t('칩 이름이 목적지를 따라감', w.eval("fmCatLabel('후쿠오카권')")==='방콕권');
t('다른 칩은 그대로', w.eval("fmCatLabel('즐겨찾기')")==='즐겨찾기');
t('저장값은 안 바뀜', w.eval("FM_CATS.includes('후쿠오카권')"), '기존 사용자 필터가 깨지면 안 된다');

/* 권역 판정 — 일본 밖에서는 기준점 60km */
set('방콕');
w.eval(`foodMap.hotel={name:'호텔',lat:13.7563,lng:100.5018};foodMap.originMode='hotel';`);
t('가까운 곳은 권역 안', w.eval("fmInArea({lat:13.74,lng:100.53,address:'',note:''})")===true);
t('먼 곳은 권역 밖', w.eval("fmInArea({lat:18.79,lng:98.99,address:'',note:''})")===false, '치앙마이는 700km');
t('주소에 도시명 있으면 인정', w.eval("fmInArea({lat:null,lng:null,address:'방콕 수쿰빗',note:''})")===true);

/* 일본은 기존 방식을 그대로 쓴다 — 쌓인 데이터 호환 */
set('후쿠오카');
t('일본은 좌표 범위 그대로', w.eval("fmInArea({lat:33.59,lng:130.40,address:'',note:''})")===true);
t('일본 밖 좌표는 제외', w.eval("fmInArea({lat:13.75,lng:100.50,address:'',note:''})")===false);

/* 첫 화면에서 나라를 고를 수 있는가 */
w.eval("foodMap.places=[];renderFoodMap();");
const sel=d.querySelector('#fmCollect select');
t('첫 화면에 나라 고르는 칸', !!sel&&sel.options.length>=15, sel&&sel.options.length);
t('현재 나라가 선택돼 있음', sel&&sel.value===w.eval('fmCountry()'));

t('저장소 키는 foodmap 하나', !Object.keys(w.localStorage).some(k=>/country|region/i.test(k)));
t('최종 런타임 오류 0', errs.length===0, errs.slice(0,2));
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
