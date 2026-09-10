/**
 * 계정별 서버 저장 동기화 종단 검증 — 실제 Chromium + 실제 서버(임시 포트).
 *
 * 2026-09-10 재검토(3차) 지시 ⑤의 마지막 항목: "장소 보관함과 날짜별
 * 일정을 계정별 서버 저장과 연결하고, 로그인/로그아웃/계정 전환 시
 * 절대 다른 계정의 로컬 데이터가 섞이지 않게 하라 — 손님 데이터
 * 보존과 다른 기기 데이터 병합도 포함." 지금까지는 이 부분(로그인
 * 병합·로그아웃 격리·계정 전환)에 대한 전용 검증이 없었다 — 이 파일이
 * 그 공백을 채운다.
 *
 * 시나리오:
 * 1. 계정 A가 "다른 기기"에서 이미 서버에 장소·코스를 올려 뒀다고
 *    가정(브라우저 없이 API로 직접 시뮬레이션).
 * 2. 이 기기(브라우저)는 로그인 전 손님 데이터를 갖고 있다.
 * 3. 계정 A로 로그인하면 손님 데이터도, 다른 기기 데이터도 둘 다
 *    안 잃고 합쳐져야 한다(병합 결과가 다시 서버에도 반영돼야 함).
 * 4. 로그아웃하면 이 기기에서 로컬 데이터가 사라져야 한다(단, 서버엔
 *    남아 있으니 데이터 유실은 아님).
 * 5. 다른 계정 B로 로그인하면 A의 데이터가 전혀 보이면 안 된다(계정
 *    전환 시 데이터 누출 금지).
 * 6. 다시 A로 로그인하면 그동안의 데이터가 그대로 복원돼야 한다.
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
// 이 테스트는 같은 이메일(A)로 API 직접 로그인 → 브라우저 로그인 →
// 로그아웃 → 재로그인까지 짧은 시간 안에 여러 번 로그인 코드를
// 요청한다 — 실제 쿨다운 자체는 server-v2.test.mjs에서 이미 따로
// 검증했으므로 여기서는 계정 동기화 시나리오에 집중한다.
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

async function apiCall(pathname, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiBase + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}
async function loginViaApi(email) {
  await apiCall('/api/auth/request-code', { method: 'POST', body: { email } });
  const sent = sentEmailsForTest.filter((e) => e.to === email).pop();
  const code = sent.body.match(/(\d{6})/)[1];
  const r = await apiCall('/api/auth/verify-code', { method: 'POST', body: { email, code } });
  return r.json.token;
}

// --- 계정 없이 접근하면 401 ---
{
  const r = await apiCall('/api/places');
  t('로그인 없이 /api/places 조회는 401', r.status === 401);
}

// --- 1. 계정 A가 "다른 기기"에서 이미 서버에 데이터를 올려 뒀다고
// 가정한다(브라우저 없이, 직접 API로) ---
const emailA = 'sync-tester-a@example.com';
const tokenA = await loginViaApi(emailA);
await apiCall('/api/places', { method: 'PUT', token: tokenA, body: { places: [{ id: 's1', name: '다른기기장소', lat: 33.6, lng: 130.4, cat: '카페·디저트', sourceLists: [] }] } });
await apiCall('/api/courses', { method: 'PUT', token: tokenA, body: { courses: [{ city: '후쿠오카', date: '2026-01-01', stops: [], mode: 'walking' }] } });

// --- 2. 이 기기(브라우저)에는 로그인 전 손님 데이터가 있다 ---
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());

/* 이 테스트는 로그인 뒤 daGateThenBuildCourseSheet처럼 화면을 이어가는
   onSuccess가 아니라 빈 콜백을 넘긴다(코스 만들기 화면까지는 관심사가
   아니므로) — 그래서 로그인 성공 뒤에도 시트 라벨(#sheetLabel)은 그대로
   "코드 확인"으로 남는다(onSuccess가 새 시트를 열지 않으니까). 대신
   실제 로그인·병합 완료 신호로 foodMap.session이 채워지는 걸 기다린다. */
async function loginViaUi(email) {
  await p.evaluate(() => showLoginSheet(() => {}));
  await p.waitForTimeout(150);
  await p.fill('#loginEmail', email);
  await p.click('#loginSendBtn');
  await p.waitForTimeout(200);
  const sent = sentEmailsForTest.filter((e) => e.to === email).pop();
  const code = sent.body.match(/(\d{6})/)[1];
  await p.fill('#loginCode', code);
  await p.click('#loginVerifyBtn');
  await p.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await p.waitForTimeout(200);
  await p.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}
