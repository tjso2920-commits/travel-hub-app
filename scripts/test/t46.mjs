/**
 * 출시 전에 반드시 고쳐야 했던 둘.
 *
 * 1. **응답이 안 오면 기능이 영구히 잠겼다.**
 *    파일 전체에 타임아웃이 0개였다. 신호가 끊길락말락 하면 fetch 가 영영 안 끝나고
 *    "번역 중…" 이 남고 trBusy 가 true 로 박혀 **다시 누를 수도 없었다.**
 *    여행 앱에서 신호 불안정은 예외가 아니라 기본값이다 —
 *    지하철·국경·로밍 전환·기내 와이파이. 이제 25초에 끊고 사람 말로 알려 준다.
 *
 * 2. **두 번째 여행을 못 갔다 → 고쳤더니 이번엔 첫 여행 장소가 사라졌다.**
 *    처음엔 후쿠오카 다녀온 뒤 파리로 바꾸면 후쿠오카 30곳이 '파리권'에 그대로
 *    뜨고, 하카타 호텔이 파리 여행 기준점으로 남는 게 문제였다. 그래서 나라를
 *    바꾸면 이전 것을 통째로 비우게 고쳤었다 — 그런데 이건 또 다른 문제였다.
 *    담아 둔 장소는 여행지와 무관하게 계속 갖고 있어야 하는 "보관함"인데,
 *    나라를 한 번 바꿀 때마다 지워지면 "여러 도시에 저장" 자체가 안 된다.
 *
 *    2026-09-09 제품 방향 확정: 장소 보관함과 여행 일정은 다른 것이다.
 *    여행지 선택은 **필터**다 — 담아 둔 장소를 지우지 않는다.
 *    지금 편집 중인 일정(숙소·날짜·코스·예산)은 여전히 하나만 있고, 나라를
 *    바꾸면 그 일정만 비운다(여러 일정 동시 편집은 다음 단계).
 *
 *    2026-09-09 코드 검토 반영: 위 구현이 "여행지를 둘러보는 것"과
 *    "새 일정을 시작하는 것"을 여전히 섞고 있었다 — 나라를 바꿀 때마다
 *    확인창이 뜨면 그냥 구경만 하려던 사람도 매번 결정을 강요받는다.
 *    이제 fmSetCountry() 는 그냥 바꾸기만 한다(확인창 없음). 일정이
 *    다른 여행지 기준으로 남아 있으면 foodMap.itineraryStale 만 표시해
 *    두고, 실제로 비우는 건 fmStartNewTrip() 을 명시적으로 불러야만
 *    일어난다. tripReset() 백업에 예산(budget/spends/tripDays)도 넣었고,
 *    백업이 실패하면 아예 비우지 않는다.
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
w.eval("fm2Download=function(n,o){window.__dl=n;window.__dlBody=JSON.stringify(o);};");

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
    foodMap.budget=500000; foodMap.spends=[{d:'2026-10-25',amt:12000,memo:'라멘'}]; foodMap.tripDays=4;
    save('foodmap_v1',foodMap); delete window.__dl;
  `);
}

/* ── 2a. 여행지 필터 변경 — 확인창이 절대 안 뜬다 ────────────────────── */
trip(); asked = []; w.confirm = (m) => { asked.push(String(m)); return true; };
w.eval("fmSetCountry('FR');");
t('여행지만 바꿀 때는 확인창이 안 뜸(구경하는 동작과 초기화는 분리)', asked.length === 0);
t('담아 둔 장소는 절대 안 지워짐(보관함과 일정은 다른 것)', w.eval('foodMap.places.length') === 30);
t('숙소·날짜도 안 지워짐 — 필터 변경은 일정을 안 건드림',
  w.eval("(foodMap.hotel||{}).name") === '하카타호텔' && w.eval('foodMap.d1') === '2026-10-25');
t('일정이 다른 여행지 기준이라는 표시만 남음', w.eval('!!foodMap.itineraryStale') === true);
t('나라는 바뀜(필터로서)', w.eval('fmCountry()') === 'FR');
t('이전에 담아 둔 곳도 필터에서 그대로 보임(주소 근거가 있으면)', w.eval('fmFiltered().length') === 30);

