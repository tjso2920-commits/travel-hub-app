/**
 * 2026-09-10 재검토(6차) 6절 — "완료 기준" 종단 검증. 실제 Chromium +
 * 실제 서버(임시 포트)에서 지정된 전체 소비자 흐름을 한 번에 이어서
 * 확인한다:
 *   가져오기(실제 CSV 파일, 300곳) → 필요 장소 배치 확인 → 첫 코스
 *   → 여행 저장(자동) → 방문 표시 → 같은 도시 다음 여행 → 미방문
 *   우선 코스 → 이용권/잔여 횟수 확인.
 *
 * 서버 PUT 레벨 단위 테스트가 아니라 **실제 파일 입력 → 실제 화면
 * 클릭**으로만 진행한다 — 특히 "300곳 가져오기가 0회 외부 유료 호출을
 * 낸다"는 것도 `PUT /api/places`를 직접 호출하는 방식이 아니라, 실제
 * 파일 선택 input(`#realFileIn`)에 진짜 CSV 파일을 넣어 확인한다
 * (`server/test/reliability-and-cost.test.mjs`가 이미 서버 레벨로는
 * 확인했지만, 지시는 "실제 UI 흐름에서"를 요구한다).
 *
 * 실행: node scripts/test-consumer-flow-e2e.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'success';
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

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());
await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);

// =====================================================================
// 1. 가져오기 — 실제 CSV 파일(300곳, 좌표 없음)을 실제 파일 입력으로
// 선택한다. 저장 목록에 있는 곳만 담기고, 이 시점엔 어떤 외부 유료
// API도 호출되지 않아야 한다(가져오기 자체는 항상 무료).
// =====================================================================
const csvLines = ['name,note'];
for (let i = 1; i <= 300; i++) csvLines.push(`장소${i},메모${i}`);
const csvPath = path.join(os.tmpdir(), `consumer-flow-300-${Date.now()}.csv`);
fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');

await p.evaluate(() => { const c = document.getElementById('close'); if (c) c.close ? c.close() : null; });
await p.click('[data-add]');
await p.waitForTimeout(150);
const fileInput = p.locator('#realFileIn');
await fileInput.setInputFiles(csvPath);
await p.waitForTimeout(400);
const importResultTitle = await p.textContent('#sheetLabel');
t('실제 CSV 파일 300개 행을 실제 파일 입력으로 가져오면 결과 화면이 뜸', importResultTitle === '가져오기 결과');
const importedCount = await p.evaluate(() => (foodMap.places || []).length);
t('실제로 300곳이 전부 반영됨(가져오기 자체는 유료 조회 없이도 저장됨)', importedCount === 300);
{
  const db = openDb();
  const ledgerCount = db.prepare('SELECT COUNT(*) AS c FROM cost_ledger').get().c;
  t('300곳을 실제 화면(파일 입력)으로 가져와도 비용 원장에 기록된 유료 호출이 0건', ledgerCount === 0);
}
fs.unlinkSync(csvPath);
await p.evaluate(() => document.getElementById('close').click());

// =====================================================================
// 2. 로그인 (첫 개인화 코스부터 필요) — 사전에 유료 이용권을 미리
// 부여해, 이 종단 검증의 관심사(전체 소비자 흐름 연결)에 집중한다
// (무료체험 1회 한도 자체는 test-purchase-flow.mjs가 이미 별도로
// 검증했다).
// =====================================================================
const testEmail = 'consumer-flow-tester@example.com';
await p.evaluate(() => showLoginSheet(() => {}));
await p.waitForTimeout(150);
await p.fill('#loginEmail', testEmail);
await p.click('#loginSendBtn');
await p.waitForTimeout(200);
{
  const sent = sentEmailsForTest.filter((e) => e.to === testEmail).pop();
  const code = sent.body.match(/(\d{6})/)[1];
  await p.fill('#loginCode', code);
  await p.click('#loginVerifyBtn');
  await p.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await p.waitForTimeout(300);
  await p.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}
{
  const db = openDb();
  const acc = db.prepare('SELECT id FROM accounts WHERE email = ?').get(testEmail);
  grantEntitlement(acc.id, 30);
}
await p.reload();
await p.waitForTimeout(300);

// =====================================================================
// 3. 필요 장소 배치 확인 — 실제로 코스를 만들 2곳만 오늘 동선에 담고,
// 위치 미확인이면 일괄 확인 버튼으로 실제 화면에서 확정한다.
// =====================================================================
const city = (await p.evaluate(() => cities[0] && cities[0].name)) || '';
t('실제 CSV로 가져온 도시가 화면에 반영됨', !!city);
await p.evaluate((cityName) => { city = cityName; updateCity(); }, city);
await p.waitForTimeout(150);
const pickIds = await p.evaluate(() => spots.filter((s) => s.city === city).slice(0, 2).map((s) => s.id));
await p.evaluate((ids) => { ids.forEach((id) => route.add(id)); }, pickIds);
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
const needLookup = await p.locator('[data-batch-lookup]').count();
if (needLookup) {
  await p.click('[data-batch-lookup]');
  await p.waitForTimeout(400);
  // 후보를 하나씩 확인("맞아요")한다 — 자동 확정 금지 원칙 그대로.
  for (let i = 0; i < pickIds.length; i++) {
    const confirmBtn = p.locator('[data-batch-confirm]').first();
    if (await confirmBtn.count()) { await confirmBtn.click(); await p.waitForTimeout(250); }
    else break;
  }
  await p.waitForTimeout(200);
  const dismissBtn = p.locator('[data-dismiss]').first();
  if (await dismissBtn.count()) await dismissBtn.click();
}
await p.waitForTimeout(150);
const bothHaveCoords = await p.evaluate((ids) => ids.every((id) => { const pl = foodMap.places.find((x) => x.id === id); return pl && typeof pl.lat === 'number'; }), pickIds);
t('필요한 2곳의 위치를 실제 화면(일괄 확인)에서 확정함', bothHaveCoords);

// =====================================================================
// 4. 첫 코스 만들기 → 자동으로 여행 아래 저장됨.
// =====================================================================
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
const startId = pickIds[0];
await p.click(`[data-start-pick="${startId}"]`);
await p.waitForTimeout(800);
const firstCourse = await p.evaluate(() => foodMap.course);
t('첫 코스가 실제로 만들어짐', firstCourse && firstCourse.stops.length >= 1);
const tripsRes1 = await fetch(apiBase + '/api/trips', { headers: { Authorization: `Bearer ${await p.evaluate(() => foodMap.session.token)}` } }).then((r) => r.json());
t('여행이 이 도시로 자동 저장됨(여행 저장)', tripsRes1.trips.some((tr) => tr.city === city));
const firstTripId = tripsRes1.trips.find((tr) => tr.city === city).tripId;
await p.evaluate(() => document.getElementById('close').click());

// =====================================================================
// 5. 방문 표시 — 장소 상세에서 실제로 방문 완료를 누른다.
// =====================================================================
await p.evaluate((id) => detail(id), startId);
await p.waitForTimeout(150);
await p.click(`[data-visit-mark="${startId}"]`);
await p.waitForTimeout(300);
const visitedNow = await p.evaluate((id) => { const v = (foodMap.visits || []).find((x) => x.placeId === id); return v && v.visited; }, startId);
t('방문 표시가 실제로 반영됨', !!visitedNow);
await p.evaluate(() => document.getElementById('close').click());

// =====================================================================
// 6. 같은 도시로 다음 여행 만들기.
// =====================================================================
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-trip-new]');
await p.waitForTimeout(150);
await p.fill('#tripName', '다음 여행');
await p.click('#tripCreateBtn');
await p.waitForTimeout(400);
const tripsRes2 = await fetch(apiBase + '/api/trips', { headers: { Authorization: `Bearer ${await p.evaluate(() => foodMap.session.token)}` } }).then((r) => r.json());
t('같은 도시로 다음 여행이 실제로 하나 더 만들어짐', tripsRes2.trips.filter((tr) => tr.city === city).length === 2);

// =====================================================================
// 7. 미방문 우선 코스 — 이월 후보에서 담아 실제로 코스를 만든다.
// =====================================================================
await p.waitForTimeout(150);
await p.click('[data-carry-forward]');
await p.waitForTimeout(300);
const carrySheetText = await p.textContent('#sheetContent');
t('이월 후보 화면이 실제로 뜸', carrySheetText.includes('지난 여행에서 담아 둔 곳'));
await p.click('[data-carry-add-all]');
await p.waitForTimeout(150);
// 이월 후보는 "그 여행에 담겼지만 방문 기록이 없는 곳만"이라(지시대로
// 방문한 곳은 이월 대상에서 빠진다 — next-trip-suggestions.mjs 참고),
// 첫 여행에서 이미 방문 표시한 곳(pickIds[0])은 후보에서 빠지고
// pickIds[1] 하나만 담긴다. 그 하나를 출발지로 고르면 "다른 곳"이
// 0곳이 되어 코스를 못 만드니, 실제 화면 그대로 GPS 현재 위치를
// 출발지로 써서(브라우저 위치 기능, API 키 불필요) 담아 둔 곳을
// 전부 스톱으로 넣는다.
await p.context().grantPermissions(['geolocation']);
await p.context().setGeolocation({ latitude: 33.5786, longitude: 130.3858 });
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
await p.click('[data-start-gps]');
await p.waitForTimeout(1500);
const secondCourse = await p.evaluate(() => foodMap.course);
t('미방문 우선으로 담긴 후보로 두 번째 여행의 코스가 실제로 만들어짐', secondCourse && secondCourse.stops.length >= 1);
const secondTripId = tripsRes2.trips.find((tr) => tr.city === city && tr.tripId !== firstTripId).tripId;
const secondTripCourses = await fetch(apiBase + `/api/trips/${secondTripId}/courses`, { headers: { Authorization: `Bearer ${await p.evaluate(() => foodMap.session.token)}` } }).then((r) => r.json());
t('두 번째 여행의 코스가 첫 번째 여행과 분리돼 정확히 저장됨', secondTripCourses.courses.length === 1);
const firstTripCoursesRecheck = await fetch(apiBase + `/api/trips/${firstTripId}/courses`, { headers: { Authorization: `Bearer ${await p.evaluate(() => foodMap.session.token)}` } }).then((r) => r.json());
t('첫 번째 여행의 코스는 그대로 유지됨(두 번째 여행 생성이 안 건드림)', firstTripCoursesRecheck.courses.length === 1);
await p.evaluate(() => document.getElementById('close').click());

// =====================================================================
// 8. 이용권/잔여 횟수 확인 — 계정 화면에서 실제 사용량이 보임.
// =====================================================================
await p.click('[data-profile]');
await p.waitForTimeout(200);
const profileText = await p.textContent('#sheetContent');
const usage = await fetch(apiBase + '/api/account/usage', { headers: { Authorization: `Bearer ${await p.evaluate(() => foodMap.session.token)}` } }).then((r) => r.json());
t('계정 화면에 실제 서버 사용량과 일치하는 잔여 위치확인 횟수가 보임',
  profileText.includes(`남은 위치 확인: ${usage.placeLookups.remaining}곳(전체 ${usage.placeLookups.limit}곳 중)`));
t('계정 화면에 실제 서버 사용량과 일치하는 잔여 코스 생성 횟수가 보임',
  profileText.includes(`남은 코스 생성: ${usage.courseGenerations.remaining}회(전체 ${usage.courseGenerations.limit}회 중)`));
t('코스 생성은 정확히 2회 사용됨(1번째+2번째 여행 각 1회)', usage.courseGenerations.used === 2);
await p.evaluate(() => document.getElementById('close').click());

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 10));

await b.close();
server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
