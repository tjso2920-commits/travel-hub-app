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
const { setTestAccessByEmail } = await import('../server/routes/entitlement.mjs');

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
// 2026-09-16 재검토 5절 — 실제 포트 데이터는 승인된 테스트 계정에만
// 보이므로, 이 화면 검증 계정을 운영자가 승인했다고 가정한다(일반
// 계정 차단 자체는 별도 8절에서 확인).
setTestAccessByEmail('bike-e2e@example.com', true);

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
  t('4) 공식 웹지도 링크가 있음(앱 실행처럼 표현하지 않음)', html.includes('공식 웹지도에서 보기') && html.includes('charichari.bike'));
  // 2026-09-16 재검토 1절 — 자전거·도보 각 구간에 실제 좌표·이동수단이
  // 들어간 길찾기 버튼이 있어야 한다.
  t('4) 자전거 길찾기 링크가 출발지→포트 좌표로 정확히 만들어짐', html.includes('자전거 길찾기 보기') && html.includes('origin=33.5905,130.4015') && html.includes('destination=33.5905,130.4016') && html.includes('travelmode=bicycling'));
  t('4) 도보 길찾기 링크가 포트→목적지 좌표로 정확히 만들어짐', html.includes('도보 길찾기 보기') && html.includes('origin=33.5905,130.4016') && html.includes('destination=33.592,130.403') && html.includes('travelmode=walking'));
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
  t('6) 반납 완료 화면에도 도보 길찾기 버튼이 있음', html.includes('도보 길찾기 보기') && html.includes('travelmode=walking'));
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

// --- 8) 2026-09-16 재검토 2절 — "다른 포트로 바꾸기"는 실행 전에
// 추가 차감 가능성을 명확히 안내해야 한다 ---
await loginViaUi('bike-e2e-recalc@example.com');
setTestAccessByEmail('bike-e2e-recalc@example.com', true);
await page.evaluate(() => {
  foodMap.places.push({ id: 'dest2', name: '재계산 테스트 목적지', lat: 33.592, lng: 130.403, cat: '카페·디저트', catConfirmed: true, city: '후쿠오카', cityConfirmed: true, sourceLists: [] });
  A.saveFoodMap(foodMap);
  refreshFromStorage();
});
await page.waitForFunction(() => window.BikePorts && window.BikePorts.regionForCity('후쿠오카'), { timeout: 5000 });
await openDetail('dest2');
await page.click('[data-open-bike-guide]');
await page.waitForTimeout(150);
await page.click('[data-bike-origin-manual]');
await page.waitForTimeout(150);
await page.fill('#manualLocLat', '33.5905');
await page.fill('#manualLocLng', '130.4015');
await page.click('#manualLocApplyBtn');
await page.waitForTimeout(400);
await page.click('[data-bike-pick-port="T-NEAR"]'); // 첫 안내 — 무료체험 소진
await page.waitForTimeout(500);
await page.click('[data-bike-other-port]');
await page.waitForTimeout(300);
{
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('8) 다른 포트로 바꾸기로 들어오면 추가 차감 가능성을 실행 전에 안내함', html.includes('추가로 사용될 수 있어요'));
}
await page.click('[data-bike-pick-port="T-FAR"]'); // 두 번째 포트 — 새 작업이라 무료체험 이미 소진 상태로 거절돼야 함
await page.waitForTimeout(400);
{
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('8) 실제로 다른 포트를 고르면 새 작업으로 취급돼 이용권이 필요하다고 안내됨(경고가 사실과 일치)', html.includes('이용권이 필요해요'));
}
await page.evaluate(() => document.getElementById('close').click());
await page.evaluate(() => daLogout());
await page.waitForTimeout(200);

// --- 9) 2026-09-16 재검토 4절 — 응답 유실 후 재시도는 같은 요청
// 키·본문을 재사용해 다시 차감되지 않아야 한다 ---
await loginViaUi('bike-e2e-retry@example.com');
setTestAccessByEmail('bike-e2e-retry@example.com', true);
await page.evaluate(() => {
  foodMap.places.push({ id: 'dest3', name: '재시도 테스트 목적지', lat: 33.592, lng: 130.403, cat: '카페·디저트', catConfirmed: true, city: '후쿠오카', cityConfirmed: true, sourceLists: [] });
  A.saveFoodMap(foodMap);
  refreshFromStorage();
});
await page.waitForFunction(() => window.BikePorts && window.BikePorts.regionForCity('후쿠오카'), { timeout: 5000 });
await openDetail('dest3');
await page.click('[data-open-bike-guide]');
await page.waitForTimeout(150);
await page.click('[data-bike-origin-manual]');
await page.waitForTimeout(150);
await page.fill('#manualLocLat', '33.5905');
await page.fill('#manualLocLng', '130.4015');
await page.click('#manualLocApplyBtn');
await page.waitForTimeout(400);

