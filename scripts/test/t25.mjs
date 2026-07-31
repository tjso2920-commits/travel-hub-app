/**
 * 여러 장소를 한 번에 방문/미방문 표시.
 * 137곳을 하나씩 누르는 것은 현실적으로 불가능하다.
 * 검색·필터로 좁힌 뒤 한 번에 처리하고, 잘못 눌렀으면 되돌릴 수 있어야 한다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const FM=()=>w.eval('foodMap');
const d=w.document;
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
w.alert=()=>{}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

/* 분류가 섞인 6곳 — 필터로 좁힌 뒤 일괄 처리하는 흐름을 보려면 섞여 있어야 한다 */
w.eval(`foodMap.places=[
 {id:'a',name:'우동 타이라',cat:'맛집·식당',note:'',region:'기타 지역',visited:false},
 {id:'b',name:'모츠나베 오오야마',cat:'맛집·식당',note:'',region:'기타 지역',visited:false},
 {id:'c',name:'커피 카운티',cat:'카페·디저트',note:'',region:'기타 지역',visited:false},
 {id:'d',name:'레크 커피',cat:'카페·디저트',note:'',region:'기타 지역',visited:true,visitedAt:'2025-01-02 13:20'},
 {id:'e',name:'나카스 포장마차',cat:'바·이자카야',note:'',region:'기타 지역',visited:false},
 {id:'f',name:'하카타 한큐',cat:'쇼핑',note:'',region:'기타 지역',visited:false}];
 foodMap.filter='전체';foodMap.q='';foodMap.region='전체 지역';foodMap.kind='전체 음식·술';foodMap.status='기본 상태';
 renderFoodMap();`);

const shown=()=>d.querySelectorAll('#fmList .place').length;
const visited=()=>FM().places.filter(p=>p.visited).map(p=>p.id).sort().join(',');
const bar=()=>d.getElementById('fmSelBar').textContent;

t('6곳 다 보임', shown()===6);
t('처음엔 선택 모드 꺼짐', w.eval('fmSel.on')===false);
t('여러 곳 표시 버튼 노출', bar().includes('여러 곳 한 번에 표시'));
t('평소엔 체크박스 없음', !d.querySelector('#fmList .fm-check'));

/* 선택 모드 */
w.eval('fmSelMode(true)');
t('선택 모드 켜짐', w.eval('fmSel.on')===true);
t('카드마다 체크박스', d.querySelectorAll('#fmList .place.picking .fm-check').length===6);
t('선택 모드에선 카드 버튼 감춤', d.querySelectorAll('#fmList .place-btns').length===0);
t('0곳으로 시작', bar().includes('0곳 선택됨'));

/* 개별 선택 */
w.eval(`fmSelPick('a');fmSelPick('b')`);
t('2곳 선택', w.eval('fmSel.ids.size')===2 && bar().includes('2곳 선택됨'));
t('선택한 카드 표시', d.querySelectorAll('#fmList .place.picking.on').length===2);
w.eval(`fmSelPick('a')`);
t('다시 누르면 해제', w.eval('fmSel.ids.size')===1);

/* 필터로 좁힌 뒤 전부 선택 — 137곳에서 실제로 쓰게 될 경로 */
w.eval(`fmSelNone();fmSetFilter('카페·디저트')`);
t('필터 후 2곳', shown()===2);
t('필터 걸어도 선택 모드 유지', w.eval('fmSel.on')===true);
w.eval('fmSelAll()');
t('보이는 것만 선택됨', [...w.eval('fmSel.ids')].sort().join(',')==='c,d');
t('막대에 보이는 개수 표시', bar().includes('아래 목록에 2곳'));

/* 일괄 방문 */
w.eval('fmSelApply(true)');
t('선택한 2곳 방문 처리', visited()==='c,d');
t('처리 후 선택 비움', w.eval('fmSel.ids.size')===0);
t('처리 후 선택 모드 유지', w.eval('fmSel.on')===true);
t('새로 표시한 곳에 오늘 날짜', FM().places.find(p=>p.id==='c').visitedAt.startsWith(w.eval('TODAY')));
t('이미 방문한 곳 날짜 보존', FM().places.find(p=>p.id==='d').visitedAt==='2025-01-02 13:20');

/* 되돌리기 */
w.eval('fmSelMode(false)');
t('되돌리기 버튼 노출', bar().includes('되돌리기')&&bar().includes('2곳'));
w.eval('fmSelUndo()');
t('되돌리면 원래대로', visited()==='d');
t('되돌린 곳 방문일 삭제', FM().places.find(p=>p.id==='c').visitedAt==null);
t('원래 방문한 곳 날짜 유지', FM().places.find(p=>p.id==='d').visitedAt==='2025-01-02 13:20');
t('되돌리기 버튼 사라짐', !bar().includes('되돌리기'));
w.eval('fmSelUndo()');
t('두 번 눌러도 안전', visited()==='d');

/* 일괄 미방문 */
w.eval(`fmSetFilter('전체');fmSelMode(true);fmSelAll();fmSelApply(false)`);
t('전부 미방문 처리', visited()==='');
w.eval('fmSelUndo()');
t('미방문 처리도 되돌아감', visited()==='d');

/* 안전장치 */
let alerted='';w.alert=m=>{alerted=m;};
w.eval('fmSelMode(true);fmSelNone();fmSelApply(true)');
t('아무것도 안 고르면 막음', alerted.includes('골라 주세요')&&visited()==='d');
w.confirm=()=>false;
w.eval(`fmSelPick('a');fmSelApply(true)`);
t('확인 취소하면 안 바뀜', visited()==='d');
w.confirm=()=>true;

/* 종료 */
w.eval('fmSelMode(false)');
t('닫으면 선택 해제', w.eval('fmSel.on')===false&&w.eval('fmSel.ids.size')===0);
t('카드 버튼 복귀', d.querySelectorAll('#fmList .place-btns').length===6);

/* 저장 */
t('localStorage 반영', JSON.parse(w.localStorage.getItem(w.eval('PFX')+'foodmap_v1'))
  .places.filter(p=>p.visited).map(p=>p.id).join(',')==='d');
t('새 저장소 키 없음', !Object.keys(w.localStorage).some(k=>/fmsel|select/i.test(k)));

/* 기존 동작이 그대로인지 */
w.eval(`fmSetFilter('미방문');renderFoodMap()`);
t('미방문 필터가 방문한 곳 제외', shown()===5);
w.eval(`fmSetFilter('전체');fmToggle('a','visited');renderFoodMap()`);
t('개별 방문 표시에도 날짜 기록', FM().places.find(p=>p.id==='a').visitedAt.startsWith(w.eval('TODAY')));
w.eval(`fmToggle('a','visited')`);
t('개별 해제 시 날짜 삭제', FM().places.find(p=>p.id==='a').visitedAt==null);

t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