/* 같은 나라로 "바꾸면" stale 이 새로 켜지지 않는다(실제로 안 바뀌었으니) */
w.eval("delete foodMap.itineraryStale;save('foodmap_v1',foodMap);fmSetCountry('FR');");
t('실제로 안 바뀌면 stale 표시도 안 켜짐', w.eval('!!foodMap.itineraryStale') === false);

/* ── 2b. 새 여행 일정 시작하기 — 명시적으로 불러야만 일어난다 ─────────── */
trip();
w.eval("fmSetCountry('FR');"); // 필터만 바꿔서 itineraryStale 켜 둔 상태로 시작
asked = []; w.confirm = (m) => { asked.push(String(m)); return true; };
w.eval('fmStartNewTrip();');
t('명시적으로 부르면 확인창이 뜸', asked.length === 1);
t('장소 개수 대신 몇 곳이 "그대로 보관"되는지 알려줌', asked[0] && asked[0].includes('30곳') && asked[0].includes('보관'));
t('백업을 먼저 받는다고 알려줌', asked[0] && asked[0].includes('백업'));
t('비우기 전에 지금 일정을 파일로 실제로 내려받음', typeof w.eval('window.__dl') === 'string');
t('백업 파일에 예산도 들어감(budget/spends/tripDays)', w.eval("(function(){var b=JSON.parse(window.__dlBody);return ('budget' in b)&&('spends' in b)&&('tripDays' in b);})()") === true);
t('담아 둔 장소는 여전히 안 지워짐', w.eval('foodMap.places.length') === 30);
t('숙소는 비워짐 (이름·좌표 없음) — 이제 진짜 초기화됨',
  !w.eval("(foodMap.hotel||{}).name") && !w.eval("(foodMap.hotel||{}).lat"));
t('거리 계산 기준점이 사라짐', w.eval('fmOrigin()') === null);
t('여행 날짜가 비워짐', !w.eval('foodMap.d1') && !w.eval('foodMap.d2'));
t('stale 표시도 꺼짐', w.eval('!!foodMap.itineraryStale') === false);
t('예산·지출도 같이 비워짐(전에는 budget_v1 이라는 존재하지 않는 키를 봐서 안 비워지고 있었다)',
  w.eval('foodMap.budget') === undefined && w.eval('(foodMap.spends||[]).length') === 0 && w.eval('foodMap.tripDays') === undefined);

/* [취소] 를 누르면 지금 것을 그대로 둔다 */
trip(); w.eval("fmSetCountry('FR');"); w.confirm = () => false;
w.eval("fmStartNewTrip();");
t('취소하면 장소가 남음', w.eval('foodMap.places.length') === 30);
t('취소하면 숙소도 남음', w.eval("(foodMap.hotel||{}).name") === '하카타호텔');

/* 백업이 실패하면 절대 비우지 않는다 */
trip(); w.eval("fmSetCountry('FR');");
w.eval("fm2Download=function(){throw new Error('다운로드 실패');};");
w.confirm = () => true;
let alerted = '';
w.alert = (m) => { alerted = String(m); };
w.eval('fmStartNewTrip();');
t('백업 실패 시 안 비워짐', w.eval("(foodMap.hotel||{}).name") === '하카타호텔');
t('백업 실패를 알려줌', /백업하지 못|다시 시도/.test(alerted));
w.eval("fm2Download=function(n,o){window.__dl=n;window.__dlBody=JSON.stringify(o);};"); w.alert = () => {};

/* ── 2c. tripHasData — 숙소·시작일 말고 코스·경비만 있어도 감지해야 함
   (2026-09-09 코드 검토) ── */
