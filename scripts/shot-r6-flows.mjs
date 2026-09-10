/**
 * 2026-09-10 재검토(6차) 6절 — "합성 데이터 모바일 스크린샷과 미리보는
 * 방법을 제공하라." 이번 6차에서 새로 화면에 연결한 것들만 찍는다 —
 * 지어낸 데이터만 쓰고(실제 장소명·개인정보 없음), 실제 iPhone 기기·
 * 실제 공급자 연결은 이 스크린샷으로 검증되는 게 아니라는 점을
 * RELEASE_STATUS.md에 별도로 명시한다(이 스크립트는 화면 자체가 실제
 * 데이터로 그려지는지만 보여준다).
 *
 * 실행: node scripts/shot-r6-flows.mjs
 * 출력: docs/screenshots/after_*.png (모바일 390x844)
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'success';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
const { createServer } = await import('../server/index.mjs');
const { openDb } = await import('../server/db.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');
const { grantEntitlement } = await import('../server/routes/entitlement.mjs');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
p.on('dialog', (d) => d.dismiss());
await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);

const email = 'shot-tester@example.com';
async function loginViaUi() {
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
await loginViaUi();
{
  const db = openDb();
  const acc = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
  grantEntitlement(acc.id, 30);
}
await p.reload();
await p.waitForTimeout(200);

const city = '가상 여행지';
await p.evaluate((cityName) => {
  foodMap.places = [
    { id: 'v1', name: '가상 카페', lat: 35.0, lng: 129.0, cat: '카페·디저트', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] },
    { id: 'v2', name: '가상 식당', lat: 35.001, lng: 129.001, cat: '맛집·식당', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] },
    { id: 'v3', name: '가상 전망대', lat: 35.002, lng: 129.002, cat: '관광·명소', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] },
  ];
  A.saveFoodMap(foodMap);
}, city);
await p.reload();
await p.waitForTimeout(200);
await p.evaluate((cityName) => { city = cityName; updateCity(); }, city);
await p.waitForTimeout(150);

// 첫 여행 코스 생성 — 여행이 자동으로 하나 생긴다.
await p.evaluate(() => { ['v1', 'v2'].forEach((id) => route.add(id)); showRoute(); });
await p.waitForTimeout(150);
await p.click('[data-build-course]');
await p.waitForTimeout(150);
await p.click('[data-start-pick="v1"]');
await p.waitForTimeout(800);
await p.evaluate(() => document.getElementById('close').click());

// 1) 방문 표시 — 장소 상세.
await p.evaluate(() => detail('v1'));
await p.waitForTimeout(150);
await p.click('[data-visit-mark="v1"]');
await p.waitForTimeout(250);
await p.click('[data-visit-want="v1"]');
await p.waitForTimeout(250);
await p.screenshot({ path: 'docs/screenshots/after_방문표시_장소상세.png' });
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(150);

// 2) 방문 상태 필터 — 목록 화면(#visitFilters가 나타남).
await p.screenshot({ path: 'docs/screenshots/after_방문상태필터_목록.png' });

// 3) 새 여행 만들기.
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-trip-new]');
await p.waitForTimeout(150);
await p.fill('#tripName', '가상 두번째 방문');
await p.screenshot({ path: 'docs/screenshots/after_새여행만들기.png' });
await p.click('#tripCreateBtn');
await p.waitForTimeout(300);

// 4) 여행 선택 화면(같은 도시, 여행 2개).
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-trip-switch]');
await p.waitForTimeout(200);
await p.screenshot({ path: 'docs/screenshots/after_여행선택.png' });
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(150);

// 5) 이월 후보 — 다음 여행 코스 만들기(미방문 우선).
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-carry-forward]');
await p.waitForTimeout(300);
await p.screenshot({ path: 'docs/screenshots/after_이월후보.png' });
await p.evaluate(() => document.getElementById('close').click());

// 6) 이용권 화면 — 포함 사용량 표시(무료체험 소진 후 뜨는 실제 경로).
await p.evaluate(() => { delete foodMap.trial; });
{
  const db = openDb();
  const acc = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
  db.prepare("UPDATE accounts SET plan = 'free', plan_expires_at = NULL WHERE id = ?").run(acc.id);
  db.prepare('INSERT OR IGNORE INTO trial_usage (account_id, consumed_at) VALUES (?, datetime())').run(acc.id);
}
await p.reload();
await p.waitForTimeout(200);
await p.evaluate((cityName) => { city = cityName; updateCity(); }, city);
await p.waitForTimeout(150);
await p.evaluate(() => { route.clear(); ['v2', 'v3'].forEach((id) => route.add(id)); showRoute(); });
await p.waitForTimeout(150);
await p.click('[data-build-course]');
await p.waitForTimeout(150);
await p.click('[data-start-pick="v2"]');
await p.waitForTimeout(600);
const sheetTitle = await p.textContent('#sheetLabel').catch(() => '');
if (sheetTitle === '이용권') {
  await p.screenshot({ path: 'docs/screenshots/after_이용권_포함사용량.png' });
  await p.evaluate(() => document.getElementById('close').click());
}

// 7) 프로필 — 잔여 횟수 표시(유료로 되돌려 표시 확인).
{
  const db = openDb();
  const acc = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
  db.exec("BEGIN");
  db.prepare("UPDATE accounts SET plan = 'paid', plan_expires_at = datetime('now', '+30 days') WHERE id = ?").run(acc.id);
  db.exec("COMMIT");
}
await p.reload();
await p.waitForTimeout(200);
await p.click('[data-profile]');
await p.waitForTimeout(300);
await p.screenshot({ path: 'docs/screenshots/after_프로필_잔여횟수.png' });
await p.evaluate(() => document.getElementById('close').click());

console.log('스크린샷 저장 완료: docs/screenshots/after_방문표시_장소상세.png 등 7장');

await b.close();
server.close();
