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
w.alert=()=>{}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
const card=()=>[...w.document.querySelectorAll('#fmSpotTools .xcard')].find(x=>x.querySelector('h3')&&x.querySelector('h3').textContent.includes('핵심정보 요약'));
const rowTags=()=>[...card().querySelectorAll('.jp-spot-row .tag')].map(x=>x.textContent);
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

w.fmMerge(w.fmCsv(csv));
FM().places.forEach((p,i)=>{p.lat=33.59+i*0.001;p.lng=130.40+i*0.001;});
const p0=FM().places[0];
p0.note='리쿼샵, 일요일 수요일 휴무, 현금만'; p0.rating=4.3; p0.ratingCount=88;
p0.sourcePlatform='인스타그램'; p0.sourceNote='사케 종류 많고 면세 가능하다고';
FM().selected=p0.id;
w.eval('renderFoodMap()');

// 요약 전 상태
t('선택 장소에 요약 카드 존재', !!card());
t('지어내지 않는다는 고지', card().textContent.includes('지어내지 않습니다'));
t('요약 전에는 지우기 버튼 없음', !card().textContent.includes('요약 지우기'));

// AI 에 넘기는 근거에 저장 데이터가 실린다
const facts=w.eval('spFacts(foodMap.places[0])');
t('근거에 사용자 메모', facts.includes('리쿼샵'));
t('근거에 저장 이유', facts.includes('사케 종류 많고'));
t('근거에 출처 플랫폼', facts.includes('인스타그램'));
t('근거에 평점', facts.includes('4.3'));
t('근거에 휴무(메모 파싱 결과)', facts.includes('휴무'));

// 키 없으면 호출하지 않고 저장 데이터만 보여 준다
let called=0; w.fetch=async()=>{called++;throw new Error('불려서는 안 된다');};
await w.eval('spSummarize(foodMap.places[0].id)');
await new Promise(r=>setTimeout(r,150));
t('키 없으면 네트워크 호출 0', called===0);
t('키 없을 때 안내', w.document.getElementById('fmSumOut').textContent.includes('Gemini 키가 없어'));
t('키 없어도 저장 정보는 보여 준다', w.document.getElementById('fmSumOut').textContent.includes('리쿼샵'));
t('키 없으면 요약 저장 안 함', FM().places[0].sum===undefined);

// 키가 있으면 규칙·근거를 담아 호출한다
w.eval("ai.key='K';");
let sent=null;
w.fetch=async(u,o)=>{sent=JSON.parse(o.body).contents[0].parts[0].text;
 return{ok:true,json:async()=>({candidates:[{content:{parts:[{text:'```json {"headline":"사케 종류가 많은 리쿼샵","tips":["현금만 받는다고 메모에 적혀 있음","면세 가능 여부를 계산 전에 확인"],"menu":[],"best":"일·수 휴무라 그 외 요일","caution":"현금만","budget":"","confidence":"보통"} ```'}]}}]})};};
await w.eval('spSummarize(foodMap.places[0].id)');
await new Promise(r=>setTimeout(r,250));
t('프롬프트에 환각 차단 규칙', sent.includes('만들어내지 않는다'));
t('프롬프트에 메모 우선 규칙', sent.includes('가장 확실한 단서'));
t('프롬프트에 실제 메모', sent.includes('리쿼샵'));
t('프롬프트에 JSON 형식 지시', sent.includes('"confidence"'));

const s=FM().places[0].sum;
t('요약 저장됨', !!s);
t('한 줄 요약 보존', s.headline==='사케 종류가 많은 리쿼샵');
t('팁 배열 보존', Array.isArray(s.tips)&&s.tips.length===2);
t('빈 메뉴는 빈 배열', Array.isArray(s.menu)&&s.menu.length===0);
t('빈 예산은 빈 문자열', s.budget==='');
t('신뢰도 저장', s.conf==='보통');
t('확인 시각 저장', String(s.at).startsWith(w.eval('TODAY')));
t('코드블록 표기 제거 후 파싱', !JSON.stringify(s).includes('```'));

// 화면 표시
w.eval('renderFoodMap()');
t('신뢰도 화면 표시', card().textContent.includes('신뢰도'));
t('확인 시각 화면 표시', card().textContent.includes(w.eval('TODAY')));
t('현장 재확인 고지', card().textContent.includes('현장에서 다시 확인'));
const tags=rowTags();
console.log('   표시된 행:', tags.join(' | ')||'(없음)');
t('팁 행 2개', tags.filter(x=>x==='팁').length===2);
t('시간·주의 행 표시', tags.includes('시간')&&tags.includes('주의'));
t('빈 메뉴 행 미표시', !tags.includes('메뉴'));
t('빈 예산 행 미표시', !tags.includes('예산'));
t('다시 정리 버튼', card().textContent.includes('다시 정리'));
t('요약 지우기 버튼', card().textContent.includes('요약 지우기'));

// 호출 실패해도 기존 요약과 앱이 살아 있다
w.fetch=async()=>{throw new Error('네트워크 끊김');};
await w.eval('spSummarize(foodMap.places[0].id)');
await new Promise(r=>setTimeout(r,200));
t('실패 시 안내', w.document.getElementById('fmSumOut').textContent.includes('요약 실패'));
t('실패해도 기존 요약 유지', !!FM().places[0].sum);
t('실패해도 앱 생존', errs.length===0);

// 지우기
w.eval('spClear(foodMap.places[0].id)');
t('요약 삭제됨', FM().places[0].sum===undefined);
t('장소·메모는 남음', FM().places[0].note.includes('리쿼샵'));

// 저장 키를 늘리지 않았다 / 백업에 함께 나간다
t('새 localStorage 키 없음', !html.includes("load('spot") && !html.includes("save('sum"));
FM().places[1].sum={headline:'테스트',tips:[],menu:[],best:'',caution:'',budget:'',conf:'낮음',at:'2026-07-30 09:00'};
/* bkFoodMap 은 localStorage 에서 읽는다(18절) — 메모리 객체만 바꾸면 백업에 안 실린다. */
w.eval("save('foodmap_v1',foodMap)");
let cap=null;
w.Blob=function(a){this.a=a;};
w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a[0]);return 'blob:x';};
w.eval('exportData()');
t('백업에 요약 포함', cap.foodMap.places.some(p=>p.sum&&p.sum.headline==='테스트'));
t('백업에 API 키 미포함', cap.foodMap.apiKey===undefined);

t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