const guideBodies = [];
await page.route('**/api/bike-ports/guide', async (route) => {
  guideBodies.push(route.request().postDataJSON());
  if (guideBodies.length === 1) { await route.abort('failed'); return; } // 첫 시도는 응답 유실을 흉내
  await route.continue();
});
await page.click('[data-bike-pick-port="T-NEAR"]');
await page.waitForTimeout(400);
const keyAfterFailure = await page.evaluate(() => foodMap.bikeGuide && foodMap.bikeGuide.pendingKey);
t('9) 응답 유실 후에도 크래시 없이 실패 안내로 이어짐', !!(await page.$('[data-dismiss]')));
t('9) 실패해도 재시도용 요청 키가 저장돼 있음', typeof keyAfterFailure === 'string' && keyAfterFailure.length > 0);
await page.evaluate(() => document.getElementById('close').click());
await openDetail('dest3');
await page.click('[data-open-bike-guide]'); // 재시도 — daOpenBikeGuide가 기존 pendingSignature를 다시 candidates로 안내
await page.waitForTimeout(300);
await page.click('[data-bike-pick-port="T-NEAR"]'); // 같은 포트를 다시 고름 — 같은 서명이라 pendingKey가 재사용돼야 함
await page.waitForTimeout(500);
await page.unroute('**/api/bike-ports/guide');
{
  t('9) 응답 유실 뒤 재시도가 실제로 같은 idempotencyKey를 재사용함', guideBodies.length === 2 && guideBodies[0].idempotencyKey === guideBodies[1].idempotencyKey);
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('9) 재시도가 성공하면 정상 안내 화면으로 이어짐', html.includes('반납했어요'));
  const token = await page.evaluate(() => foodMap.session.token);
  const usageRes = await fetch(`${apiBase}/api/account/usage`, { headers: { Authorization: `Bearer ${token}` } });
  const usage = await usageRes.json();
  t('9) 응답 유실 뒤 재시도해도 사용량은 1회로만 늘어남(재차감 없음)', usage.courseGenerations && usage.courseGenerations.used === 1);
}
await page.evaluate(() => document.getElementById('close').click());
await page.evaluate(() => daLogout());
await page.waitForTimeout(200);

// --- 10) 2026-09-16 재검토 5절 — 승인 안 된 일반 계정은 실제 포트
// 데이터를 화면에서도 못 봄(공식 웹지도 안내로만 대체) ---
await loginViaUi('bike-e2e-blocked@example.com'); // test_access 부여 안 함(일반 계정)
await page.evaluate(() => {
  foodMap.places.push({ id: 'dest4', name: '차단 테스트 목적지', lat: 33.592, lng: 130.403, cat: '카페·디저트', catConfirmed: true, city: '후쿠오카', cityConfirmed: true, sourceLists: [] });
  A.saveFoodMap(foodMap);
  refreshFromStorage();
});
await page.waitForFunction(() => window.BikePorts && window.BikePorts.regionForCity('후쿠오카'), { timeout: 5000 });
await openDetail('dest4');
await page.click('[data-open-bike-guide]');
await page.waitForTimeout(150);
await page.click('[data-bike-origin-manual]');
await page.waitForTimeout(150);
await page.fill('#manualLocLat', '33.5905');
await page.fill('#manualLocLng', '130.4015');
await page.click('#manualLocApplyBtn');
await page.waitForTimeout(400);
{
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('10) 승인 안 된 계정은 실제 포트 후보 대신 공식 웹지도 안내만 봄', html.includes('포트 후보를 찾지 못했어요') && html.includes('공식 웹지도에서 직접 확인하기'));
  t('10) 승인 안 된 계정 화면엔 합성 포트 이름이 노출되지 않음', !html.includes('합성 근처 포트'));
}
await page.evaluate(() => document.getElementById('close').click());
await page.evaluate(() => daLogout());
await page.waitForTimeout(200);

