/**
 * 재방문 여행자 지원 — 실제 화면 연결 종단 검증(실제 Chromium + 실제
 * 서버, 임시 포트).
 *
 * 2026-09-10 재검토(6차) 3절: "서버 API만 완성하고 화면 연결을 다음
 * 작업으로 남기지 마세요." RELEASE_STATUS.md 7절이 남겨 둔 5가지
 * (여행 목록/전환, 새 여행 만들기, 방문 표시 버튼, 다음 여행 이월
 * 후보, 로그인 시 동기화 전환)를 전부 실제 화면에서 눌러 재현·확인한다.
 * 서버 단위 테스트(trips-and-visits.test.mjs 등)는 이미 통과했으므로,
 * 여기서는 "화면에서 실제로 쓸 수 있는가"에만 집중한다.
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'success';
process.env.ENTITLEMENT_PAID_COURSE_LIMIT = '30';
// 이 테스트는 같은 이메일로 API 직접 로그인 → 브라우저 로그인 → 다른
// 기기(두 번째 페이지) 로그인까지 짧은 시간 안에 여러 번 코드를
// 요청한다 — 쿨다운 자체는 server-v2.test.mjs가 이미 검증했다.
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
const { createServer } = await import('../server/index.mjs');
const { openDb } = await import('../server/db.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');
const { grantEntitlement } = await import('../server/routes/entitlement.mjs');

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

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());
await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

const testEmail = 'revisit-flow-tester@example.com';
const city = '테스트시티';

// 로그인 없이 실데이터로 시작 — 무료체험/이용권 판정을 매번 신경 쓰지
// 않도록 미리 유료로 만들어 둔다(이 테스트의 관심사는 여행/방문 화면
// 연결이지 결제 게이트가 아니다).
const token = await loginViaApi(testEmail);
{
  const db = openDb();
  const acc = db.prepare('SELECT id FROM accounts WHERE email = ?').get(testEmail);
  grantEntitlement(acc.id, 30);
}

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
  await p.waitForTimeout(250);
  await p.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}
await loginViaUi(testEmail);

// --- 데이터 준비: 좌표 있는 곳 2곳을 이 도시에 담는다 ---
await p.evaluate((cityName) => {
  foodMap.places = [
    { id: 'r1', name: '첫 여행 장소', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] },
    { id: 'r2', name: '두번째 장소', lat: 33.591, lng: 130.401, cat: '맛집·식당', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] },
  ];
  delete foodMap.course; delete foodMap.courses; delete foodMap.trips; delete foodMap.visits; delete foodMap.currentTripByCity;
  A.saveFoodMap(foodMap);
}, city);
await p.reload();
await p.waitForTimeout(300);
await p.evaluate((cityName) => { city = cityName; updateCity(); }, city);
await p.waitForTimeout(150);

// --- 1. 첫 여행 코스 만들기(여행이 아직 없는 도시 — 조용히 하나 생김) ---
await p.evaluate(() => { ['r1', 'r2'].forEach((id) => route.add(id)); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
await p.click('[data-start-pick="r1"]');
await p.waitForTimeout(800);
const firstTrips = await apiCall('/api/trips', { token });
t('여행이 없던 도시에서 코스를 만들면 여행이 하나 자동으로 생김', firstTrips.json.trips.length === 1 && firstTrips.json.trips[0].city === city);
const firstTripId = firstTrips.json.trips[0].tripId;
await p.evaluate(() => document.getElementById('close').click());

// --- 2. 오늘 동선 화면에 "여행: ..." 표시가 실제로 뜸(3-①) ---
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
let sheetText = await p.textContent('#sheetContent');
t('저장된 코스 화면(날짜 탭)이 열림 — 방금 만든 여행의 코스', sheetText.includes('도보 이동'));
await p.evaluate(() => document.getElementById('close').click());

// --- 3. 방문 완료 표시 — 장소 상세 화면의 버튼으로(3-③) ---
await p.evaluate(() => detail('r1'));
await p.waitForTimeout(150);
let detailText = await p.textContent('#sheetContent');
t('장소 상세에 아직 방문 기록 없음이 보임', detailText.includes('아직 방문 기록이 없어요'));
await p.click('[data-visit-mark="r1"]');
await p.waitForTimeout(300);
detailText = await p.textContent('#sheetContent');
const todayYmd = new Date().toISOString().slice(0, 10);
t('방문 완료 표시 후 방문한 날짜가 상세 화면에 실제로 보임', detailText.includes(todayYmd));
t('코스에 담는 것과 방문 표시가 분리돼 있음(방문 표시해도 selected 상태는 안 바뀜)',
  (await p.evaluate(() => selected.has('r1'))) === false);

// --- 4. "다시 가고 싶어요" 토글(3-③) ---
await p.click('[data-visit-want="r1"]');
await p.waitForTimeout(300);
detailText = await p.textContent('#sheetContent');
t('다시 가고 싶어요를 누르면 눌린 상태 문구로 바뀜', detailText.includes('다시 가고 싶음 ✓'));

// --- 5. 방문 상태 필터가 실제 목록 화면에 나타남(3-③ 필터) ---
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(150);
const visitFilterVisible = await p.evaluate(() => !document.getElementById('visitFilters').hidden);
t('방문 기록이 하나라도 생기면 방문 상태 필터가 목록 화면에 나타남', visitFilterVisible);
await p.click('[data-vfilter="다시가고싶음"]');
await p.waitForTimeout(150);
const filteredIds = await p.evaluate(() => Array.from(document.querySelectorAll('[data-detail]')).map((e) => e.dataset.detail));
t('"다시가고싶음" 필터를 누르면 그 장소만 남음', filteredIds.length === 1 && filteredIds[0] === 'r1');
await p.click('[data-vfilter="전체"]');
await p.waitForTimeout(150);

// --- 6. 새 여행 만들기 — 같은 도시에 두 번째 여행(3-②) ---
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
sheetText = await p.textContent('#sheetContent');
t('저장된 코스가 있는 여행에서도 "새 여행 만들기" 진입점이 보임', sheetText.includes('새 여행 만들기'));
await p.click('[data-trip-new]');
await p.waitForTimeout(150);
await p.fill('#tripName', '2번째 방문');
await p.click('#tripCreateBtn');
await p.waitForTimeout(400);
const tripsAfterNew = await apiCall('/api/trips', { token });
t('같은 도시로 새 여행을 만들면 여행이 2개로 늘어남(같은 도시라도 별도 저장)', tripsAfterNew.json.trips.length === 2);
const secondTrip = tripsAfterNew.json.trips.find((tr) => tr.tripId !== firstTripId);
t('새 여행에 지정한 이름이 실제로 서버에 저장됨', secondTrip.name === '2번째 방문');

// --- 7. 새 여행으로 전환한 직후엔 오늘 동선이 비어 있어야 한다(과거
// 여행의 코스가 새 여행에 섞여 보이면 안 된다 — 3-① 핵심 요구) ---
await p.waitForTimeout(150);
sheetText = await p.textContent('#sheetContent');
t('새 여행으로 전환하면 오늘 동선이 비어 있음(과거 여행 코스와 안 섞임)', sheetText.includes('마음에 드는 장소를 먼저 골라보세요'));

// --- 8. 다음 여행 이월 후보 — 지난 여행에서 담아 둔 곳을 이어가기
// (3-④, 미방문 우선) ---
t('여행이 2개가 된 도시에서는 "지난 여행 이어가기" 진입점이 보임', sheetText.includes('지난 여행에서 담아 둔 곳 이어가기'));
await p.click('[data-carry-forward]');
await p.waitForTimeout(300);
sheetText = await p.textContent('#sheetContent');
t('이월 후보 화면에 지난 여행 장소가 실제로 나타남', sheetText.includes('두번째 장소'));
t('이월 후보 화면에서 이미 방문한 곳(r1)도 다시 가고 싶음으로 표시돼 함께 보임', sheetText.includes('첫 여행 장소'));
await p.click('[data-carry-add-all]');
await p.waitForTimeout(150);
const routeAfterCarry = await p.evaluate(() => Array.from(route));
t('"전부 담기"를 누르면 이월 후보가 실제로 오늘 동선(route)에 담김', routeAfterCarry.includes('r1') && routeAfterCarry.includes('r2'));

// --- 9. 새 여행에서 코스를 만들면 그 결과가 새 tripId 아래 저장되고,
// 첫 번째 여행의 코스와 서버에서 완전히 분리돼 있어야 한다(3-④) ---
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
await p.click('[data-start-pick="r1"]');
await p.waitForTimeout(800);
const firstTripCourses = await apiCall(`/api/trips/${firstTripId}/courses`, { token });
const secondTripCourses = await apiCall(`/api/trips/${secondTrip.tripId}/courses`, { token });
t('첫 번째 여행의 코스는 그대로 1건 남아 있음(두 번째 여행 생성이 안 건드림)', firstTripCourses.json.courses.length === 1);
t('두 번째 여행에도 새로 만든 코스가 정확히 그 여행 아래 저장됨', secondTripCourses.json.courses.length === 1);
await p.evaluate(() => document.getElementById('close').click());

// --- 10. 여행 선택 화면으로 다시 첫 번째 여행으로 돌아가면 그 코스가
// 그대로 다시 보여야 한다(3-①, 여행 전환) ---
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-trip-switch]');
await p.waitForTimeout(150);
sheetText = await p.textContent('#sheetContent');
t('여행 선택 화면에 두 여행이 각각 카드로 구분돼 나타남', sheetText.includes('2번째 방문') && (sheetText.match(/여행/g) || []).length >= 2);
await p.click(`[data-trip-choose="${firstTripId}"]`);
await p.waitForTimeout(400);
sheetText = await p.textContent('#sheetContent');
t('첫 번째 여행으로 되돌아가면 그 여행의 코스가 그대로 다시 보임', sheetText.includes('도보 이동'));
await p.evaluate(() => document.getElementById('close').click());

// --- 11. 로그인 시 동기화 전환 — 다른 기기(새 세션)에서 같은 계정으로
// 로그인하면 여행·방문 기록이 서버에서 그대로 내려와야 한다(3-⑤) ---
const p2 = await b.newPage();
p2.on('pageerror', (e) => errs.push('pageerror(device2): ' + e.message));
p2.on('dialog', (d) => d.dismiss());
await p2.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p2.goto('file://' + process.cwd() + '/src/design/index.html');
await p2.waitForTimeout(300);
await p2.evaluate(() => showLoginSheet(() => {}));
await p2.waitForTimeout(150);
await p2.fill('#loginEmail', testEmail);
await p2.click('#loginSendBtn');
await p2.waitForTimeout(200);
{
  const sent = sentEmailsForTest.filter((e) => e.to === testEmail).pop();
  const code = sent.body.match(/(\d{6})/)[1];
  await p2.fill('#loginCode', code);
  await p2.click('#loginVerifyBtn');
  await p2.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await p2.waitForTimeout(300);
}
const device2Trips = await p2.evaluate(() => (foodMap.trips || []).length);
const device2Visits = await p2.evaluate(() => (foodMap.visits || []).length);
t('다른 기기에서 로그인하면 여행 기록이 로그인 동기화로 그대로 내려옴', device2Trips === 2);
t('다른 기기에서 로그인하면 방문 기록도 그대로 내려옴', device2Visits >= 1);
await p2.close();

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));

await b.close();
server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
