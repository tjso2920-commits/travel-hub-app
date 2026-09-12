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
 * 2026-09-11 재검토(15차) 2절 — 추가(3절): 서버가 ownership-
 * verification-required(409)를 돌려줄 때 클라이언트 화면이 실제로
 * 소유확인 절차(이메일 인증 코드)를 끝까지 완결하는지 검증한다.
 * **이 파일 전체가 모의(mock) 서버 응답 기반 화면 검증이다** — 실제
 * Google 계정으로 로그인해 실제 크리덴셜을 받은 적은 없다(이 세션
 * 환경에서 원천적으로 불가능 — accounts.google.com 실제 발급 절차
 * 자체를 거칠 수 없음). `/api/auth/google`·`/api/auth/request-code`
 * 응답을 page.route로 가로채 "서버가 실제로 이렇게 응답한다면 화면이
 * 뭘 하는지"만 검증한다. sub 기준 소유확인 로직 자체의 실제 서버 단
 * 재현·검증은 `server/test/google-auth.test.mjs`(실제 RSA 서명·검증
 * 로직을 그대로 통과)가 별도로 맡는다 — 이 둘을 하나로 섞어 "실제
 * 검증 완료"라고 과장하지 않는다.
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

// =====================================================================
// 3) (15차 신규) 서버가 ownership-verification-required(409)를 돌려줄
//    때 — 기존 계정 확인 화면 → 이메일 인증 코드 화면 → 연결 완료까지
//    실제로 끝까지 이어짐. 모의 서버 응답(page.route)으로 클라이언트
//    로직만 검증한다(실제 Google 계정 연결이 아님 — 파일 상단 설명
//    참고).
// =====================================================================
async function newGoogleStubPage() {
  const errs = [];
  const page = await b.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.addInitScript(() => {
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
  return { page, errs };
}

{
  const { page, errs } = await newGoogleStubPage();
  // 첫 호출(emailCode 없음)엔 소유확인 필요, emailCode가 실려 오면
  // 성공 — 서버 googleSignIn의 실제 두 단계 응답을 흉내낸다.
  await page.route('**/api/auth/google', (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.emailCode) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, token: 'linked-session-token', accountId: 'acc-existing', isNew: false, email: 'owner@example.com' }) });
    }
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'ownership-verification-required', email: 'owner@example.com' }) });
  });
  await page.route('**/api/auth/request-code', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));

  await page.evaluate(() => showLoginSheet(() => { window.__onSuccessCalled = true; }));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__googleCallback({ credential: 'fake-id-token-existing-owner' }));
  await page.waitForTimeout(300);
  const ownershipText = await page.evaluate(() => document.getElementById('sheetContent').textContent);
  t('3) 소유확인이 필요하면 "Google 로그인 실패"가 아니라 전용 안내 화면으로 전환됨', ownershipText.includes('이미 가입된 계정'));
  t('3) 그 화면에 서버가 알려준 대상 이메일이 실제로 보임', ownershipText.includes('owner@example.com'));

  await page.click('#googleOwnershipSendBtn');
  await page.waitForTimeout(200);
  const hasCodeInput = await page.evaluate(() => !!document.getElementById('googleOwnershipCode'));
  t('3) 인증 코드 받기를 누르면 코드 입력 화면으로 넘어감', hasCodeInput);

  await page.fill('#googleOwnershipCode', '123456');
  await page.click('#googleOwnershipVerifyBtn');
  await page.waitForTimeout(300);
  const sessionAfterLink = await page.evaluate(() => foodMap.session);
  t('3) 이메일 인증 코드로 확인하면 실제로 기존 계정 세션이 설정됨(daFinishLogin 실제 호출)', sessionAfterLink && sessionAfterLink.token === 'linked-session-token' && sessionAfterLink.email === 'owner@example.com');
  const onSuccessCalled = await page.evaluate(() => window.__onSuccessCalled === true);
  t('3) 연결 완료 후 원래 하려던 동작(onSuccess)이 이어서 실행됨', onSuccessCalled);

  const idTokenLeaked = await page.evaluate(() => {
    let ls = '';
    try { ls = JSON.stringify(localStorage); } catch (e) { /* 접근 불가 환경 — leak 아님 */ }
    const fm = JSON.stringify(window.foodMap || {});
    return ls.includes('fake-id-token-existing-owner') || fm.includes('fake-id-token-existing-owner');
  });
  t('3) Google idToken이 localStorage·foodMap 등 어디에도 영구 저장되지 않음(메모리에서만 오갔음)', !idTokenLeaked);
  t('3) 콘솔/런타임 오류 없음', errs.length === 0);
  await page.close();
}

// =====================================================================
// 3-b) 소유확인 화면에서 취소하면 이메일 로그인으로 자연스럽게 돌아감
//      (idToken을 계속 들고 있지 않고 그 자리에서 놓음).
// =====================================================================
{
  const { page } = await newGoogleStubPage();
  await page.route('**/api/auth/google', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'ownership-verification-required', email: 'owner@example.com' }) }));
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__googleCallback({ credential: 'fake-id-token-cancel' }));
  await page.waitForTimeout(300);
  await page.click('#googleOwnershipCancelBtn');
  await page.waitForTimeout(200);
  const backToEmailLogin = await page.evaluate(() => !!document.getElementById('loginEmail'));
  t('3-b) "다른 방법으로 로그인"을 누르면 이메일 로그인 화면으로 돌아감', backToEmailLogin);
  await page.close();
}