async function logoutViaUi() {
  await p.evaluate(() => document.querySelector('[data-profile]').click());
  await p.waitForTimeout(150);
  await p.evaluate(() => document.querySelector('[data-logout]').click());
  await p.waitForFunction(() => !foodMap.session, { timeout: 5000 });
  await p.waitForTimeout(150);
}

await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);
await p.evaluate(() => {
  foodMap.places = [{ id: 'g1', name: '손님장소', lat: 33.59, lng: 130.39, cat: '맛집·식당', sourceLists: [] }];
  delete foodMap.session; delete foodMap.courses;
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);

// --- 3. 계정 A로 로그인하면 손님 데이터 + 다른 기기 데이터가 둘 다
// 남아야 한다 ---
await loginViaUi(emailA);
await p.waitForTimeout(300);

const placesAfterMerge = await p.evaluate(() => (foodMap.places || []).map((x) => x.id).sort());
t('로그인 후 손님 데이터(g1)와 다른 기기 데이터(s1)가 둘 다 남음', JSON.stringify(placesAfterMerge) === JSON.stringify(['g1', 's1']));
const coursesAfterMerge = await p.evaluate(() => (foodMap.courses || []).map((c) => c.city + '|' + c.date));
t('다른 기기에서 올려 둔 코스도 병합됨', coursesAfterMerge.includes('후쿠오카|2026-01-01'));

// --- 병합 결과가 다시 서버에도 반영돼야 한다(이 기기의 손님 데이터가
// 다른 기기에서도 보이려면) ---
await p.waitForTimeout(300);
const serverPlacesAfterMerge = await apiCall('/api/places', { token: tokenA });
const serverPlaceIds = (serverPlacesAfterMerge.json.places || []).map((x) => x.id).sort();
t('병합 뒤 손님 데이터(g1)가 서버에도 다시 올라감(다른 기기에서도 보이게)', JSON.stringify(serverPlaceIds) === JSON.stringify(['g1', 's1']));

// --- 4. 로그아웃하면 이 기기에서 로컬 데이터가 사라진다(서버엔 남음) ---
await p.evaluate(() => document.querySelector('[data-profile]').click());
await p.waitForTimeout(150);
const profileHtml = await p.textContent('#sheetContent');
t('로그인 상태 프로필에 로그아웃 버튼이 있음', profileHtml.includes('로그아웃'));
await logoutViaUi();
const afterLogout = await p.evaluate(() => ({ session: foodMap.session, places: foodMap.places, courses: foodMap.courses }));
t('로그아웃 후 세션이 로컬에서 지워짐', !afterLogout.session);
t('로그아웃 후 장소 목록이 로컬에서 지워짐(다음 계정과 안 섞이게)', !afterLogout.places || afterLogout.places.length === 0);
t('로그아웃 후 코스 목록도 로컬에서 지워짐', !afterLogout.courses || afterLogout.courses.length === 0);
const usingSampleAfterLogout = await p.evaluate(() => usingSample);
t('로그아웃 후 샘플 컬렉션 상태로 돌아감', usingSampleAfterLogout === true);

// --- 5. 다른 계정 B로 로그인하면 A의 데이터가 전혀 보이면 안 된다 ---
const emailB = 'sync-tester-b@example.com';
await loginViaUi(emailB);
await p.waitForTimeout(300);
const placesForB = await p.evaluate(() => (foodMap.places || []).map((x) => x.id));
t('처음 로그인하는 계정 B에는 계정 A의 데이터가 전혀 안 보임(계정 전환 시 데이터 누출 금지)', placesForB.length === 0);
await logoutViaUi();

// --- 6. 다시 계정 A로 로그인하면 데이터가 그대로 복원된다 ---
await loginViaUi(emailA);
await p.waitForTimeout(300);
const placesRestored = await p.evaluate(() => (foodMap.places || []).map((x) => x.id).sort());
t('다시 로그인하면 이전 데이터(g1, s1)가 그대로 복원됨(기기가 아니라 계정에 저장된 것)', JSON.stringify(placesRestored) === JSON.stringify(['g1', 's1']));

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));

await b.close();
server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
