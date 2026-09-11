/**
 * 한국에서 현지 위치인 것처럼 테스트하는 모드 검증 — 실제 Chromium +
 * 실제 서버(임시 포트).
 *
 * 2026-09-11 재검토(10차) 7절 — ChatGPT 지적 반영: "?testmode=1만으로
 * 개발자 권한이 생기는 구조는 운영용 접근 제한이 아니다. 스테이징
 * 또는 서버가 허용한 테스트 계정에 제한해." 예전(9차) 버전은
 * ?testmode=1 URL 파라미터 하나로 이 브라우저에 영구히 풀렸다 — 이제는
 * 로그인된 계정을 관리자가 서버에서 실제로 승인(test_access=1)해야만
 * 열리고, 승인 안 된 계정은 URL 파라미터를 아무리 붙여도 아무 효과가
 * 없다.
 *
 * 실행: node scripts/test-test-location-mode.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

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
  await p.waitForTimeout(300); // refreshTestAccess가 끝날 시간을 준다.
  await p.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 1) 승인 안 된 일반 계정 — ?testmode=1을 붙여도 아무 효과가 없다.
//    "URL 파라미터만으로 권한이 생기면 안 된다"는 핵심 재현.
// =====================================================================
await p.goto('file://' + process.cwd() + '/src/design/index.html?testmode=1');
await p.waitForTimeout(200);
await loginViaUi('normal-user@example.com');
const allowedNormal = await p.evaluate(() => A.testModeAllowed());
t('1) 서버가 승인하지 않은 일반 계정은 ?testmode=1을 붙여도 잠금 풀리지 않음', allowedNormal === false);
await p.evaluate(() => { profile(); });
await p.waitForTimeout(150);
const hasTestSectionLocked = await p.locator('#sheetContent:has-text("테스트 위치")').count();
t('1) 잠금 상태에서는 프로필에 테스트 위치 섹션이 아예 안 보임', hasTestSectionLocked === 0);
await p.evaluate(() => { sheet.close(); });

// =====================================================================
// 2) 관리자가 실제로 이 계정을 승인하면(POST /api/admin/test-access),
//    다음 로그인부터 서버가 그렇다고 확인해 준다 — URL 파라미터와
//    무관하게 계정 자체의 서버 승인만이 근거다.
// =====================================================================
const approveRes = await fetch(`${apiBase}/api/admin/test-access`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
  body: JSON.stringify({ email: 'normal-user@example.com', enabled: true }),
});
const approveJson = await approveRes.json();
t('2) 관리자 승인 API가 실제로 성공함', approveRes.status === 200 && approveJson.testAccess === true);

// 승인 전 세션은 이미 캐시된 false를 들고 있다 — 다시 로그인(또는
// 새로고침)해야 서버의 최신 상태를 반영한다(관리자가 방금 켰다고
// 기존 열린 탭에 실시간으로 밀어주지는 않는다 — 다음 확인 시점에
// 반영되는 구조라는 걸 이 테스트로 명시한다).
await p.goto('file://' + process.cwd() + '/src/design/index.html'); // URL 파라미터 없이 접속.
await p.waitForTimeout(200);
await loginViaUi('normal-user@example.com');
const allowedAfterApproval = await p.evaluate(() => A.testModeAllowed());
t('2) 관리자 승인 후 재로그인하면 URL 파라미터 없이도 서버가 실제로 풀어 줌', allowedAfterApproval === true);
await p.evaluate(() => { profile(); });
await p.waitForTimeout(150);
const sectionText = await p.locator('#sheetContent').innerText();
t('2) 풀린 상태에서는 테스트 위치 섹션이 실제로 보임', sectionText.includes('테스트 위치'));
t('2) 실제 GPS를 흉내 내지 않는다는 문구가 실제로 있음', sectionText.includes('실제 GPS를 흉내 내지 않습니다'));

// =====================================================================
// 3) 하카타역 프리셋을 고르면 실제로 저장되고, 화면 상단 배너가
//    "테스트 위치 사용 중"으로 바뀐다(실제 위치 아님을 항상 밝힘).
// =====================================================================
await p.click('[data-test-loc-preset="hakata"]');
await p.waitForTimeout(150);
const bannerVisible = await p.evaluate(() => !document.getElementById('testLocationBanner').hidden);
const bannerText = await p.locator('#testLocationBannerText').innerText();
t('3) 프리셋 선택 후 배너가 실제로 나타남', bannerVisible);
t('3) 배너에 "실제 위치 아님"이 명시됨(현지 GPS 검증으로 오인 방지)', bannerText.includes('실제 위치 아님'));
t('3) 배너에 고른 지점 이름이 실제로 들어감', bannerText.includes('하카타역'));

// =====================================================================
// 4) 거리순 정렬이 테스트 위치를 기준으로 실제로 동작한다 — 하카타역에
//    가까운 곳이 먼 곳보다 먼저 온다. daLocationBasis()가 실제로
//    테스트 위치를 최우선으로 쓰는지 확인한다(10차 7절 통합).
// =====================================================================
await p.evaluate(() => {
  const cityName = '후쿠오카';
  foodMap.places = [
    { id: 'far1', name: '먼곳', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], lat: 34.5, lng: 131.5 },
    { id: 'near1', name: '하카타역 근처', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], lat: 33.5906, lng: 130.4209 },
  ];
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300); // refreshTestAccess(재시작 후 서버 재확인) 시간을 준다.
await p.evaluate(() => { city = '후쿠오카'; updateCity(); });
await p.waitForTimeout(100);
await p.selectOption('#sortSelect', 'distance');
await p.waitForTimeout(100);
const firstCard = await p.locator('#grid .spot h3').first().innerText();
const basisText = await p.locator('#sortBasisNote').innerText();
t('4) 테스트 위치(하카타역) 기준으로 가까운 곳이 먼저 옴', firstCard === '하카타역 근처');
t('4) 거리순 기준 문구가 테스트 위치임을 실제로 밝힘', basisText.includes('테스트 위치') && basisText.includes('하카타역'));

// =====================================================================
// 5) 10차 7절 신규 — "한국 GPS 상태에서 하카타 테스트 위치 선택 시
//    코스 출발 좌표도 하카타인지 검증." 코스 출발 화면의 "현재 위치에서
//    출발" 버튼이 실제 브라우저 GPS를 부르지 않고 테스트 위치(하카타)
//    를 그대로 써야 한다.
// =====================================================================
await p.evaluate(() => {
  foodMap.places.forEach((x) => { route.add(x.id); });
});
await p.evaluate(() => buildCourseSheet({}));
await p.waitForTimeout(150);
const gpsButtonText = await p.locator('[data-start-gps]').innerText();
t('5) 출발지 화면에 "현재 위치에서 출발" 버튼이 있음', gpsButtonText.includes('현재 위치'));
// 실제 GPS가 절대 호출되지 않도록 감시(호출되면 테스트가 멈춰 실패로 드러남).
await p.evaluate(() => {
  window.__gpsWasCalled = false;
  const orig = navigator.geolocation.getCurrentPosition;
  navigator.geolocation.getCurrentPosition = (...args) => { window.__gpsWasCalled = true; return orig.apply(navigator.geolocation, args); };
});
await p.click('[data-start-gps]');
await p.waitForTimeout(300);
const gpsWasCalled = await p.evaluate(() => window.__gpsWasCalled);
t('5) 테스트 위치가 켜져 있으면 실제 브라우저 GPS는 호출되지 않음', gpsWasCalled === false);

// =====================================================================
// 6) "실제 위치로 되돌리기"를 누르면 실제로 꺼지고, 정렬 기준도
//    원래(평균 위치)로 돌아온다. "지정 위치"라는 오해 소지 문구가
//    사라졌는지도 확인한다(10차 7절 — 평균은 평균이라고만 부른다).
// =====================================================================
await p.evaluate(() => { sheet.close(); });
await p.waitForTimeout(150);
await p.evaluate(() => { document.getElementById('testLocationBannerClear').click(); });
await p.waitForTimeout(150);
const bannerHiddenAfterClear = await p.evaluate(() => document.getElementById('testLocationBanner').hidden);
const basisTextAfterClear = await p.locator('#sortBasisNote').innerText();
t('6) 되돌리기를 누르면 배너가 실제로 사라짐', bannerHiddenAfterClear);
t('6) 정렬 기준 문구도 테스트 위치가 아닌 원래 안내로 돌아옴', !basisTextAfterClear.includes('테스트 위치'));
t('6) 평균 위치를 "지정 위치"라고 잘못 부르지 않음', !basisTextAfterClear.includes('지정 위치') && basisTextAfterClear.includes('평균 위치'));

// =====================================================================
// 7) 직접 좌표 입력도 실제로 반영된다.
// =====================================================================
await p.evaluate(() => { profile(); });
await p.waitForTimeout(100);
await p.fill('#testLocLat', '33.5911');
await p.fill('#testLocLng', '130.3987');
await p.click('#testLocCustomBtn');
await p.waitForTimeout(150);
const customLoc = await p.evaluate(() => A.getTestLocation());
t('7) 직접 입력한 좌표가 실제로 저장됨', customLoc && Math.abs(customLoc.lat - 33.5911) < 1e-6 && Math.abs(customLoc.lng - 130.3987) < 1e-6);
// 일부러 지우지 않고 남겨 둔다 — 아래 8절에서 "서버 승인이 거둬져도
// 로컬에 남은 값을 계속 신뢰하지 않는지"를 실제로 검증하기 위해서다.

// =====================================================================
// 8) 관리자가 승인을 거두면(test_access=0), 다음 확인 시점부터 테스트
//    위치 기능이 다시 잠긴다 — 로컬(localStorage)에 좌표가 여전히
//    남아 있어도 서버 승인이 없으면 절대 안 쓴다.
// =====================================================================
await fetch(`${apiBase}/api/admin/test-access`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
  body: JSON.stringify({ email: 'normal-user@example.com', enabled: false }),
});
await p.evaluate(() => { profile(); });
await p.waitForTimeout(200);
const allowedAfterRevoke = await p.evaluate(() => A.testModeAllowed());
t('8) 관리자가 승인을 거두면 다음 확인 때 즉시 잠김', allowedAfterRevoke === false);
const bannerHiddenAfterRevoke = await p.evaluate(() => document.getElementById('testLocationBanner').hidden);
t('8) 로컬에 남아 있던 테스트 위치 값이 있어도 배너가 다시 안 뜸(서버 승인 재확인)', bannerHiddenAfterRevoke);
const stillInLocalStorage = await p.evaluate(() => A.getTestLocation());
t('8) 좌표 값 자체는 로컬에 여전히 남아 있음(승인만 거둬졌을 뿐 값을 지운 게 아님)', !!stillInLocalStorage);

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
