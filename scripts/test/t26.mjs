/**
 * AI 하루 코스.
 * AI 에게 맡기는 것은 고르는 것과 순서뿐이다. 숫자는 전부 앱이 계산해야 하고,
 * 후보에 없는 장소가 일정에 들어가면 안 된다.
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

/* 하카타 근처에 흩어진 후보 8곳 */
w.eval(`ai.key='TESTKEY';
 foodMap.places=[
  {id:'r1',name:'우동 타이라',cat:'맛집·식당',kind:'우동·소바',lat:33.5902,lng:130.3986},
  {id:'r2',name:'모츠나베 오오야마',cat:'맛집·식당',kind:'모츠나베',lat:33.5910,lng:130.4010},
  {id:'c1',name:'커피 카운티',cat:'카페·디저트',kind:'카페·디저트',lat:33.5895,lng:130.3999},
  {id:'c2',name:'레크 커피',cat:'카페·디저트',kind:'카페·디저트',lat:33.5880,lng:130.4020},
  {id:'b1',name:'나카스 포장마차',cat:'바·이자카야',kind:'야타이',lat:33.5930,lng:130.4050},
  {id:'s1',name:'하카타 한큐',cat:'쇼핑',kind:'',lat:33.5899,lng:130.4207},
  {id:'v1',name:'쿠시다 신사',cat:'관광·명소',kind:'',lat:33.5935,lng:130.4100},
  {id:'x1',name:'이미 간 집',cat:'맛집·식당',kind:'',lat:33.5905,lng:130.3990,visited:true}];
 foodMap.places.forEach(p=>{p.note='';p.address='';p.region='하카타';});
 foodMap.filter='전체';foodMap.q='';foodMap.region='전체 지역';foodMap.kind='전체 음식·술';foodMap.status='기본 상태';
 foodMap.hotel={name:'테스트 호텔',lat:33.5900,lng:130.4000};
 foodMap.originMode='hotel';foodMap.courseStart=11;foodMap.courseMax=4;
 renderFoodMap();`);

/* 후보 목록 */
const pool=w.eval('csAiPool().map(o=>o.p.id)');
t('방문한 곳은 후보에서 빠짐', !pool.includes('x1'), pool);
t('후보가 숙소에서 가까운 순', pool[0]==='r1'||pool[0]==='c1', pool.slice(0,3));

/* Gemini 를 가로채 응답을 조종한다 */
let sent=null;
const mock=(obj)=>{w.fetch=async(u,o)=>{sent=JSON.parse(o.body);
  return{ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(obj)}]}}]})};};};

// ── 정상 응답 ─────────────────────────────────────────────────────────────
mock({title:'하카타 한 바퀴',stops:[
  {id:'r1',reason:'점심은 가벼운 우동으로'},
  {id:'c1',reason:'밥 먹고 바로 옆 카페'},
  {id:'v1',reason:'소화시킬 겸 신사 한 바퀴'},
  {id:'b1',reason:'마무리는 포장마차'}]});
await w.eval('csAiBuild()');
await new Promise(r=>setTimeout(r,200));

const c=()=>FM().course;
t('코스 생성됨', !!c()&&c().stops.length===4, c()&&c().stops.length);
t('AI 표시 남음', c().ai===true);
t('제목 저장됨', c().title==='하카타 한 바퀴', c().title);
t('AI 가 준 순서 유지', c().stops.map(s=>s.id).join(',')==='r1,c1,v1,b1', c().stops.map(s=>s.id));
t('이유 저장됨', c().stops[0].why==='점심은 가벼운 우동으로', c().stops[0].why);

/* 숫자는 앱이 계산한 것이어야 한다 */
t('시작 시각이 설정값 그대로', c().stops[0].at===11*60+c().stops[0].walk, c().stops[0].at);
t('시각이 순서대로 증가', c().stops.every((s,i)=>i===0||s.at>c().stops[i-1].at));
t('도보 시간이 계산됨', c().stops.slice(1).every(s=>s.walk>0), c().stops.map(s=>s.walk));
t('총 도보 = 각 구간 합', c().walkTotal===c().stops.reduce((a,s)=>a+s.walk,0));
t('종료 시각 = 마지막 도착 + 체류', c().endAt===c().stops[3].at+c().stops[3].dwell);

