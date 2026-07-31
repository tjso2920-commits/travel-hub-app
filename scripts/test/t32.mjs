/**
 * 일본어 학습 코스 선택.
 * 90일 하나뿐이면 "3주 뒤 출발" 인 사람은 시작도 못 한다.
 * 콘텐츠는 그대로 두고 어느 주차를 쓸지만 바꾸므로, 코스를 바꿔도 외운 것이 안 날아가야 한다.
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

t('기본은 90일 전체', w.eval('jpPlan().k')==='d90'&&w.eval('jpLimit()')===90);
t('코스 5종', w.eval('JP_PLANS.length')===5);

/* 각 코스의 길이와 주차 */
const plans=w.eval('JP_PLANS.map(p=>[p.k,p.d,p.w.length])');
t('짧은 코스일수록 일수가 적음', plans.every((p,i)=>i===0||p[1]>plans[i-1][1]), plans);
t('짧은 코스일수록 주차도 적음', plans.every((p,i)=>i===0||p[2]>=plans[i-1][2]), plans);
t('필수 표현은 7일', plans[0][1]===7);
t('90일 전체는 13주 다 씀', plans[4][2]===13);

/* 코스마다 마지막 날이 범위 안에 들어오는가 — 넘치면 빈 화면이 나온다 */
for(const [k,days] of w.eval('JP_PLANS.map(p=>[p.k,p.d])')){
  w.eval(`jpSetPlan('${k}')`);
  const first=w.eval('jpWeekFor(0)'), last=w.eval(`jpWeekFor(${days-1})`);
  const ws=w.eval('jpPlan().w');
  t(k+' 첫날이 첫 주차', first===ws[0], [first,ws[0]]);
  t(k+' 마지막날이 마지막 주차', last===ws[ws.length-1], [last,ws[ws.length-1]]);
  const s=w.eval(`jpSession(${days-1})`);
  t(k+' 마지막날 문장 6개', s.lines.length===6, s.lines.length);
}

/* 주차가 순서대로 나아가는가 — 뒤로 가면 안 된다 */
w.eval("jpSetPlan('d30')");
const seq=[];for(let i=0;i<30;i++)seq.push(w.eval(`jpWeekFor(${i})`));
t('주차가 뒤로 가지 않음', seq.every((x,i)=>i===0||x>=seq[i-1]), seq.join(','));
t('30일 코스가 주차를 건너뜀', new Set(seq).size===w.eval('jpPlan().w.length'), [...new Set(seq)]);

/* 코스를 바꿔도 외운 것과 복습 일정이 남는가 */
w.eval("jpSetPlan('d90');jpState.pointer=20;jpState.done={'0':'2026-07-01','1':'2026-07-02'};");
w.eval("jpState.srs={'w0-3':{due:'2026-08-01',box:2}};save('jp_state_v1',jpState);");
w.eval("jpSetPlan('d15')");
t('진도가 총량 안으로 맞춰짐', w.eval('jpState.pointer')===15, w.eval('jpState.pointer'));
t('외운 기록은 그대로', Object.keys(w.eval('jpState.done')).length===2);
t('복습 일정도 그대로', !!w.eval("jpState.srs['w0-3']"));
w.eval("jpSetPlan('d90')");
t('다시 늘려도 기록 유지', Object.keys(w.eval('jpState.done')).length===2&&!!w.eval("jpState.srs['w0-3']"));

/* 화면 */
w.eval("showTab('jp');renderJapanese();");
const jp=d.getElementById('jpRoot').textContent;
t('코스 버튼 5개 노출', [...d.querySelectorAll('#jpRoot .fm-cats button')].length>=5,
  [...d.querySelectorAll('#jpRoot .fm-cats button')].map(b=>b.textContent));
t('현재 코스 이름 표시', jp.includes('90일 전체'));
t('코스 설명 표시', jp.includes('하카타벤까지'));
t('바꿔도 기록 남는다고 안내', jp.includes('복습 일정은 그대로'));

w.eval("jpSetPlan('essential')");
const jp2=d.getElementById('jpRoot').textContent;
t('필수 코스로 바뀜', jp2.includes('필수 표현만')&&jp2.includes('시간 없을 때'));
t('진도 분모가 7', jp2.includes('/ 7')||jp2.includes('/7'), jp2.match(/\d+\s*\/\s*\d+/g));

/* 어시스턴트 컨텍스트에도 코스가 실린다 */
t('컨텍스트에 코스 이름', w.eval('asContext()').includes('필수 표현만'));

t('새 저장소 키 없음', !Object.keys(w.localStorage).some(k=>/plan|course/i.test(k)));
t('최종 런타임 오류 0', errs.length===0, errs.slice(0,2));
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
