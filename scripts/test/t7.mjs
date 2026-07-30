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
w.alert=()=>{}; w.confirm=()=>true;
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

w.fmMerge(w.fmCsv(csv));
FM().places.forEach((p,i)=>{const h=[[33.5902,130.3986],[33.5895,130.4200],[33.5790,130.3960]][i%3];p.lat=h[0]+((i%17)-8)*0.0004;p.lng=h[1]+((i%13)-6)*0.0004;});
FM().selected=FM().places[0].id; w.eval('fmSetHotelFromSpot()');
FM().places[3].note='모츠나베 야쿠인'; FM().places[3].reservation='needed'; FM().places[3].priority=2;
w.eval('bgSetTotal(12000);renderFoodMap()');

t('어시스턴트 UI 렌더', w.document.getElementById('asIn')!==null);
t('빠른 질문 버튼', w.document.body.innerHTML.includes('남은 돈 쓰기'));
t('예산 저장', FM().budget===12000);

const ctx=w.eval('asContext()');
console.log('--- 컨텍스트 미리보기 ---');
console.log(ctx.split('\n').slice(0,9).join('\n'));
t('컨텍스트에 시각', ctx.includes('[현재]'));
t('컨텍스트에 D-day (프로필 있을 때만)', w.eval('!!prof')? ctx.includes('[여행 D-day]') : !ctx.includes('[여행 D-day]'));
t('컨텍스트에 기준점', ctx.includes('[거리 기준점]'));
t('컨텍스트에 예산', ctx.includes('12,000엔'));
t('컨텍스트에 장소 목록', ctx.includes('[가까운 저장 장소 목록]'));
t('장소에 거리 포함', /·\s*\d+(m|\.\d+km)/.test(ctx));
t('장소에 도보 시간', ctx.includes('도보 '));
t('메모 전달', ctx.includes('메모: 모츠나베 야쿠인'));
t('예약 상태 전달', ctx.includes('예약 확인 필요'));
t('일본어 진도 전달', ctx.includes('[일본어 진도]'));
t('후보 18개 이하', (ctx.match(/\n- /g)||[]).length<=19);

// 키 없을 때 폴백
w.eval("ai.key='';");
w.document.getElementById('asIn').value='지금 갈 만한 곳';
await w.eval('asAsk()');
await new Promise(r=>setTimeout(r,200));
let chat=JSON.parse(w.eval('JSON.stringify(asChat)'));
t('키 없으면 오프라인 폴백', chat.at(-1).t.includes('오프라인 답변'));
t('폴백에도 실제 장소 제시', chat.at(-1).t.includes('- '));

// 키 있을 때 프롬프트 검증
let sent=null;
w.fetch=async(url,opt)=>{sent=JSON.parse(opt.body);return{ok:true,json:async()=>({candidates:[{content:{parts:[{text:'테스트 답변'}]}}]})};};
w.eval("ai.key='TESTKEY';");
w.document.getElementById('asIn').value='남은 예산으로 뭐 살까';
await w.eval('asAsk()');
await new Promise(r=>setTimeout(r,300));
const prompt=sent.contents[0].parts[0].text;
t('규칙 프롬프트 포함', prompt.includes('지어내지 말고'));
t('목록 밖 금지 규칙', prompt.includes('목록 밖 가게를 새로 만들어내지 않는다'));
t('상황 주입됨', prompt.includes('[상황]')&&prompt.includes('[가까운 저장 장소 목록]'));
t('질문 포함', prompt.includes('남은 예산으로 뭐 살까'));
t('직전 대화 포함', prompt.includes('[직전 대화]'));
chat=JSON.parse(w.eval('JSON.stringify(asChat)'));
t('답변 저장', chat.at(-1).t==='테스트 답변');
t('localStorage 반영', JSON.parse(w.localStorage.getItem(w.eval('PFX')+'as_chat_v1')).length===chat.length);

// 실패 처리
w.fetch=async()=>{throw new Error('네트워크 끊김');};
w.document.getElementById('asIn').value='재시도';
await w.eval('asAsk()');
await new Promise(r=>setTimeout(r,300));
chat=JSON.parse(w.eval('JSON.stringify(asChat)'));
t('호출 실패 시 앱 안 죽음', chat.at(-1).t.includes('호출 실패'));
t('실패 후에도 런타임 오류 0', errs.length===0);

// 백업
let cap=null; w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a?b.a[0]:'{}');return 'blob:x';};
w.Blob=function(a){this.a=a;};
w.eval('exportData()');
t('백업에 어시스턴트 대화 포함', Array.isArray(cap.asChat)&&cap.asChat.length>0);
t('백업에 예산 포함', cap.foodMap.budget===12000);
t('백업에 API 키 없음', cap.foodMap.apiKey===undefined);

console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
