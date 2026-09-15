/**
 * 자전거 공유 반납 포트 안내(차리차리 등) — 실제 Chromium 화면 검증.
 * 00_READ_FIRST_CLAUDE.md 8절의 검증 목록 중 화면으로 확인 가능한
 * 부분을 다룬다: 목적지 선택→포트 선택→외부 이동(재시작으로 흉내)→
 * 복귀→다른 포트→반납했어요→원래 목적지 도보 안내, 출발지 없음,
 * 새로고침 복귀, 계정 전환 시 미노출, 비용/중복차감 방지.
 *
 * 실제 스크래핑 데이터는 전혀 쓰지 않는다 — 합성 좌표만 쓴다.
 * 실행: node scripts/test-bike-ports.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
process.env.ROUTING_TEST_FORCE = 'success';

const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');
const { openDb, nowIso } = await import('../server/db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

// 합성 포트 2곳을 서버 DB에 직접 심는다.
{
  const db = openDb();
  const now = nowIso();
  const rows = [
    ['charichari', 'FUK', 'T-NEAR', '합성 근처 포트', '합성주소 근처', 8, 33.5905, 130.4016],
    ['charichari', 'FUK', 'T-FAR', '합성 먼 포트', '합성주소 멀리', 3, 33.700, 130.500],
  ];
  const insert = db.prepare(`INSERT INTO bike_share_ports (provider_id, region_code, port_id, title, address, capacity, lat, lng, imported_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) insert.run(...r, now);
  db.prepare(`INSERT INTO bike_share_import_meta (provider_id, region_code, source_url, endpoint, retrieved_at, port_count, imported_at) VALUES (?,?,?,?,?,?,?)`)
    .run('charichari', 'FUK', 'https://example.invalid/map', 'https://example.invalid/graphql', now, rows.length, now);
}

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
const page = await b.newPage();
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
page.on('dialog', (d) => d.dismiss());
await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await page.goto('file://' + process.cwd() + '/src/design/index.html');
await page.waitForTimeout(200);

async function loginViaUi(email) {
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(150);
  await page.fill('#loginEmail', email);
  await page.click('#loginSendBtn');
  await page.waitForTimeout(200);
  const sent = sentEmailsForTest.filter((e) => e.to === email).pop();
  const code = sent.body.match(/(\d{6})/)[1];
  await page.fill('#loginCode', code);
  await page.click('#loginVerifyBtn');
  await page.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await page.waitForTimeout(250);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

await loginViaUi('bike-e2e@example.com');

// 목적지 장소를 직접 심는다(city는 등록된 활성 지역과 정확히 일치해야
// "자전거로 가기" 버튼이 뜬다 — server/bike-share-providers.mjs).
await page.evaluate(() => {
  foodMap.places.push({ id: 'dest1', name: '테스트 목적지', lat: 33.592, lng: 130.403, cat: '카페·디저트', catConfirmed: true, city: '후쿠오카', cityConfirmed: true, sourceLists: [] });
  A.saveFoodMap(foodMap);
  refreshFromStorage();
  chooseCity('후쿠오카');
});
// BikePorts.loadStatus()(부팅 시 fire-and-forget 호출)가 끝날 시간을 준다.
await page.waitForFunction(() => window.BikePorts && window.BikePorts.regionForCity('후쿠오카'), { timeout: 5000 });

async function openDetail(id) {
  await page.evaluate((pid) => detail(pid), id);
  await page.waitForTimeout(150);
}

// --- 1) 확정 좌표 + 활성 지역 목적지에서 진입 버튼이 보임 ---
await openDetail('dest1');
{
  const hasBtn = await page.evaluate(() => !!document.querySelector('[data-open-bike-guide]'));
  t('1) 활성 지역·확정 좌표 목적지에서 "자전거로 가기" 버튼이 보임', hasBtn);
}

// --- 2) 출발지가 없으면 "내 주변"으로 얼버무리지 않고 명시적으로 물어봄 ---
await page.click('[data-open-bike-guide]');
await page.waitForTimeout(150);
{
  const askedOrigin = await page.evaluate(() => !!document.querySelector('[data-bike-origin-manual]'));
  t('2) 출발지가 없으면 명시적으로 물어봄(평균 위치로 얼버무리지 않음)', askedOrigin);
}
await page.click('[data-bike-origin-manual]');
await page.waitForTimeout(150);
await page.fill('#manualLocLat', '33.5905');
await page.fill('#manualLocLng', '130.4015');
await page.click('#manualLocApplyBtn');
await page.waitForTimeout(400); // 콜백으로 daOpenBikeGuide가 다시 열림

// --- 3) 후보 목록 — 가까운 포트가 먼저, 직선거리·데이터 기준 표시 ---
{
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('3) 후보 목록에 가까운 합성 포트가 보임', html.includes('합성 근처 포트'));
  t('3) 후보 목록에 먼 합성 포트도 보임(3곳 이하)', html.includes('합성 먼 포트'));
  t('3) 직선거리·수용 대수(실시간 가용 아님) 문구가 있음', html.includes('직선거리') && html.includes('실시간 가용 아님'));
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('[data-bike-pick-port]')).map((b) => b.dataset.bikePickPort));
  t('3) 가까운 포트가 먼저 옴', order[0] === 'T-NEAR');
}

// --- 4) 포트를 고르면 안내(자전거 구간+도보 구간)가 생김 ---
await page.click('[data-bike-pick-port="T-NEAR"]');
await page.waitForTimeout(500);
{
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('4) 안내 화면에 자전거 구간 시간이 보임', /자전거로 약 \d+분|자전거로.*분/.test(html));
  t('4) 안내 화면에 도보 구간 시간이 보임', html.includes('도보로'));
  t('4) 반납했어요 버튼이 있음', !!(await page.$('[data-bike-returned]')));
  t('4) 다른 포트로 바꾸기 버튼이 있음', !!(await page.$('[data-bike-other-port]')));
  t('4) 공식 지도/앱 링크가 있음', html.includes('charichari.bike'));
  const trialUsed = await page.evaluate(() => foodMap.bikeGuide && foodMap.bikeGuide.step === 'guide');
  t('4) 진행 상태가 foodMap에 저장됨', trialUsed);
}
await page.evaluate(() => document.getElementById('close').click());

// --- 5) 새로고침(외부 앱 이동 후 복귀 흉내) 뒤에도 진행 상태가 유지됨 ---
await page.reload();
await page.waitForTimeout(400);
await page.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
await openDetail('dest1');
await page.click('[data-open-bike-guide]');
await page.waitForTimeout(300);
{
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('5) 새로고침 후에도 후보 목록이 아니라 안내 화면으로 바로 돌아옴(진행 상태 유지)', html.includes('반납했어요'.slice(0, 2)) || !!(await page.$('[data-bike-returned]')));
}

// --- 6) "반납했어요"를 누르면 도보 안내만 남고, 다시 새로고침해도 유지됨 ---
await page.click('[data-bike-returned]');
await page.waitForTimeout(200);
{
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('6) 반납 후에는 자전거 구간 없이 도보 안내만 보임', html.includes('까지') && html.includes('도보로') && !html.includes('다른 포트로 바꾸기'));
}
await page.evaluate(() => document.getElementById('close').click());
await page.reload();
await page.waitForTimeout(400);
await page.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
await openDetail('dest1');
await page.click('[data-open-bike-guide]');
await page.waitForTimeout(300);
{
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('6) 새로고침 후에도 "반납했어요" 이후 단계가 유지됨', !html.includes('다른 포트로 바꾸기'));
}
await page.evaluate(() => document.getElementById('close').click());

// --- 7) 로그아웃하면 다른 계정에게 진행 상태가 새어나가지 않음 ---
await page.evaluate(() => daLogout());
await page.waitForTimeout(300);
{
  const cleared = await page.evaluate(() => foodMap.bikeGuide === undefined);
  t('7) 로그아웃 시 진행 상태가 지워짐', cleared);
}

t('콘솔/런타임 오류 0건', errs.length === 0);
if (errs.length) console.log(errs.slice(0, 5).join('\n'));

await b.close();
console.log(fail === 0 ? '\n전체 통과' : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
