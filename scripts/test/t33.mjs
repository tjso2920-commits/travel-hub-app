/**
 * 정품 등록 검사.
 *
 * 이 장치의 목적은 복제를 막는 게 아니다(파일 안에서 끝나므로 못 막는다).
 * 목적은 두 가지고, 그 둘만 검사한다.
 *   1. 산 사람 이름이 화면·공유카드·백업에 확실히 찍히는가
 *   2. 무료판 한도가 동작하되 **이미 담아 둔 장소를 절대 건드리지 않는가**
 *
 * 덤으로 아무 문자열이나 넣으면 안 열리는지, 이름만 바꿔치기한 코드가 걸리는지 본다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const html = fs.readFileSync(file, 'utf8');
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errs.push(e.message));
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; await new Promise((r) => setTimeout(r, 700));
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
w.alert = () => {}; w.confirm = () => true; w.Element.prototype.scrollIntoView = function () {};
const d = w.document;
const isSale = w.eval('SALE_MODE') === true;
console.log('   대상:', isSale ? '판매용(구매자)' : '개인용(판매자)');

t('런타임 오류 0', errs.length === 0);

/* ── 코드 만들기 → 확인 왕복 ─────────────────────────────────────────── */
const code = w.eval("licMake('홍길동','2026-08-03')");
t('코드가 만들어짐', typeof code === 'string' && code.length > 10);
t('코드에 점 구분자', code.indexOf('.') > 0);
const parsed = w.eval('licParse(' + JSON.stringify(code) + ')');
t('한글 이름 왕복', parsed && parsed.name === '홍길동');
t('구매일 왕복', parsed && parsed.date === '2026-08-03');

/* 아무 문자열은 안 열려야 한다 */
for (const junk of ['', '아무말', 'abc.def', code.slice(0, -1), code + 'x']) {
  t('가짜 코드 거부: ' + (junk || '(빈칸)'), w.eval('licParse(' + JSON.stringify(junk) + ')') === null);
}
/* 남의 코드에서 이름만 바꿔치기 — 서명이 안 맞아야 한다 */
const other = w.eval("licMake('김철수','2026-08-03')");
const swapped = other.split('.')[0] + '.' + code.split('.')[1];
t('이름 바꿔치기 거부', w.eval('licParse(' + JSON.stringify(swapped) + ')') === null);
t('서로 다른 이름은 서로 다른 코드', code !== other);

/* ── 무료판 한도 ─────────────────────────────────────────────────────── */
w.eval("delete foodMap.lic; foodMap.places=[]; renderFoodMap();");
t('등록 전 상태', w.eval('licOn()') === false);

if (isSale) {
  t('판매용은 한도 있음', w.eval('licLimited()') === true);
  t('빈 상태 여유는 한도만큼', w.eval('licRoom()') === w.eval('FREE_LIMIT'));

  /* 한도의 두 배를 한 번에 넣어 본다 */
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ name: '가게' + i, note: '', address: '', url: 'u' + i, lat: null, lng: null });
  const z = w.fmMerge(many);
  const LIMIT = w.eval('FREE_LIMIT');
  t('한도까지만 담김', w.eval('foodMap.places.length') === LIMIT);
  t('넘친 개수를 알려줌', z.blocked === 60 - LIMIT);
  t('한 곳도 더 못 담음', w.eval('licRoom()') === 0);

  /* 한도를 넘긴 뒤에도 담아 둔 것은 그대로 있어야 한다 */
  w.eval("renderFoodMap()");
  t('담아 둔 장소는 안 지워짐', w.eval('foodMap.places.length') === LIMIT);

  /* 등록하면 풀린다 */
  d.getElementById('licIn') || w.eval('renderSettings()');
  w.eval("foodMap.lic=licParse(" + JSON.stringify(code) + "); save('foodmap_v1',foodMap); renderFoodMap();");
  t('등록 후 한도 없음', w.eval('licLimited()') === false);
  /* 같은 이름은 '갱신' 으로 잡히므로 새 이름으로 넣어야 '추가' 를 센다 */
  const more = [];
  for (let i = 0; i < 60; i++) more.push({ name: '새가게' + i, note: '', address: '', url: 'v' + i, lat: null, lng: null });
  const z2 = w.fmMerge(more);
  t('등록 후 전부 담김', z2.added === 60 && z2.blocked === 0);
  t('등록 후 한도 없음(합계)', w.eval('foodMap.places.length') === LIMIT + 60);
} else {
  t('개인용은 한도 없음', w.eval('licLimited()') === false);
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ name: '가게' + i, note: '', address: '', url: 'u' + i, lat: null, lng: null });
  const z = w.fmMerge(many);
  t('개인용은 전부 담김', z.added === 60 && z.blocked === 0);
  w.eval("foodMap.lic=licParse(" + JSON.stringify(code) + "); save('foodmap_v1',foodMap); renderFoodMap();");
}

/* ── 이름이 실제로 찍히는가 ──────────────────────────────────────────── */
t('등록됨 판정', w.eval('licOn()') === true);
t('이름표 문구', w.eval('licStamp()').includes('홍길동') && w.eval('licStamp()').includes('2026-08-03'));
const bar = d.getElementById('licBar');
t('화면 아래 이름줄 존재', !!bar);
t('화면 아래에 이름이 뜸', bar.textContent.includes('홍길동'));

w.eval('renderSettings()');
const setup = d.getElementById('licSetup');
t('설정에 정품 칸 존재', !!setup);
t('설정에 이름이 뜸', setup.textContent.includes('홍길동'));

/* 판매자 전용 코드 생성기는 구매자에게 보이면 안 된다 */
if (isSale) {
  t('구매자에게 코드 생성기 없음', d.getElementById('licGenName') === null);
  t('구매자 화면에 판매자 전용 문구 없음', !setup.textContent.includes('판매자 전용'));
} else {
  t('판매자에게 코드 생성기 있음', d.getElementById('licGenName') !== null);
}

/* ── 백업 파일에 코드가 들어가면 안 된다 ─────────────────────────────── */
const bk = w.eval('JSON.stringify(bkFoodMap())');
t('백업에 코드 없음', !bk.includes(code));
t('백업에 lic 필드 없음', JSON.parse(bk).lic === undefined);
t('백업에 이름은 남음', String(JSON.parse(bk).licensedTo || '').includes('홍길동'));

/* 등록을 지워도 담아 둔 장소는 살아 있어야 한다 */
const before = w.eval('foodMap.places.length');
w.eval('licClear()');
t('등록 지움', w.eval('licOn()') === false);
t('지워도 장소는 그대로', w.eval('foodMap.places.length') === before);

t('최종 런타임 오류 0', errs.length === 0);
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
