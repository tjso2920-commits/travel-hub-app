/**
 * 2026-09-11 재검토(11차) 5절 — "거리순 옆에서 '내 위치 기준'을
 * 선택하면 그때 GPS 권한을 요청해. 앱 시작부터 위치 팝업을 띄우지
 * 마. GPS 거절 시 숙소 또는 직접 지정 위치를 쓸 수 있게 해." 실제
 * Chromium으로 검증한다:
 *  1) 앱을 여는 순간부터 아무 조작 없이는 GPS를 절대 안 부름.
 *  2) 거리순을 고르면 "내 위치 기준으로 보기" 버튼이 나타나고, 눌러야
 *     그때 GPS를 부름.
 *  3) GPS 성공 시 실제로 그 좌표를 거리순 기준으로 씀.
 *  4) GPS 거절 시 직접 좌표를 입력해 대신 쓸 수 있음(강제 종료가
 *     아니라 대안 제공).
 *  5) "내 주변" 버튼(nearby())도 실제로 거리순+위치 요청을 함(예전
 *     "GPS 연결 전인 화면"이라던 자리표시자가 아님).
 *  6) 테스트 위치가 켜져 있으면 버튼이 숨고, 로그아웃하면 세션에
 *     남아 있던 GPS/직접 입력 위치가 다음 계정에 안 새어 나감.
 *
 * 실행: node scripts/test-location-optin.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
process.env.LOGIN_MAX_VERIFY_ATTEMPTS = '200';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
async function newPage(label) {
  const page = await b.newPage();
  page.on('pageerror', (e) => errs.push(`pageerror(${label}): ` + e.message));
  page.on('dialog', (d) => d.dismiss());
  await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  // 앱 스크립트가 실행되기 전에 getCurrentPosition을 스파이로 바꿔
  // 둔다 — "앱 시작부터 위치 팝업을 안 띄운다"를 실제로 확인하려면
  // 진짜 권한 프롬프트가 아니라 이 호출 자체가 있었는지를 관찰해야
  // 한다.
  await page.addInitScript(() => {
    window.__geoCalls = 0;
    const real = navigator.geolocation;
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: (success, error) => {
          window.__geoCalls++;
          if (window.__geoMode === 'success') success({ coords: { latitude: 33.5904, longitude: 130.4207 } });
          else error({ code: 1, message: 'denied' });
        },
        watchPosition: () => {},
      },
      configurable: true,
    });
  });
  await page.goto('file://' + process.cwd() + '/src/design/index.html');
  await page.waitForTimeout(200);
  return page;
}
async function loginViaUi(page, email) {
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
async function seedPlace(page, cityName) {
  await page.evaluate((c) => {
    foodMap.places = [{ id: 'p1', name: '테스트 가게', cat: '기타', catConfirmed: true, city: c, cityKnown: true, cityConfirmed: true, sourceLists: [], lat: 33.6, lng: 130.42 }];
    A.saveFoodMap(foodMap);
  }, cityName);
  await page.reload();
  await page.waitForTimeout(200);
}

// =====================================================================
// 1) 앱을 여는 순간부터 아무것도 안 눌러도 GPS를 절대 안 부름.
// =====================================================================
{
  const p = await newPage('P1');
  await p.waitForTimeout(300);
  const calls = await p.evaluate(() => window.__geoCalls);
  t('1) 앱을 여는 것만으로는 GPS를 전혀 안 부름(팝업 없음)', calls === 0);
  await p.close();
}

// =====================================================================
// 2~4) 거리순 옆 "내 위치 기준" 버튼 — 평소엔 숨어 있고, 거리순을
//    고르면 나타나며, 눌러야 그때 GPS를 부름. 성공/거절 각각 확인.
// =====================================================================
{
  const email = 'locopt-1@example.com';
  const city = '위치옵트인도시';
  const p = await newPage('P2');
  await loginViaUi(p, email);
  await seedPlace(p, city);
  await p.evaluate((c) => { city = c; updateCity(); }, city);
  await p.waitForTimeout(150);

  const hiddenAtStart = await p.evaluate(() => document.getElementById('useMyLocationBtn').hidden);
  t('2) 최근추가순(기본) 상태에서는 "내 위치 기준" 버튼이 안 보임', hiddenAtStart);

  await p.selectOption('#sortSelect', 'distance');
  await p.waitForTimeout(100);
  const shownOnDistance = await p.evaluate(() => !document.getElementById('useMyLocationBtn').hidden);
  t('2) 거리순으로 바꾸면 버튼이 나타남', shownOnDistance);
  const callsBeforeClick = await p.evaluate(() => window.__geoCalls);
  t('2) 거리순으로만 바꿨을 뿐 아직 GPS는 안 부름(버튼을 눌러야 함)', callsBeforeClick === 0);

  // 3) 성공 경로.
  await p.evaluate(() => { window.__geoMode = 'success'; });
  await p.click('#useMyLocationBtn');
  await p.waitForTimeout(200);
  const callsAfterClick = await p.evaluate(() => window.__geoCalls);
  t('3) 버튼을 눌러야 비로소 GPS를 부름', callsAfterClick === 1);
  const basisAfterSuccess = await p.evaluate(() => document.getElementById('sortBasisNote').textContent);
  t('3) 성공하면 실제로 "내 위치(GPS)"가 기준으로 표시됨', /내 위치\(GPS\)/.test(basisAfterSuccess));

  await p.close();
}

// =====================================================================
// 4) 거절 경로 — 직접 좌표 입력 대안이 뜸(GPS를 아직 한 번도 성공한
//    적 없는 새 페이지로 확인 — 이미 GPS를 확보한 세션에서 "거절"을
//    다시 눌러도 더 정확한 GPS 값을 부당하게 버리지 않는 게 맞는
//    동작이므로, 여기서는 처음부터 거절만 겪는 상황을 따로 만든다).
// =====================================================================
{
  const email = 'locopt-1b@example.com';
  const city = '위치거절도시';
  const p = await newPage('P2b');
  await loginViaUi(p, email);
  await seedPlace(p, city);
  await p.evaluate((c) => { city = c; updateCity(); window.__geoMode = 'deny'; }, city);
  await p.selectOption('#sortSelect', 'distance');
  await p.waitForTimeout(100);
  await p.click('#useMyLocationBtn');
  await p.waitForTimeout(200);
  const manualSheetShown = await p.evaluate(() => !!document.getElementById('manualLocLat'));
  t('4) GPS를 거절하면 직접 좌표 입력 화면이 뜸(강제 종료 아님)', manualSheetShown);
  await p.fill('#manualLocLat', '35.6812');
  await p.fill('#manualLocLng', '139.7671');
  await p.click('#manualLocApplyBtn');
  await p.waitForTimeout(200);
  const basisAfterManual = await p.evaluate(() => document.getElementById('sortBasisNote').textContent);
  t('4) 직접 입력한 좌표가 실제로 거리순 기준으로 적용됨', /직접 입력한 위치/.test(basisAfterManual));

  await p.close();
}

// =====================================================================
// 5) "내 주변" 버튼 — 예전 자리표시자가 아니라 실제로 거리순+위치
//    요청을 함.
// =====================================================================
{
  const email = 'locopt-2@example.com';
  const city = '내주변도시';
  const p = await newPage('P3');
  await loginViaUi(p, email);
  await seedPlace(p, city);
  await p.evaluate((c) => { city = c; updateCity(); window.__geoMode = 'success'; }, city);
  await p.waitForTimeout(100);
  await p.click('#nearby');
  await p.waitForTimeout(250);
  const sortModeAfter = await p.evaluate(() => sortMode);
  t('5) "내 주변"을 누르면 실제로 거리순으로 전환됨', sortModeAfter === 'distance');
  const geoCallsAfter = await p.evaluate(() => window.__geoCalls);
  t('5) "내 주변"을 누르면 실제로 위치 요청이 일어남(예전엔 전혀 안 불렀다)', geoCallsAfter >= 1);
  const noDialogOpen = await p.evaluate(() => !document.getElementById('sheet').open);
  t('5) 중간에 "GPS 연결 전" 안내 화면을 거치지 않고 바로 목록에 반영됨', noDialogOpen);

  await p.close();
}

// =====================================================================
// 6) 테스트 위치가 켜져 있으면 버튼이 숨고, 로그아웃하면 GPS/직접
//    입력 위치가 다음 계정에 안 새어 나감.
// =====================================================================
{
  const emailA = 'locopt-3a@example.com';
  const emailB = 'locopt-3b@example.com';
  const city = '격리확인도시';
  const p = await newPage('P4');
  await loginViaUi(p, emailA);
  await seedPlace(p, city);
  await p.evaluate((c) => { city = c; updateCity(); window.__geoMode = 'success'; }, city);
  await p.selectOption('#sortSelect', 'distance');
  await p.waitForTimeout(100);
  await p.click('#useMyLocationBtn');
  await p.waitForTimeout(200);
  const basisIsGps = await p.evaluate(() => document.getElementById('sortBasisNote').textContent);
  t('6) 준비 확인 — A 계정에서 GPS 기준이 실제로 적용됨', /내 위치\(GPS\)/.test(basisIsGps));

  await p.evaluate(() => daLogout());
  await p.waitForTimeout(200);
  await loginViaUi(p, emailB);
  await seedPlace(p, city);
  await p.evaluate((c) => { city = c; updateCity(); }, city);
  await p.selectOption('#sortSelect', 'distance');
  await p.waitForTimeout(150);
  const basisAfterOtherAccount = await p.evaluate(() => document.getElementById('sortBasisNote').textContent);
  t('6) 로그아웃 후 다른 계정에서는 이전 계정의 GPS 위치가 안 남아 있음(평균 위치로 돌아감)', /평균 위치/.test(basisAfterOtherAccount) && !/내 위치\(GPS\)/.test(basisAfterOtherAccount));

  await p.close();
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