/* 분류에 맞는 목적·체류시간 */
const goal=id=>c().stops.find(s=>s.id===id);
t('카페는 목적이 카페', goal('c1').goal==='카페'&&goal('c1').dwell===40);
t('바는 목적이 술', goal('b1').goal==='술'&&goal('b1').dwell===90);
t('관광은 목적이 관광', goal('v1').goal==='관광');
t('식당은 목적이 식사', goal('r1').goal==='식사'&&goal('r1').dwell===60);

/* 프롬프트 점검 */
const prompt=sent.contents[0].parts[0].text;
t('후보 id 가 프롬프트에 실림', prompt.includes('r1 | 우동 타이라'));
t('방문한 곳은 프롬프트에 없음', !prompt.includes('이미 간 집'));
t('지어내지 말라고 지시함', prompt.includes('만들어내면 안 된다'));
t('숙소가 상황에 실림', prompt.includes('테스트 호텔'));
t('JSON 스키마 강제', sent.generationConfig.responseMimeType==='application/json'&&!!sent.generationConfig.responseSchema);

/* 화면 */
w.eval("showTab('plan')");
const plan=d.getElementById('fmPlan').textContent;
t('제목이 화면에 나옴', plan.includes('하카타 한 바퀴'));
t('이유가 화면에 나옴', plan.includes('점심은 가벼운 우동으로'));
t('AI 버튼 존재', !!d.getElementById('csAiBtn'));

// ── AI 가 없는 장소를 지어낸 경우 ─────────────────────────────────────────
mock({title:'지어낸 코스',stops:[
  {id:'r1',reason:'진짜'},
  {id:'없는가게999',reason:'지어낸 것'},
  {id:'c1',reason:'진짜'},
  {id:'또다른가짜',reason:'지어낸 것'}]});
await w.eval('csAiBuild()');
await new Promise(r=>setTimeout(r,200));
t('없는 id 는 버려짐', c().stops.map(s=>s.id).join(',')==='r1,c1', c().stops.map(s=>s.id));
t('버린 뒤에도 시각 재계산', c().stops[1].at>c().stops[0].at);

// ── 같은 곳을 두 번 준 경우 ───────────────────────────────────────────────
mock({title:'중복',stops:[{id:'r1',reason:'a'},{id:'r1',reason:'b'},{id:'c1',reason:'c'}]});
await w.eval('csAiBuild()');
await new Promise(r=>setTimeout(r,200));
t('중복 제거됨', c().stops.map(s=>s.id).join(',')==='r1,c1');

// ── 최대 곳 수를 넘겨 준 경우 ─────────────────────────────────────────────
mock({title:'과다',stops:['r1','r2','c1','c2','b1','s1','v1'].map(id=>({id:id,reason:'x'}))});
await w.eval('csAiBuild()');
await new Promise(r=>setTimeout(r,200));
t('최대 곳 수 지킴', c().stops.length===4, c().stops.length);

// ── 쓸 만한 게 2곳 미만이면 규칙 기반으로 ─────────────────────────────────
mock({title:'전부 가짜',stops:[{id:'없음1',reason:'x'},{id:'없음2',reason:'y'}]});
await w.eval('csAiBuild()');
await new Promise(r=>setTimeout(r,250));
t('전부 가짜면 규칙 기반으로 되돌아감', !!c()&&c().ai!==true, c()&&c().ai);
t('그 사실을 알림', String(w.__alert||'').includes('기본 방식'));

// ── 호출이 실패해도 앱은 코스를 준다 ──────────────────────────────────────
w.fetch=async()=>{throw new Error('네트워크 끊김');};
await w.eval('csAiBuild()');
await new Promise(r=>setTimeout(r,250));
t('실패해도 코스는 나옴', !!c()&&c().stops.length>0);
t('실패 사유를 알림', String(w.__alert||'').includes('네트워크 끊김'));

// ── 키가 없으면 부르지도 않는다 ───────────────────────────────────────────
let called=false;w.fetch=async()=>{called=true;throw 0;};
w.eval("ai.key='';csAiBuild()");
await new Promise(r=>setTimeout(r,150));
t('키 없으면 호출 안 함', !called);
t('키를 넣으라고 안내', String(w.__alert||'').includes('Gemini 키'));

t('새 저장소 키 없음', !Object.keys(w.localStorage).some(k=>/csai|aicourse/i.test(k)));
t('최종 런타임 오류 0', errs.length===0, errs.slice(0,2));
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
