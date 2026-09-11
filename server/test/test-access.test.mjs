'use strict';
/**
 * 2026-09-11 재검토(10차) 7절 — "?testmode=1만으로 개발자 권한이
 * 생기는 구조는 운영용 접근 제한이 아니다. 스테이징 또는 서버가
 * 허용한 테스트 계정에 제한해." 서버가 실제로 계정별 test_access를
 * 관리하고, 관리자만 이를 켜고 끌 수 있는지 검증한다.
 *
 * 실행: node server/test/test-access.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ADMIN_TOKEN = 'test-admin-token-not-for-production';

const { checkTestAccess, setTestAccessByEmail } = await import('../routes/entitlement.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { createServer } = await import('../index.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}

// =====================================================================
// 1) 기본값 — 새 계정은 항상 test_access=0(꺼짐)이다.
// =====================================================================
const acc = directAccount('test-access-basic@example.com');
t('1) 새 계정은 기본적으로 테스트 접근이 꺼져 있음', checkTestAccess(acc).testAccess === false);

// =====================================================================
// 2) 관리자가 email로 켜면 실제로 반영된다. 없는 계정은 정직하게 실패.
// =====================================================================
const onResult = setTestAccessByEmail('test-access-basic@example.com', true);
t('2) 관리자가 켜면 성공함', onResult.ok === true && onResult.testAccess === true);
t('2) 켠 뒤 실제로 조회하면 true로 나옴', checkTestAccess(acc).testAccess === true);
const offResult = setTestAccessByEmail('test-access-basic@example.com', false);
t('2) 관리자가 다시 끄면 실제로 꺼짐', offResult.ok === true && checkTestAccess(acc).testAccess === false);
const missingResult = setTestAccessByEmail('no-such-account@example.com', true);
t('2) 존재하지 않는 계정은 조용히 성공 처리하지 않고 정직하게 실패함', missingResult.ok === false && missingResult.reason === 'account-not-found');

// =====================================================================
// 3) HTTP 레벨 — 관리자 토큰 없이는 /api/admin/test-access를 못 씀.
//    ADMIN_TOKEN 자체가 없으면 501로 정직하게 "설정 안 됨"을 알린다
//    (기존 feedback 관리자 API와 동일한 원칙).
// =====================================================================
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const noAuthRes = await fetch(`${apiBase}/api/admin/test-access`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'test-access-basic@example.com', enabled: true }),
});
t('3) 인증 헤더 없이 부르면 401', noAuthRes.status === 401);

const wrongAuthRes = await fetch(`${apiBase}/api/admin/test-access`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
  body: JSON.stringify({ email: 'test-access-basic@example.com', enabled: true }),
});
t('3) 틀린 관리자 토큰은 401', wrongAuthRes.status === 401);

const correctAuthRes = await fetch(`${apiBase}/api/admin/test-access`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token-not-for-production' },
  body: JSON.stringify({ email: 'test-access-basic@example.com', enabled: true }),
});
const correctAuthJson = await correctAuthRes.json();
t('3) 올바른 관리자 토큰이면 실제로 성공함', correctAuthRes.status === 200 && correctAuthJson.testAccess === true);

// =====================================================================
// 4) 로그인된 계정 본인은 /api/account/test-access로 자기 상태를
//    확인할 수 있다(다른 계정 것은 볼 수 없다 — 세션 토큰 기준).
// =====================================================================
const sessionRow = { token: uuid(), account_id: acc, created_at: nowIso(), expires_at: new Date(Date.now() + 3600_000).toISOString() };
openDb().prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sessionRow.token, sessionRow.account_id, sessionRow.created_at, sessionRow.expires_at);
const selfCheckRes = await fetch(`${apiBase}/api/account/test-access`, { headers: { Authorization: `Bearer ${sessionRow.token}` } });
const selfCheckJson = await selfCheckRes.json();
t('4) 본인 세션으로 조회하면 관리자가 방금 켜 준 상태(true)가 그대로 보임', selfCheckRes.status === 200 && selfCheckJson.testAccess === true);

const noSessionRes = await fetch(`${apiBase}/api/account/test-access`);
t('4) 로그인 없이(세션 토큰 없이) 조회하면 401', noSessionRes.status === 401);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
server.close();
process.exit(fail ? 1 : 0);
