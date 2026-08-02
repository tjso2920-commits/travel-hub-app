/**
 * 출시 전에 반드시 고쳐야 했던 둘.
 *
 * 1. **응답이 안 오면 기능이 영구히 잠겼다.**
 *    파일 전체에 타임아웃이 0개였다. 신호가 끊길락말락 하면 fetch 가 영영 안 끝나고
 *    "번역 중…" 이 남고 trBusy 가 true 로 박혀 **다시 누를 수도 없었다.**
 *    여행 앱에서 신호 불안정은 예외가 아니라 기본값이다 —
 *    지하철·국경·로밍 전환·기내 와이파이. 이제 25초에 끊고 사람 말로 알려 준다.
 *
 * 2. **두 번째 여행을 못 갔다.**
 *    후쿠오카 다녀온 뒤 파리로 바꾸면 후쿠오카 30곳이 '파리권'에 그대로 뜨고,
 *    **하카타 호텔이 파리 여행의 기준점**으로 남아 거리·동선이 전부 엉망이었다.
 *    "20개 나라 됩니다" 라고 파는데 두 번째 여행에서 못 쓰면 파는 약속과 다른 것이다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(fs.readFileSync(file, 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; await new Promise((r) => setTimeout(r, 700));
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
let asked = []; w.alert = () => {}; w.confirm = (m) => { asked.push(String(m)); return true; };
w.Element.prototype.scrollIntoView = function () {};
w.eval("fm2Download=function(n){window.__dl=n;};");

/* ── 1. 타임아웃 ─────────────────────────────────────────────────────── */
t('타임아웃 도구가 있음', w.eval("typeof fetchWait==='function'"));
t('기본 대기가 정해져 있음', w.eval('typeof NET_WAIT') === 'number' && w.eval('NET_WAIT') > 0 && w.eval('NET_WAIT') <= 30000);
t('AI 호출이 타임아웃을 씀', /fetchWait\(url,\{method:'POST'/.test(fs.readFileSync(file, 'utf8')));
t('환율도 타임아웃을 씀', /fetchWait\('https:\/\/api\.frankfurter/.test(fs.readFileSync(file, 'utf8')));
t('날씨도 타임아웃을 씀', /fetchWait\(u,\{\},15000\)/.test(fs.readFileSync(file, 'utf8')));
/* 시간 초과 문구가 다른 말로 덮이면 안 된다 */
t('시간 초과는 사람 말 그대로 나옴',
  w.eval("aiErrTxt('시간이 오래 걸립니다. 신호를 확인하고 다시 눌러 주세요.')").includes('시간이 오래 걸립니다'));
/* 시간 초과는 재시도하면 안 된다 — 25초 × 3번이면 잠긴 것과 같다 */
const src = fs.readFileSync(file, 'utf8');
t('시간 초과는 다시 걸지 않음', /시간이 오래 걸립니다\/\.test\(last\.message\)\)throw last/.test(src));

/* ── 2. 새 여행으로 시작하기 ─────────────────────────────────────────── */
function trip() {
  w.eval(`
    foodMap.lic={name:'q',date:'2026-01-01'}; foodMap.setupSeen=true; foodMap.setupDone=true;
    foodMap.dest='후쿠오카'; foodMap.destCountry='JP';
    foodMap.places=Array.from({length:30},function(_,i){return{id:'f'+i,name:'후쿠오카가게'+i,
      cat:'맛집·식당',lat:33.59+i*0.002,lng:130.40+i*0.002,address:'福岡市',visited:i<20};});
    foodMap.hotel={name:'하카타호텔',lat:33.59,lng:130.42}; foodMap.originMode='hotel';
    foodMap.d1='2026-10-25'; foodMap.d2='2026-10-29';
    save('foodmap_v1',foodMap); delete window.__dl;
  `);
}

trip(); asked = []; w.confirm = (m) => { asked.push(String(m)); return true; };
w.eval("fmSetCountry('FR');");
t('나라를 바꾸면 물어봄', asked.length === 1);
t('몇 곳을 비우는지 알려줌', asked[0] && asked[0].includes('30곳'));
t('백업을 먼저 받는다고 알려줌', asked[0] && asked[0].includes('백업'));
t('취소하면 어떻게 되는지 알려줌', asked[0] && asked[0].includes('취소'));
t('비우기 전에 백업 파일을 실제로 내려받음', typeof w.eval('window.__dl') === 'string');
t('장소가 비워짐', w.eval('foodMap.places.length') === 0);
t('숙소가 비워짐 (이름·좌표 없음)',
  !w.eval("(foodMap.hotel||{}).name") && !w.eval("(foodMap.hotel||{}).lat"));
t('거리 계산 기준점이 사라짐', w.eval('fmOrigin()') === null);
t('여행 날짜가 비워짐', !w.eval('foodMap.d1') && !w.eval('foodMap.d2'));
t('나라는 바뀜', w.eval('fmCountry()') === 'FR');
t('이전 여행 곳이 새 권역에 안 보임', w.eval('fmFiltered().length') === 0);

/* [취소] 를 누르면 지금 것을 그대로 둔다 */
trip(); w.confirm = () => false;
w.eval("fmSetCountry('FR');");
t('취소하면 장소가 남음', w.eval('foodMap.places.length') === 30);
t('취소하면 숙소도 남음', w.eval("(foodMap.hotel||{}).name") === '하카타호텔');
t('취소해도 나라는 바뀜', w.eval('fmCountry()') === 'FR');

/* 물어보면 안 되는 때 */
asked = []; w.confirm = (m) => { asked.push(m); return true; };
w.eval("foodMap.destCountry='JP';foodMap.dest='후쿠오카';save('foodmap_v1',foodMap);fmSetCountry('JP');");
t('같은 나라면 안 물어봄', asked.length === 0);

asked = [];
w.eval("foodMap.places=[];delete foodMap.hotel;delete foodMap.d1;foodMap.destCountry='JP';save('foodmap_v1',foodMap);fmSetCountry('TH');");
t('담은 게 없으면 안 물어봄 (처음 설정 중)', asked.length === 0);

asked = [];
w.eval("foodMap.places=[];delete foodMap.hotel;delete foodMap.d1;delete foodMap.destCountry;save('foodmap_v1',foodMap);fmSetCountry('FR');");
t('나라를 처음 정할 때도 안 물어봄', asked.length === 0);

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
