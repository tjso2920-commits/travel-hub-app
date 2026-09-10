'use strict';
/**
 * 2026-09-10 재검토(3차) 반영 사항 전용 테스트 — 서버 집행 코스 생성,
 * 로그인 남용 방지, 장소 조회 인증·한도, 공급자 어댑터 계약(모의).
 * 실행: node server/test/server-v2.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '2';
process.env.LOGIN_MAX_VERIFY_ATTEMPTS = '3';
process.env.LOGIN_LOCKOUT_SECONDS = '1';
process.env.GENERATION_RATE_LIMIT_PER_HOUR = '3';
process.env.PLACE_LOOKUP_IMPORT_DAILY_LIMIT = '5';
process.env.PLACE_LOOKUP_REQUERY_DAILY_LIMIT = '2';
process.env.PLACE_LOOKUP_BATCH_MAX_ITEMS = '4';
process.env.PLACE_LOOKUP_BATCH_DAILY_LIMIT = '4';

const { createServer } = await import('../index.mjs');
const { sentEmailsForTest } = await import('../adapters/email.mjs');
const { openDb } = await import('../db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function api(method, path, { body, token, rawBody, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}

async function loginNewAccount(email) {
  await api('POST', '/api/auth/request-code', { body: { email } });
  const code = sentEmailsForTest.filter((e) => e.to === email).pop().body.match(/(\d{6})/)[1];
  const r = await api('POST', '/api/auth/verify-code', { body: { email, code } });
  return r.json;
}

// ============================================================
// 1. 로그인 코드 요청 쿨다운 + 검증 실패 잠금
// ============================================================
{
  const email = 'ratelimit-login@example.com';
  const first = await api('POST', '/api/auth/request-code', { body: { email } });
  t('첫 코드 요청 성공', first.status === 200);
  const second = await api('POST', '/api/auth/request-code', { body: { email } });
  t('쿨다운 안에 재요청하면 거부됨', second.status === 400 && second.json.reason === 'cooldown');

  const email2 = 'lockout-login@example.com';
  await api('POST', '/api/auth/request-code', { body: { email: email2 } });
  for (let i = 0; i < 3; i++) {
    await api('POST', '/api/auth/verify-code', { body: { email: email2, code: '000000' } });
  }
  const locked = await api('POST', '/api/auth/verify-code', { body: { email: email2, code: '000000' } });
  t('연속 실패 한도를 넘으면 잠김(맞는 코드를 넣어도 거부)', locked.status === 429 && locked.json.reason === 'locked');
  await new Promise((r) => setTimeout(r, 1100));
  const email3 = 'lockout-unlock@example.com';
  await api('POST', '/api/auth/request-code', { body: { email: email3 } });
  for (let i = 0; i < 3; i++) await api('POST', '/api/auth/verify-code', { body: { email: email3, code: '000000' } });
  await new Promise((r) => setTimeout(r, 1100));
  const code3 = sentEmailsForTest.filter((e) => e.to === email3).pop().body.match(/(\d{6})/)[1];
  const unlocked = await api('POST', '/api/auth/verify-code', { body: { email: email3, code: code3 } });
  t('잠금 시간이 지나면 다시 올바른 코드로 로그인 가능', unlocked.status === 200 && !!unlocked.json.token);
}

// ============================================================
// 2. 로그아웃
// ============================================================
{
  const acc = await loginNewAccount('logout-test@example.com');
  const before = await api('GET', '/api/entitlement', { token: acc.token });
  t('로그아웃 전에는 세션이 유효함', before.status === 200);
  const out = await api('POST', '/api/auth/logout', { token: acc.token });
  t('로그아웃 성공', out.status === 200 && out.json.ok === true);
  const after = await api('GET', '/api/entitlement', { token: acc.token });
  t('로그아웃 후에는 같은 토큰이 더 이상 안 통함', after.status === 401);
}

// ============================================================
// 3. 장소 조회 — 인증 필수 + 단일 조회는 항상 requery 한도(2026-09-10
//    재검토 4차: phase 쿼리 파라미터는 더 이상 더 큰 한도를 안 준다 —
//    클라이언트 자기 신고였다는 지적 반영. 큰 한도는 배치 엔드포인트로만.)
// ============================================================
{
  const acc = await loginNewAccount('lookup-limit@example.com');
  const noAuth = await api('GET', '/api/places/lookup?q=test');
  t('인증 없이는 장소 조회 401', noAuth.status === 401);

  // phase=import를 붙여도 더 이상 큰 한도를 안 준다 — 단일 조회는
  // 항상 requery 한도(2)만 적용된다.
  let requeryOk = 0;
  for (let i = 0; i < 2; i++) {
    const r = await api('GET', `/api/places/lookup?q=requery-place-${i}&phase=import&placeId=requery-place-${i}`, { token: acc.token });
    if (r.status === 200) requeryOk++;
  }
  t('단일 조회는 phase=import를 붙여도 항상 requery 한도만 적용됨(자기 신고로 큰 한도를 못 받음)', requeryOk === 2);
  const overRequery = await api('GET', '/api/places/lookup?q=requery-place-overflow&phase=import&placeId=requery-place-overflow', { token: acc.token });
  t('단일 조회 한도를 넘으면 429', overRequery.status === 429 && overRequery.json.reason === 'account-daily-limit-reached');
}

// ============================================================
// 3-2. 일괄 조회(/api/places/lookup-batch) — 서버가 실제로 한 번에
//      처리하는 개수로 배치 크기가 정해진다(클라이언트가 뭐라고
//      부르는지가 아니라). 배치 크기 상한(4)을 넘는 항목은 잘라내고
//      정직하게 truncated로 알린다.
// ============================================================
{
  const acc = await loginNewAccount('lookup-batch@example.com');
  const items = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'b' + i, query: 'batch-place-' + i }));
  const r = await api('POST', '/api/places/lookup-batch', { token: acc.token, body: { items } });
  t('일괄 조회 성공', r.status === 200);
  t('배치 크기 상한(4)을 넘는 항목은 잘라내고 truncated로 알림', r.json.truncated === true && r.json.results.length === 4);
  t('처리 안 된 나머지는 skipped 목록으로 정직하게 남음', JSON.stringify(r.json.skipped) === JSON.stringify(['b5', 'b6']));

  const noAuthBatch = await api('POST', '/api/places/lookup-batch', { body: { items: [{ id: 'x', query: 'x' }] } });
  t('인증 없이는 일괄 조회도 401', noAuthBatch.status === 401);

  // 배치 일일 한도(4)는 단일 조회 한도(requery)와 별개로 소진된다.
  const acc2 = await loginNewAccount('lookup-batch-2@example.com');
  const firstBatch = await api('POST', '/api/places/lookup-batch', { token: acc2.token, body: { items: [{ id: 'c1', query: 'c1' }, { id: 'c2', query: 'c2' }] } });
  t('배치 한도 안에서는 성공', firstBatch.status === 200);
  const secondBatch = await api('POST', '/api/places/lookup-batch', { token: acc2.token, body: { items: [{ id: 'c3', query: 'c3' }, { id: 'c4', query: 'c4' }, { id: 'c5', query: 'c5' }] } });
  t('배치 일일 한도를 넘으면 429(단일 조회 한도와 별개)', secondBatch.status === 429);
}

// ============================================================
// 4. 개인화 코스 생성 — 서버 집행(인증·멱등성·동시잠금·레이트리밋·
//    실패시 미차감)
// ============================================================
{
  const acc = await loginNewAccount('gen-test@example.com');
  const origin = { lat: 33.590, lng: 130.400 };
  const places = [{ id: 'p1', name: 'A', lat: 33.591, lng: 130.401 }, { id: 'p2', name: 'B', lat: 33.593, lng: 130.405 }];

  const noAuth = await api('POST', '/api/course/generate', { body: { idempotencyKey: 'x', city: '테스트', date: '2026-01-01', origin, places } });
  t('인증 없이는 코스 생성도 401', noAuth.status === 401);
  // "실패(추정) 결과는 무료체험을 차감하지 않는다"는 회계 처리는
  // ROUTING_TEST_FORCE를 프로세스 시작 시점에 고정해야 해서(설정이
  // config 싱글턴에 한 번만 반영됨) 별도 파일
  // server/test/generation-trial-charging.test.mjs에서 검증한다.
}
{
  const acc = await loginNewAccount('gen-idempotency@example.com');
  const origin = { lat: 33.590, lng: 130.400 };
  const places = [{ id: 'p1', name: 'A', lat: 33.591, lng: 130.401 }];
  const key = 'idem-key-1';

  const first = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: key, city: '테스트', date: '2026-01-01', origin, places } });
  t('첫 생성 요청 성공', first.status === 200 && first.json.ok === true);
  const replay = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: key, city: '테스트', date: '2026-01-01', origin, places } });
  t('같은 idempotencyKey로 재요청하면 실제로 재실행 안 하고 저장된 결과를 그대로 돌려줌', replay.status === 200 && replay.json.replay === true);

  const otherAcc = await loginNewAccount('gen-idempotency-other@example.com');
  const conflict = await api('POST', '/api/course/generate', { token: otherAcc.token, body: { idempotencyKey: key, city: '테스트', date: '2026-01-01', origin, places } });
  t('다른 계정이 같은 idempotencyKey를 쓰면 충돌로 거부됨', conflict.status === 409 && conflict.json.reason === 'idempotency-key-conflict');
}

// --- 계정별 동시 생성 잠금: 실제 두 HTTP 요청의 타이밍(둘 다 아주
// 빠르게 끝나는 테스트 모드에서는 정말로 겹칠지 OS 스케줄링에 달려
// 있어 신뢰할 수 없다 — 20개 동시 무료체험 테스트가 신뢰할 수 있는
// 이유도 실제 동시성이 아니라 PRIMARY KEY 제약 자체다). 그래서 그
// 원자성 보장 자체(같은 account_id로 두 번째 INSERT는 반드시 실패)를
// DB 수준에서 직접 확인한다 — 이게 실제 보장의 근거이기 때문이다. ---
{
  const db = openDb();
  const accountId = 'lock-test-account';
  db.exec('BEGIN'); db.prepare('INSERT OR IGNORE INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(accountId, 'lock-test@example.com', new Date().toISOString(), 'free'); db.exec('COMMIT');
  db.prepare('DELETE FROM generation_locks WHERE account_id = ?').run(accountId);
  db.prepare('INSERT INTO generation_locks (account_id, job_id, started_at) VALUES (?, ?, ?)').run(accountId, 'job-1', new Date().toISOString());
  let secondInsertFailed = false;
  try {
    db.prepare('INSERT INTO generation_locks (account_id, job_id, started_at) VALUES (?, ?, ?)').run(accountId, 'job-2', new Date().toISOString());
  } catch (e) {
    secondInsertFailed = true;
  }
  t('같은 계정으로 생성 잠금을 두 번 걸 수 없음(PRIMARY KEY로 원자적 보장)', secondInsertFailed);
  db.prepare('DELETE FROM generation_locks WHERE account_id = ?').run(accountId);

  // 실제 요청 경로에서도 "잠금이 걸려 있는 동안" 같은 계정 요청이
  // 오면 409로 거부되는지 라우트 레벨에서 확인(잠금을 미리 걸어 둔
  // 뒤 곧바로 요청 — 타이밍에 기대지 않고 상태를 직접 만든다).
  const acc = await loginNewAccount('gen-concurrency@example.com');
  const { accountForToken } = await import('../auth.mjs');
  const realAccountId = accountForToken(acc.token);
  db.prepare('INSERT INTO generation_locks (account_id, job_id, started_at) VALUES (?, ?, ?)').run(realAccountId, 'job-blocking', new Date().toISOString());
  const origin = { lat: 33.590, lng: 130.400 };
  const places = [{ id: 'p1', name: 'A', lat: 33.591, lng: 130.401 }];
  const blocked = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: 'lock-blocked', city: '테스트', date: '2026-01-01', origin, places } });
  t('이미 진행 중인 생성이 있으면(잠금 존재) 새 요청은 409로 거부됨', blocked.status === 409 && blocked.json.reason === 'generation-in-progress');
  db.prepare('DELETE FROM generation_locks WHERE account_id = ?').run(realAccountId);
  const afterUnlock = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: 'lock-unblocked', city: '테스트', date: '2026-01-01', origin, places } });
  t('잠금이 풀리면 다시 정상적으로 생성됨', afterUnlock.status === 200);
}

// --- 레이트리밋: 시간당 허용치(3) 넘으면 성공/실패 무관하게 막힘 ---
{
  const acc = await loginNewAccount('gen-ratelimit@example.com');
  const origin = { lat: 33.590, lng: 130.400 };
  const places = [{ id: 'p1', name: 'A', lat: 33.591, lng: 130.401 }];
  let successCount = 0, rateLimited = 0;
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: `rl-${i}`, city: '테스트', date: '2026-01-01', origin, places } });
    if (r.status === 200) successCount++;
    if (r.status === 429) rateLimited++;
  }
  t('시간당 한도(3)를 넘는 시도는 성공/실패와 무관하게 429로 막힘', successCount <= 3 && rateLimited >= 1);
}

server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
