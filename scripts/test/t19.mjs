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
const panel=()=>[...w.document.querySelectorAll('#fmNow details.fm-panel')].find(x=>x.textContent.includes('여행 일지'));
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

// 기록이 없을 때도 패널은 뜨고 안내를 준다
w.eval('renderFoodMap()');
t('기록 없어도 패널 존재', !!panel());
t('기록 없음 요약', panel().querySelector('summary i').textContent.includes('기록 없음'));
t('빈 상태 안내 문구', panel().textContent.includes('사진으로 기록'));

w.fmMerge(w.fmCsv(csv));
FM().places.forEach((p,i)=>{p.lat=33.59+i*0.001;p.lng=130.40+i*0.001;});
w.eval('bgSetTotal(80000);');

// 옛 형식(메모에만 방문 날짜) 하위 호환
FM().places[0].visited=true; FM().places[0].note='방문 2026-10-26 19:42';
t('옛 메모 형식 파싱', w.eval('tjVisitedAt(foodMap.places[0])')==='2026-10-26 19:42');
// 신 형식
FM().places[1].visited=true; FM().places[1].visitedAt='2026-10-26 12:10';
FM().places[2].visited=true; FM().places[2].visitedAt='2026-10-27 09:05';
// 날짜를 모르는 방문
FM().places[3].visited=true;
t('날짜 없으면 빈 문자열', w.eval('tjVisitedAt(foodMap.places[3])')==='');

w.eval("bgSpends().push({id:'s1',d:'2026-10-26',t:'20:15',amt:4800,memo:'영수증 사진',place:foodMap.places[0].name});");
w.eval("bgSpends().push({id:'s2',d:'2026-10-27',t:'13:00',amt:1200,memo:'지하철',place:''});");
w.eval('renderFoodMap()');

const groups=[...panel().querySelectorAll('details.fm-plan-day')].map(g=>g.querySelector('summary').textContent);
console.log('   그룹:', groups.map(x=>x.split(' · ')[0]).join(' → '));
t('날짜 그룹 4개 아님 — 3개', groups.length===3);
t('최신 날짜부터', groups[0].startsWith('2026-10-27') && groups[1].startsWith('2026-10-26'));
t('날짜 미상은 맨 아래', groups[groups.length-1].includes('날짜 미상'));
t('요일 표기', groups[0].includes('(화)') && groups[1].includes('(월)'));
t('그날 지출 합계 표기', groups[0].includes('1,200엔') && groups[1].includes('4,800엔'));

const entries=w.eval('JSON.stringify(tjEntries())');
const parsed=JSON.parse(entries);
t('방문·지출이 같은 날에 합쳐짐', parsed.find(g=>g.d==='2026-10-26').items.length===3);
t('같은 날 안에서 시각 순', (()=>{const it=parsed.find(g=>g.d==='2026-10-26').items.map(x=>x.t);
  return it.join(',')==='12:10,19:42,20:15';})());
t('지출 항목 금액 보존', parsed.find(g=>g.d==='2026-10-27').items.some(x=>x.k==='spend'&&x.amt===1200));
t('방문 항목 장소명 보존', parsed.find(g=>g.d==='2026-10-27').items.some(x=>x.k==='visit'&&x.place));

const sum=panel().querySelector('summary i').textContent;
t('요약에 방문 곳 수', sum.includes('4곳 방문'));
t('요약에 총 지출', sum.includes('6,000엔'));

// 방문 토글이 시각을 남기고, 해제하면 지운다
const pid=FM().places[5].id;
w.eval(`fmToggle('${pid}','visited')`);
t('방문 켜면 visitedAt 기록', !!FM().places[5].visitedAt);
t('기록된 날짜가 오늘', String(FM().places[5].visitedAt).startsWith(w.eval('TODAY')));
w.eval(`fmToggle('${pid}','visited')`);
t('방문 끄면 visitedAt 제거', FM().places[5].visitedAt===null);

// 지출을 직접 넣으면 연결 장소가 방문 처리되고 시각도 남는다
w.eval('renderFoodMap()');
w.document.getElementById('bgAmt').value='3000';
w.document.getElementById('bgPlace').value=FM().places[7].id;
w.eval('bgAdd()');
t('지출 연결 장소 방문 처리', FM().places[7].visited===true);
t('지출 연결 장소 visitedAt 기록', !!FM().places[7].visitedAt);

// 새 저장 키를 만들지 않았다
t('새 localStorage 키 없음', !html.includes("load('journal") && !html.includes("save('journal"));
// 백업에 함께 실려 나간다(foodMap 안에 있으므로)
let cap=null;
w.Blob=function(a){this.a=a;};
w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a[0]);return 'blob:x';};
w.eval('exportData()');
t('백업에 방문 시각 포함', cap.foodMap.places.some(p=>p.visitedAt));
t('백업에 지출 포함', Array.isArray(cap.foodMap.spends)&&cap.foodMap.spends.length>0);

t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