// =====================================================================
// 3-c) Google idToken이 그 사이 만료됐으면(401) 코드를 넣어도 소용
//      없다는 걸 정확히 안내하고 처음 화면으로 되돌림.
// =====================================================================
{
  const { page } = await newGoogleStubPage();
  await page.route('**/api/auth/google', (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.emailCode) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'expired' }) });
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'ownership-verification-required', email: 'owner@example.com' }) });
  });
  await page.route('**/api/auth/request-code', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__googleCallback({ credential: 'fake-id-token-expiring' }));
  await page.waitForTimeout(300);
  await page.click('#googleOwnershipSendBtn');
  await page.waitForTimeout(200);
  await page.fill('#googleOwnershipCode', '123456');
  await page.click('#googleOwnershipVerifyBtn');
  await page.waitForTimeout(200);
  const expiredMsg = await page.evaluate(() => document.getElementById('googleOwnershipMsg').textContent);
  t('3-c) 토큰 만료(401)는 "코드가 틀림"이 아니라 "처음부터 다시"로 정확히 안내됨', expiredMsg.includes('만료'));
  await page.waitForTimeout(1800); // setTimeout(...,1600) 이후 로그인 화면으로 되돌아가는지 확인.
  const backAfterExpiry = await page.evaluate(() => !!document.getElementById('loginEmail'));
  t('3-c) 안내 후 실제로 처음 로그인 화면으로 되돌아감', backAfterExpiry);
  await page.close();
}

// =====================================================================
// 3-d) 소유확인 코드를 계속 틀려 잠기면(locked) "코드가 틀림"과 다르게
//      안내됨 — 서버 auth.mjs가 이제 이 사유를 구분해 돌려준다.
// =====================================================================
{
  const { page } = await newGoogleStubPage();
  await page.route('**/api/auth/google', (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.emailCode) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'locked' }) });
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'ownership-verification-required', email: 'owner@example.com' }) });
  });
  await page.route('**/api/auth/request-code', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__googleCallback({ credential: 'fake-id-token-locked' }));
  await page.waitForTimeout(300);
  await page.click('#googleOwnershipSendBtn');
  await page.waitForTimeout(200);
  await page.fill('#googleOwnershipCode', '000000');
  await page.click('#googleOwnershipVerifyBtn');
  await page.waitForTimeout(200);
  const lockedMsg = await page.evaluate(() => document.getElementById('googleOwnershipMsg').textContent);
  t('3-d) 잠김(locked)은 "코드가 틀림"과 다르게 잠시 후 재시도로 안내됨', lockedMsg.includes('시도') && lockedMsg.includes('잠시'));
  await page.close();
}

// =====================================================================
// 3-e) 코드 다시 받기(재전송) — 소유확인 코드 입력 화면에서 다시
//      "인증 코드 받기" 단계로 되돌아갈 수 있음(재시도 경로 보존).
// =====================================================================
{
  const { page } = await newGoogleStubPage();
  await page.route('**/api/auth/google', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'ownership-verification-required', email: 'owner@example.com' }) }));
  let requestCodeCalls = 0;
  await page.route('**/api/auth/request-code', (route) => { requestCodeCalls++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__googleCallback({ credential: 'fake-id-token-resend' }));
  await page.waitForTimeout(300);
  await page.click('#googleOwnershipSendBtn');
  await page.waitForTimeout(200);
  await page.click('#googleOwnershipResendBtn');
  await page.waitForTimeout(200);
  const backOnSendScreen = await page.evaluate(() => !!document.getElementById('googleOwnershipSendBtn'));
  t('3-e) "코드 다시 받기"를 누르면 인증 코드 받기 화면으로 돌아감', backOnSendScreen);
  await page.click('#googleOwnershipSendBtn');
  await page.waitForTimeout(200);
  t('3-e) 실제로 코드 요청이 한 번 더 나감(재전송)', requestCodeCalls >= 2);
  await page.close();
}

// =====================================================================
// 4) (15차 신규) 초대 코드가 필요한 베타 구성에서도 Google 가입 흐름이
//    완료되는지 — 클라이언트가 실제로 입력값을 함께 보내고, 서버가
//    부족하다고 답하면 정확한 사유로 안내함(모의 서버 응답).
// =====================================================================
{
  const { page } = await newGoogleStubPage();
  let capturedBody = null;
  await page.route('**/api/auth/google', (route) => {
    capturedBody = route.request().postDataJSON();
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'invite-code-required' }) });
  });
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(200);
  await page.fill('#loginInviteCode', 'BETA-CODE-123');
  await page.evaluate(() => window.__googleCallback({ credential: 'fake-id-token-newacc' }));
  await page.waitForTimeout(300);
  t('4) 입력한 초대 코드가 실제로 Google 로그인 요청에 함께 실려 감', capturedBody && capturedBody.inviteCode === 'BETA-CODE-123');
  const inviteMsg = await page.evaluate(() => document.getElementById('loginMsg').textContent);
  t('4) 초대 코드가 필요한데 없으면(이 경우는 서버가 그렇다고 답함) 정확한 사유로 안내됨', inviteMsg.includes('초대 코드'));
  await page.close();
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
