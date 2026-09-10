/**
 * 소개 페이지(로드맵 ⑪) 종단 검증 — 실제 Chromium + 실제 서버(임시 포트).
 *
 * 확인 범위:
 * - 화면이 콘솔 오류 없이 뜨는지(폰트·스크립트 로드 포함)
 * - 진입 시 channel_inflow가 실제로 기록되는지
 * - 잘못된 이메일은 서버까지 안 보내고 화면에서 바로 막는지
 * - 정상 이메일 신청이 실제로 /api/waitlist에 도달해 DB에 남는지
 * - 신청 성공 시 waitlist_signup 이벤트가 실제로 기록되는지
 * - 서버 연결 전(window.API_BASE 미설정) 상태에서는 "신청됨"으로
 *   거짓 성공 표시를 하지 않는지(정직한 실패 문구를 보여주는지)
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
const { createServer } = await import('../server/index.mjs');
const { openDb } = await import('../server/db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// --- 1) 서버 연결 안 된 상태(정적 페이지 단독 열람) ---
{
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
  await p.goto('file://' + process.cwd() + '/src/design/landing.html');
  await p.waitForTimeout(300);

  t('서버 미연결 상태에서도 화면 로드 시 콘솔/런타임 오류 없음', errs.length === 0);

  await p.fill('#waitlistEmail', 'someone@example.com');
  await p.click('#waitlistSubmit');
  await p.waitForTimeout(200);
  const msg = await p.textContent('#waitlistMsg');
  t('서버 미연결 상태에서는 신청을 성공으로 위장하지 않고 정직하게 실패를 알림', /연결되지 않았어요|다시 시도/.test(msg || ''));
  await p.close();
}

// --- 2) 서버 연결된 상태 ---
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/landing.html');
await p.waitForTimeout(300);

t('서버 연결 상태에서도 콘솔/런타임 오류 없음', errs.length === 0);

{
  const db = openDb();
  const inflow = db.prepare("SELECT * FROM events WHERE name = 'channel_inflow'").all();
  t('진입 시 channel_inflow 이벤트가 실제로 서버에 기록됨', inflow.length >= 1);
}

// --- 잘못된 이메일: 서버까지 안 가고 화면에서 막힘 ---
{
  const { waitlistCountForTest } = await import('../server/routes/waitlist.mjs');
  const before = waitlistCountForTest();
  await p.fill('#waitlistEmail', '이메일아님');
  await p.click('#waitlistSubmit');
  await p.waitForTimeout(150);
  t('형식이 틀린 이메일은 서버로 보내지 않고 화면에서 바로 막음', waitlistCountForTest() === before);
  const msg = await p.textContent('#waitlistMsg');
  t('형식 오류 문구가 실제로 보임', /다시 확인/.test(msg || ''));
}

// --- 정상 신청 ---
{
  const { waitlistCountForTest } = await import('../server/routes/waitlist.mjs');
  const before = waitlistCountForTest();
  await p.fill('#waitlistEmail', 'real-signup@example.com');
  await p.click('#waitlistSubmit');
  await p.waitForTimeout(300);
  t('정상 이메일 신청이 실제로 DB에 한 행 남김', waitlistCountForTest() === before + 1);
  const msg = await p.textContent('#waitlistMsg');
  t('신청 완료 문구가 실제로 보임', /신청 완료/.test(msg || ''));

  const db = openDb();
  const signupEvt = db.prepare("SELECT * FROM events WHERE name = 'waitlist_signup'").all();
  t('신청 완료 시 waitlist_signup 이벤트도 실제로 기록됨(장소명 등 자유 텍스트 없이 channel만)', signupEvt.length === 1);
  const props = JSON.parse(signupEvt[0].props);
  t('waitlist_signup 이벤트에는 channel 외 다른 키가 없음(개인정보 없음)', Object.keys(props).join(',') === 'channel');

  const input = await p.$eval('#waitlistEmail', (el) => el.value);
  t('신청 성공 후 입력창이 비워짐', input === '');
}

await b.close();
server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
