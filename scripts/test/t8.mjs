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
w.eval('bgSetTotal(80000);bgSetDays(4);renderFoodMap()');
t('총예산 저장', FM().budget===80000);
t('남은 일수 저장', FM().tripDays===4);
t('예산 카드 렌더', w.document.getElementById('bgAmt')!==null);
t('하루 권장 계산', w.eval('bgPerDay()')===20000);

// 지출 추가 (장소 연결)
const pid=FM().places[3].id;
w.document.getElementById('bgAmt').value='4800';
w.document.getElementById('bgMemo').value='닷사이';
w.document.getElementById('bgPlace').value=pid;
w.eval('bgAdd()');
t('지출 1건 기록', w.eval('bgSpends().length')===1);
t('잔액 자동 차감', w.eval('bgLeft()')===75200);
t('하루 권장 재계산', w.eval('bgPerDay()')===18800);
t('연결한 장소 방문 처리', FM().places[3].visited===true);
t('지출에 장소명 저장', w.eval('bgSpends()[0].place')===FM().places[3].name);
t('오늘 사용액', w.eval('bgSpentToday()')===4800);

// 금액 없이 추가 시도
w.document.getElementById('bgAmt').value='';
w.eval('bgAdd()');
t('빈 금액은 기록 안 됨', w.eval('bgSpends().length')===1);

// 두 번째 지출, 장소 없이
w.document.getElementById('bgAmt').value='1200';
w.document.getElementById('bgMemo').value='지하철';
w.document.getElementById('bgPlace').value='';
w.eval('bgAdd()');
t('장소 없는 지출 가능', w.eval('bgSpends().length')===2 && w.eval('bgLeft()')===74000);

// 초과 표시
w.eval('bgSetTotal(5000)');
t('초과 시 음수 잔액', w.eval('bgLeft()')===-1000);
t('초과 표기', w.document.body.innerHTML.includes('초과'));
w.eval('bgSetTotal(80000)');

// 삭제
const sid=w.eval('bgSpends()[0].id');
w.eval("bgDel('"+sid+"')");
t('지출 삭제', w.eval('bgSpends().length')===1 && w.eval('bgLeft()')===78800);

// 어시스턴트 컨텍스트
const ctx=w.eval('asContext()');
console.log('--- 예산 컨텍스트 ---');
ctx.split('\n').filter(l=>/예산|일수|사용|지출/.test(l)).forEach(l=>console.log(l));
t('컨텍스트에 예산 요약', ctx.includes('[예산] 총 80,000엔'));
t('컨텍스트에 잔액', ctx.includes('남은 돈 78,800엔'));
t('컨텍스트에 하루 권장', ctx.includes('하루 권장'));
t('컨텍스트에 최근 지출', ctx.includes('[최근 지출]')&&ctx.includes('지하철'));
t('컨텍스트에 오늘 사용', ctx.includes('[오늘 사용]'));

// 백업
let cap=null; w.Blob=function(a){this.a=a;}; w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a[0]);return 'blob:x';};
w.eval('exportData()');
t('백업에 지출 포함', Array.isArray(cap.foodMap.spends)&&cap.foodMap.spends.length===1);
t('백업에 총예산 포함', cap.foodMap.budget===80000);
t('백업에 API 키 없음', cap.foodMap.apiKey===undefined);
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
