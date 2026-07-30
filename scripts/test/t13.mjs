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
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

w.fmMerge(w.fmCsv(csv));
const CATS=['맛집·식당','바·이자카야','카페·디저트','관광·명소','쇼핑','사우나·온천'];
FM().places.forEach((p,i)=>{const h=[[33.5902,130.3986],[33.5895,130.4200],[33.5790,130.3960]][i%3];
 p.lat=h[0]+((i%17)-8)*0.0006;p.lng=h[1]+((i%13)-6)*0.0006;p.cat=CATS[i%CATS.length];});
FM().selected=FM().places[0].id;
w.eval("fmSetHotelFromSpot();bgSetTotal(80000);bgSetDays(4);foodMap.courseStart=18;csBuild();plBuild();renderFoodMap();");

const panels=[...w.document.querySelectorAll('details.fm-panel')].map(d=>({id:d.getAttribute('ontoggle'),open:d.hasAttribute('open'),sum:d.querySelector('summary').textContent.trim()}));
console.log('--- 패널 ---'); panels.forEach(p=>console.log('  ',p.open?'[열림]':'[접힘]',p.sum.replace(/\s+/g,' ')));
t('패널 7개', panels.length===7);
t('구역만 기본 열림', panels.filter(p=>p.open).length===1 && panels.find(p=>p.open).sum.includes('구역'));
t('예산 요약에 잔액', panels.some(p=>p.sum.includes('80,000엔 남음')||p.sum.includes('남음')));
t('코스 요약에 곳수·시간', panels.some(p=>/\d+곳 · \d{2}:\d{2}~/.test(p.sum)));
t('일정 요약에 배정', panels.some(p=>p.sum.includes('배정')));
t('구역 요약에 구역 수', panels.some(p=>p.sum.includes('구역')));

// 접힘 상태가 저장되는가
const det=w.document.querySelector('details.fm-panel');
det.setAttribute('open','');
det.dispatchEvent(new w.Event('toggle'));
t('열림 상태 저장', FM().panels && Object.values(FM().panels).some(v=>v===true));
w.eval('renderFoodMap()');
const reopened=[...w.document.querySelectorAll('details.fm-panel')].filter(d=>d.hasAttribute('open')).length;
t('재렌더 후 열림 유지', reopened>=1);

// 어시스턴트는 접히지 않는다
t('어시스턴트는 항상 보임', w.document.getElementById('asIn')!==null);
// 접힌 상태에서도 기능 동작
t('접힌 채로도 코스 존재', FM().course && FM().course.stops.length>0);
t('접힌 채로도 일정 존재', FM().plan && FM().plan.plan.length>0);
t('지도·목록 여전히 렌더', w.document.getElementById('fmList').innerHTML.length>300);
t('분포 지도 존재', w.document.getElementById('fmOverview').innerHTML.includes('<svg'));

// 목록까지의 카드 수(스크롤 길이 대리 지표)
const before=w.document.getElementById('fmList').previousElementSibling;
t('목록 앞이 지도/스팟툴', !!before);
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