w.eval("foodMap.places=[];delete foodMap.hotel;delete foodMap.d1;delete foodMap.d2;delete foodMap.course;delete foodMap.plan;delete foodMap.budget;delete foodMap.spends;delete foodMap.tripDays;save('foodmap_v1',foodMap);");
t('숙소·날짜·코스·경비 다 없으면 일정 없음', w.eval('tripHasData()') === false);
w.eval("foodMap.course={made:'2026-01-01',stops:[]};save('foodmap_v1',foodMap);");
t('코스만 있어도 일정 있음으로 감지', w.eval('tripHasData()') === true);
w.eval("delete foodMap.course;foodMap.plan={made:'2026-01-01',plan:[]};save('foodmap_v1',foodMap);");
t('plan만 있어도 일정 있음으로 감지', w.eval('tripHasData()') === true);
w.eval("delete foodMap.plan;foodMap.budget=300000;save('foodmap_v1',foodMap);");
t('예산만 있어도 일정 있음으로 감지', w.eval('tripHasData()') === true);
w.eval("delete foodMap.budget;foodMap.spends=[{d:'2026-01-01',amt:5000,memo:'커피'}];save('foodmap_v1',foodMap);");
t('지출 기록만 있어도 일정 있음으로 감지', w.eval('tripHasData()') === true);
w.eval("delete foodMap.spends;save('foodmap_v1',foodMap);");
t('전부 지운 뒤엔 다시 일정 없음', w.eval('tripHasData()') === false);

/* ── 2d. 백업 파일 복원 — 다운로드만 하고 끝내지 않고, 실제로 다시
   불러와 복원하는 경로까지 확인한다(2026-09-09 코드 검토) ── */
trip();
w.eval("fmSetCountry('FR');"); w.confirm = () => true;
w.eval('fmStartNewTrip();');
const backupBody = w.eval('window.__dlBody');
t('백업 후 실제로 비워짐(복원 전 확인)', !w.eval("(foodMap.hotel||{}).name"));
w.confirm = () => true;
w.eval(`
  window.FileReader = class { readAsText(){ setTimeout(()=>{ this.result = window.__restoreBody; this.onload && this.onload(); }, 0); } };
  window.__restoreBody = ${JSON.stringify(backupBody)};
  const inp = { files: [{}], value: '' };
  fmRestoreTrip(inp);
`);
await new Promise((r) => setTimeout(r, 100));
t('복원하면 숙소가 되돌아옴', w.eval("(foodMap.hotel||{}).name") === '하카타호텔');
t('복원하면 날짜도 되돌아옴', w.eval('foodMap.d1') === '2026-10-25' && w.eval('foodMap.d2') === '2026-10-29');
t('복원하면 예산·지출도 되돌아옴', w.eval('foodMap.budget') === 500000 && w.eval('(foodMap.spends||[]).length') === 1);
t('복원해도 담아 둔 장소는 그대로(장소는 백업/복원 대상이 아님)', w.eval('foodMap.places.length') === 30);
t('복원 후 stale 표시는 꺼짐', w.eval('!!foodMap.itineraryStale') === false);

/* 백업 형식이 아닌 파일을 복원하려 하면 거부하고 아무것도 안 바꿈 */
trip();
let restoreAlert = '';
w.alert = (m) => { restoreAlert = String(m); };
w.eval(`
  window.__restoreBody = '{"엉뚱한":"파일"}';
  const inp = { files: [{}], value: '' };
  fmRestoreTrip(inp);
`);
await new Promise((r) => setTimeout(r, 100));
t('백업 형식이 아니면 거부함', /형식이 아닌/.test(restoreAlert));
t('거부하면 지금 일정은 안 바뀜', w.eval("(foodMap.hotel||{}).name") === '하카타호텔');
w.alert = () => {};

/* 물어보면 안 되는 때(첫 설정 중 — 일정 자체가 없음) */
asked = []; w.confirm = (m) => { asked.push(m); return true; };
w.eval("foodMap.places=[];delete foodMap.hotel;delete foodMap.d1;delete foodMap.d2;delete foodMap.course;delete foodMap.plan;delete foodMap.budget;delete foodMap.spends;delete foodMap.tripDays;foodMap.destCountry='JP';save('foodmap_v1',foodMap);fmSetCountry('TH');fmStartNewTrip();");
t('일정 자체가 없으면 새 일정 시작도 안 물어봄', asked.length === 0);

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
