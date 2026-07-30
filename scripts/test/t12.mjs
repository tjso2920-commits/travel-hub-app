import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const FM=()=>w.eval('foodMap');
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
w.alert=()=>{}; w.confirm=()=>true;
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

const tags=(p)=>JSON.parse(w.eval('JSON.stringify(sjTags('+JSON.stringify(p)+'))'));
const pick=(p,n)=>JSON.parse(w.eval('JSON.stringify(sjPick('+JSON.stringify(p)+','+(n||12)+'))'));

const liquor={name:'본웨스턴',cat:'쇼핑',kind:'쇼추',note:'리쿼샵, 일요일 수요일 휴무'};
const izakaya={name:'이와세 쿠시텐',cat:'바·이자카야',kind:'이자카야',note:'타치노미, 현금만'};
const sushi={name:'스시 산카쿠',cat:'맛집·식당',kind:'스시·사시미',note:''};
const ramen={name:'잇푸도 라멘',cat:'맛집·식당',kind:'라멘',note:''};
const nomi={name:'기세테바',cat:'바·이자카야',kind:'이자카야',note:'노미호다이 90분',reservation:'needed'};
const sauna={name:'웰비 후쿠오카',cat:'사우나·온천',kind:'기타',note:''};

console.log('   리쿼샵 태그:',tags(liquor).join(','));
console.log('   타치노미 태그:',tags(izakaya).join(','));
t('리쿼샵 인식', tags(liquor).includes('리쿼샵'));
t('타치노미 인식', tags(izakaya).includes('타치노미'));
t('현금만 인식', tags(izakaya).includes('현금'));
t('스시 인식', tags(sushi).includes('스시'));
t('라멘 인식', tags(ramen).includes('라멘'));
t('노미호다이 인식', tags(nomi).includes('노미호다이'));
t('예약 필요 인식', tags(nomi).includes('예약'));
t('사우나 인식', tags(sauna).includes('사우나'));
t('사우나는 주문 태그 없음', !tags(sauna).includes('주문'));
t('재방문 태그', tags(Object.assign({},sushi,{visited:true})).includes('재방문'));

const L=pick(liquor), I=pick(izakaya), S=pick(sushi);
t('가게마다 문장 다름', JSON.stringify(L.map(r=>r.x.j))!==JSON.stringify(I.map(r=>r.x.j)));
t('리쿼샵 전용 문장 포함', L.some(r=>r.x.m.includes('면세')||r.x.m.includes('도수')));
t('타치노미 전용 문장 포함', I.some(r=>r.x.m.includes('서서')||r.x.m.includes('한 잔만')));
t('스시 전용 문장 포함', S.some(r=>r.x.m.includes('오마카세')||r.x.m.includes('와사비')));
t('문장 12개 이하', L.length<=12 && I.length<=12);
t('문장 6개 이상', L.length>=6 && I.length>=6);
t('중복 문장 없음', new Set(L.map(r=>r.x.j)).size===L.length);
t('모든 문장에 히라가나·뜻', L.every(r=>r.x.j&&r.x.k&&r.x.m));
t('계산/곤란 문장 항상 포함', L.some(r=>r.tag==='계산')&&L.some(r=>r.tag==='곤란'));

// 한글 발음 생성
const ko=w.eval("jpKoSound('おすすめは なんですか。')");
console.log('   한글 발음 예:',ko);
t('한글 발음 생성', /[가-힣]/.test(ko));

// 렌더
FM().places=[Object.assign({id:'x1',lat:33.59,lng:130.40,priority:0,videos:[]},izakaya)];
w.Element.prototype.scrollIntoView=function(){};w.eval("renderFoodMap();fmSelect('x1');");
w.document.body.insertAdjacentHTML('beforeend','<div id="fmJpOut"></div>');
w.eval("fmSpotJapanese('x1')");
const out=w.document.getElementById('fmJpOut').innerHTML;
t('카드 렌더', out.includes('이와세 쿠시텐'));
t('일본어 표시', out.includes('カウンター')||out.includes('立ち飲み'));
t('한글 발음 표시', /[가-힣]{2,}/.test(out));
t('AI 보강 버튼', out.includes('AI로 더 만들기'));
t('지어내지 않는다 안내', out.includes('지어내지 않습니다'));

// 영업시간 표시
FM().places[0].hours={desc:['월요일: 오전 11:00~오후 10:00','화요일: 휴무일','수요일: 오후 5:00~오전 2:00','목요일: 오후 5:00~오전 2:00','금요일: 오후 5:00~오전 2:00','토요일: 오후 5:00~오전 2:00','일요일: 휴무일'],periods:[{d:1,oh:11,om:0,cd:1,ch:22,cm:0}]};
w.eval("fmSpotJapanese('x1')");
t('오늘 영업시간 표시', w.document.getElementById('fmJpOut').innerHTML.includes('오늘 '));

t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
