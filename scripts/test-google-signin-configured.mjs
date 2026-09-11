/**
 * 2026-09-11 재검토(13차) 2절 — Google 로그인 화면 연결 검증(실제
 * Chromium 화면), 서버에 클라이언트 ID가 설정된 경우:
 *  1) Google 스크립트 로드 자체가 막히면(네트워크 차단·인앱 브라우저
 *     흉내) 페이지 오류 없이 조용히 실패하고, 이메일 로그인은 여전히
 *     정상 동작함.
 *  2) Google Identity Services가 정상 동작한다고 가정했을 때(실제
 *     스크립트 대신 테스트 전용 stub을 주입해 실제 크리덴셜 없이
 *     클라이언트 쪽 연결 로직만 검증), 버튼이 실제로 그려지고
 *     자격증명 콜백이 오면 서버 응답을 실제로 반영해 로그인이 완료됨
 *     (daFinishLogin이 실제로 호출되는지 확인).
 *
 * 실행: node scripts/test-google-signin-configured.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

const { createServer } = await import('../server/index.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// =====================================================================
// 1) 클라이언트 ID는 있지만 Google 스크립트 로드가 막힘(네트워크 차단
//    흉내) — 조용히 실패하고 이메일 로그인은 영향 없음.
// =====================================================================
{
  const errs = [];
  const page = await b.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  // Google 스크립트 요청 자체를 실패시킨다(인앱 브라우저의 서드파티
  // 스크립트 차단을 흉내낸다).
  await page.route('https://accounts.google.com/gsi/client', (route) => route.abort());
  await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  await page.goto('file://' + process.cwd() + '/src/design/index.html');
  await page.waitForTimeout(200);

  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(800); // 스크립트 로드 실패가 확정될 시간(4초 타임아웃보다는 짧게, route abort는 즉시 실패하므로 충분).
  const dividerStillHidden = await page.evaluate(() => document.getElementById('googleAuthDivider').hidden);
  t('1) 스크립트 로드가 막히면 구분선이 계속 숨겨져 있음(깨진 버튼 노출 없음)', dividerStillHidden === true);
  const emailStillWorks = await page.evaluate(() => !!document.getElementById('loginSendBtn') && !document.getElementById('loginSendBtn').disabled);
  t('1) 이메일 로그인 버튼은 영향 없이 그대로 눌릴 수 있음', emailStillWorks);
  t('1) 콘솔/런타임 오류로 이어지지 않음(내부에서 조용히 처리)', errs.length === 0);

  await page.close();
}

// =====================================================================
// 2) Google Identity Services가 정상 로드됐다고 가정(테스트 전용
//    stub)했을 때, 실제로 버튼이 그려지고 자격증명 콜백 → 서버 응답
//    반영까지 클라이언트 쪽 연결이 실제로 동작함.
// =====================================================================
{
  const errs = [];
  const page = await b.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.addInitScript(() => {
    // 실제 Google Identity Services 대신, 이미 로드된 것처럼 흉내내는
    // 최소 stub — daLoadGoogleIdentityScript는 window.google.accounts.id가
    // 이미 있으면 실제 스크립트를 아예 안 불러온다(코드 그대로의 조건
    // 분기를 그대로 탄다).
    window.google = {
      accounts: {
        id: {
          initialize(opts) { window.__googleCallback = opts.callback; },
          renderButton(el) { const b2 = document.createElement('div'); b2.id = 'fakeGoogleBtn'; b2.textContent = 'Google로 계속하기(테스트)'; el.appendChild(b2); },
        },
      },
    };
  });
  await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  await page.goto('file://' + process.cwd() + '/src/design/index.html');
  await page.waitForTimeout(200);

  await page.evaluate(() => showLoginSheet(() => { window.__onSuccessCalled = true; }));
  await page.waitForTimeout(300);
  const buttonRendered = await page.evaluate(() => !!document.getElementById('fakeGoogleBtn'));
  t('2) Google 로드가 성공하면 실제로 버튼이 그려짐', buttonRendered);
  const dividerVisible = await page.evaluate(() => document.getElementById('googleAuthDivider').hidden === false);
  t('2) 구분선("또는")도 함께 보임', dividerVisible);

  // 실제 서버 라우트(/api/auth/google)는 진짜 Google 서명이 필요해
  // 이 테스트에서 재현 불가하므로, 응답만 가로채 클라이언트 쪽 연결
  // 로직(콜백 → daFinishLogin)이 실제로 동작하는지 확인한다.
  await page.route('**/api/auth/google', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, token: 'fake-google-session-token', accountId: 'acc-fake', isNew: true, email: 'googleuser@example.com' }),
  }));
  await page.evaluate(() => window.__googleCallback({ credential: 'fake-id-token' }));
  await page.waitForTimeout(400);
  const sessionAfter = await page.evaluate(() => foodMap.session);
  t('2) 자격증명 콜백이 오면 실제로 세션이 설정됨(daFinishLogin 실제 호출)', sessionAfter && sessionAfter.token === 'fake-google-session-token' && sessionAfter.email === 'googleuser@example.com');
  const onSuccessCalled = await page.evaluate(() => window.__onSuccessCalled === true);
  t('2) 로그인 성공 후 원래 하려던 동작(onSuccess)이 이어서 실행됨', onSuccessCalled);
  t('2) 콘솔/런타임 오류 없음', errs.length === 0);

  await page.close();
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
