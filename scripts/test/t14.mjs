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

w.eval("foodMap.planStart='2026-10-25';foodMap.planDays=4;renderFoodMap();");
t('여행 준비 카드 렌더', w.document.body.innerHTML.includes('여행 준비'));
t('기본 목적지', w.eval('affDest()')==='후쿠오카');
t('기본 공항코드', w.eval('affIata()')==='fuk');

const d=JSON.parse(w.eval('JSON.stringify(affDates())'));
console.log('   날짜:',JSON.stringify(d));
t('체크인=출발일', d.in==='2026-10-25');
t('체크아웃=출발+일수', d.out==='2026-10-29');
t('6자리 날짜 변환', d.in6==='261025' && d.out6==='261029');

const fl=w.eval("affUrl('flight')"), st=w.eval("affUrl('stay')"), pl=w.eval("affUrl('play')");
console.log('   항공:',fl); console.log('   숙소:',st);
t('항공 링크에 공항코드', fl.includes('/fuk/'));
t('항공 링크에 날짜', fl.includes('261025')&&fl.includes('261029'));
t('숙소 링크에 목적지', decodeURIComponent(st).includes('후쿠오카'));
t('숙소 링크에 날짜', st.includes('2026-10-25')&&st.includes('2026-10-29'));
t('액티비티 링크', decodeURIComponent(pl).includes('후쿠오카'));
t('치환 안 된 자리 없음', ![fl,st,pl].some(u=>/\{[a-z0-9]+\}/.test(u)));

// 목적지 변경 → 링크 반영
w.eval("affSetDest('오사카');affSetIata('KIX');");
t('목적지 변경 저장', FM().dest==='오사카' && FM().destIata==='KIX');
t('링크에 새 목적지', decodeURIComponent(w.eval("affUrl('stay')")).includes('오사카'));
t('링크에 새 공항코드', w.eval("affUrl('flight')").includes('/kix/'));

// 제휴 템플릿 직접 지정
w.eval("affSetTpl('stay','https://example.com/go?aid=12345&city={dest}&in={in}&out={out}');");
const custom=w.eval("affUrl('stay')");
console.log('   커스텀:',custom);
t('커스텀 템플릿 사용', custom.includes('aid=12345'));
t('커스텀에도 치환 적용', decodeURIComponent(custom).includes('오사카')&&custom.includes('2026-10-25'));
w.eval('renderFoodMap()');
t('제휴 고지 표시', w.document.body.innerHTML.includes('제휴 링크'));

// 템플릿 비우면 기본으로 복귀
w.eval("affSetTpl('stay','');");
t('빈 템플릿은 기본 링크', w.eval("affUrl('stay')").includes('agoda.com'));

// 링크 안전성
const all=['flight','stay','play','esim'].map(k=>w.eval("affUrl('"+k+"')"));
t('전부 https', all.every(u=>u.startsWith('https://')));
t('링크에 API 키 없음', !all.some(u=>/AIza|key=/.test(u)));
const anchors=[...w.document.querySelectorAll('a[href^="https://www.agoda"],a[href^="https://www.klook"],a[href^="https://www.skyscanner"]')];
t('새 창 + noopener', anchors.length>0 && anchors.every(a=>a.getAttribute('rel')&&a.getAttribute('rel').includes('noopener')));

// 백업
let cap=null; w.Blob=function(a){this.a=a;}; w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a[0]);return 'blob:x';};
w.eval("affSetTpl('play','https://example.com/k?aff=9');exportData();");
t('백업에 목적지·템플릿 포함', cap.foodMap.dest==='오사카' && cap.foodMap.aff.play.includes('aff=9'));
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
