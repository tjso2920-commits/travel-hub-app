/**
 * 2026-09-11 재검토(13차) 2절 — Google 로그인 화면 연결 검증(실제
 * Chromium 화면), 클라이언트 ID가 서버에 설정 안 된 경우(기본 개발
 * 환경): 로그인 시트에 깨진 버튼이 절대 안 보이고, 이메일 로그인은
 * 평소처럼 정상 동작해야 한다.
 *
 * (클라이언트 ID가 설정된 경우의 검증은 scripts/test-google-signin-
 * configured.mjs — config.mjs가 process.env를 모듈 최초 로드 시에만
 * 읽으므로, 서로 다른 GOOGLE_CLIENT_ID 상태는 별도 프로세스로 분리해야
 * 실제로 다른 설정을 반영한다.)
 *
 * 실행: node scripts/test-google-signin-ui.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
delete process.env.GOOGLE_CLIENT_ID;

const { createServer } = await import('../server/index.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
const page = await b.newPage();
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await page.goto('file://' + process.cwd() + '/src/design/index.html');
await page.waitForTimeout(200);

await page.evaluate(() => showLoginSheet(() => {}));
await page.waitForTimeout(600); // daTryRenderGoogleButton이 /api/auth/google/config를 물어보고 끝날 시간.
const slotEmpty = await page.evaluate(() => {
  const slot = document.getElementById('googleAuthSlot');
  return !slot || slot.children.length === 0;
});
t('클라이언트 ID가 없으면 Google 버튼 슬롯이 비어 있음(가짜 버튼 없음)', slotEmpty);
const dividerHidden = await page.evaluate(() => document.getElementById('googleAuthDivider').hidden);
t('구분선("또는")도 안 보임', dividerHidden === true);
const emailInputExists = await page.evaluate(() => !!document.getElementById('loginEmail'));
t('이메일 입력칸은 평소처럼 그대로 있음', emailInputExists);
t('콘솔/런타임 오류 없음', errs.length === 0);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