// --- 11) 2026-09-16 재검토 4절 — 저장 실패 시에도 성공을 감추지
// 않고(정직하게 알림) 이미 만든 결과는 화면에 그대로 보여줌 ---
await loginViaUi('bike-e2e-savefail@example.com');
setTestAccessByEmail('bike-e2e-savefail@example.com', true);
await page.evaluate(() => {
  foodMap.places.push({ id: 'dest5', name: '저장실패 테스트 목적지', lat: 33.592, lng: 130.403, cat: '카페·디저트', catConfirmed: true, city: '후쿠오카', cityConfirmed: true, sourceLists: [] });
  A.saveFoodMap(foodMap);
  refreshFromStorage();
});
await page.waitForFunction(() => window.BikePorts && window.BikePorts.regionForCity('후쿠오카'), { timeout: 5000 });
await openDetail('dest5');
await page.click('[data-open-bike-guide]');
await page.waitForTimeout(150);
await page.click('[data-bike-origin-manual]');
await page.waitForTimeout(150);
await page.fill('#manualLocLat', '33.5905');
await page.fill('#manualLocLng', '130.4015');
await page.click('#manualLocApplyBtn');
await page.waitForTimeout(400);
await page.evaluate(() => { window.__origSaveFoodMap = A.saveFoodMap; A.saveFoodMap = () => false; }); // 저장 실패를 흉내
await page.click('[data-bike-pick-port="T-NEAR"]');
await page.waitForTimeout(500);
{
  const html = await page.evaluate(() => document.getElementById('sheetContent').innerHTML);
  t('11) 로컬 저장이 실패해도 방금 만든 안내는 그대로 화면에 보임(성공한 척 숨기지 않되 낭비하지도 않음)', html.includes('반납했어요'));
  const toastText = await page.evaluate(() => document.getElementById('toast').textContent);
  t('11) 저장 실패를 정직하게 알리는 안내가 뜸', toastText.includes('저장하지 못했'));
}
await page.evaluate(() => { A.saveFoodMap = window.__origSaveFoodMap; });
await page.evaluate(() => document.getElementById('close').click());
await page.evaluate(() => daLogout());
await page.waitForTimeout(200);

// --- 12) 2026-09-16 재검토 4절 — 요청 중 로그아웃하면, 나중에 도착한
// 응답이 다음 계정/손님 상태의 저장소에 반영되면 안 됨 ---
await loginViaUi('bike-e2e-switch@example.com');
setTestAccessByEmail('bike-e2e-switch@example.com', true);
await page.evaluate(() => {
  foodMap.places.push({ id: 'dest6', name: '계정전환 테스트 목적지', lat: 33.592, lng: 130.403, cat: '카페·디저트', catConfirmed: true, city: '후쿠오카', cityConfirmed: true, sourceLists: [] });
  A.saveFoodMap(foodMap);
  refreshFromStorage();
});
await page.waitForFunction(() => window.BikePorts && window.BikePorts.regionForCity('후쿠오카'), { timeout: 5000 });
await openDetail('dest6');
await page.click('[data-open-bike-guide]');
await page.waitForTimeout(150);
await page.click('[data-bike-origin-manual]');
await page.waitForTimeout(150);
await page.fill('#manualLocLat', '33.5905');
await page.fill('#manualLocLng', '130.4015');
await page.click('#manualLocApplyBtn');
await page.waitForTimeout(400);
await page.route('**/api/bike-ports/guide', async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 700)); // 응답을 일부러 늦춘다
  await route.continue();
});
await page.click('[data-bike-pick-port="T-NEAR"]'); // await 안 함 — 응답 오기 전에 로그아웃한다
await page.waitForTimeout(150);
await page.evaluate(() => daLogout()); // 요청이 아직 처리 중일 때 계정 전환
await page.waitForTimeout(900); // 지연된 응답이 도착할 시간을 준다
await page.unroute('**/api/bike-ports/guide');
{
  const leaked = await page.evaluate(() => foodMap.bikeGuide !== undefined);
  t('12) 요청 중 로그아웃해도 늦게 온 응답이 다음 화면 저장소를 오염시키지 않음', !leaked);
}

// 8·9·12절에서 일부러 만든 실패(무료체험 소진 후 402, 응답 유실을
// 흉내 낸 net::ERR_FAILED, 로그아웃 경합으로 지연된 요청이 뒤늦게
// 401을 받는 것)는 브라우저가 네트워크 계층에서 자동으로 콘솔에
// 남기는 표준 로그일 뿐, 화면 쪽 코드가 처리하지 못해 발생한 오류가
// 아니다 — 이 시나리오들 자체가 "정상적으로 실패를 처리하는지"를
// 검증하려고 의도적으로 만든 것이므로 이 세 가지 정확한 원인만
// 걸러내고, 그 외 예상 못 한 오류는 그대로 실패로 남긴다.
const expectedErrPatterns = [/402 \(Payment Required\)/, /net::ERR_FAILED/, /401 \(Unauthorized\)/];
const unexpectedErrs = errs.filter((e) => !expectedErrPatterns.some((p) => p.test(e)));
t('콘솔/런타임 오류 0건(8·9·12절에서 의도적으로 유발한 402/net::ERR_FAILED/401 제외)', unexpectedErrs.length === 0);
if (unexpectedErrs.length) console.log(unexpectedErrs.slice(0, 5).join('\n'));

await b.close();
console.log(fail === 0 ? '\n전체 통과' : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
