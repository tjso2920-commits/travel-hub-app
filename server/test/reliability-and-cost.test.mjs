'use strict';
/**
 * 2026-09-10 재검토(4차) 통합 지시 8절 — 지정된 회귀 시나리오를 재현
 * 하는 전용 테스트. 실제 HTTP 서버(임시 포트)와 실제 DB(인메모리)로
 * 검증하고, 외부 공급자만 fetch를 가로채 모의한다(계약 테스트와 같은
 * 원칙 — 우리 쪽 코드 경로는 전부 진짜로 실행된다).
 *
 * 실행: node server/test/reliability-and-cost.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'production';
process.env.PAYMENT_PG_SECRET = 'fake-secret';
process.env.TOSS_CLIENT_KEY = 'fake-client-key';
process.env.PAYMENT_WEBHOOK_SECRET = 'real-webhook-secret';
process.env.EMAIL_API_KEY = 'fake-resend-key';
process.env.GENERATION_LOCK_TIMEOUT_SECONDS = '1';
process.env.PAYMENT_LOCK_TIMEOUT_SECONDS = '1';
process.env.COST_PLACES_TEXT_SEARCH_KRW_MICROS = '1000000'; // 1원 — 한도 계산을 간단히 하기 위해 작게
process.env.COST_ROUTES_COMPUTE_KRW_MICROS = '1000000';
process.env.COST_ROUTES_COMPUTE_HIGHVOLUME_KRW_MICROS = '3000000';
process.env.COST_PER_ACCOUNT_DAILY_KRW_MICROS = '5000000'; // 계정당 하루 5원 — 곧 소진되게
process.env.COST_GLOBAL_DAILY_KRW_MICROS = '0'; // 이 테스트에선 전체 일일 한도는 끔(계정 한도만 본다)
process.env.COST_GLOBAL_MONTHLY_KRW_MICROS = '0';

const { createServer } = await import('../index.mjs');
const { openDb } = await import('../db.mjs');
const { config } = await import('../config.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}

function mockFetchSequence(handlers) {
  let i = 0;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const h = handlers[Math.min(i, handlers.length - 1)];
    i++;
    return h(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}
function jsonResponse(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }

async function directAccount(email) {
  const db = openDb();
  const { uuid, nowIso } = await import('../db.mjs');
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}
function directSession(accountId) {
  const db = openDb();
  const crypto = globalThis.crypto || require('node:crypto');
  const token = Buffer.from(String(Math.random())).toString('hex') + accountId;
  db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, accountId, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
  return token;
}

// ============================================================
// 1. 운영에서 경로 키 누락 시 가짜 실제 경로·체험 차감 없음
//    (ChatGPT가 실제로 재현한 버그의 회귀 방지 — routing.mjs의
//    services.routing==='unavailable' 분기가 시뮬레이터로 안 빠지는지)
// ============================================================
{
  t('사전 조건 — 이 테스트는 운영 환경(production)', config.isProd === true);
  t('사전 조건 — 경로 API 키가 없어 routing은 unavailable', config.services.routing === 'unavailable');

  const { computeWalkingRoute } = await import('../adapters/routing.mjs');
  const origin = { lat: 33.59, lng: 130.40 };
  const places = [{ id: 'synthetic', lat: 33.6001, lng: 130.41 }];
  const r = await computeWalkingRoute(origin, places, 'no-such-account');
  t('운영+키없음에서 실제 경로 성공(routedReal=true)이 나오지 않음(예전엔 시뮬레이터가 이걸 만들어냈다)', r.routedReal === false);
  t('정직한 사유(unavailable)로 표시됨', r.fallbackReason === 'routing-service-unavailable');

  // 실제 생성 엔드포인트까지 — 설정 함수 단위 검증만으로 끝내지 않는다.
  const accId = await directAccount('prod-route-missing@example.com');
  const token = directSession(accId);
  const gen = await api('POST', '/api/course/generate', {
    token,
    body: { idempotencyKey: 'k-prod-1', city: '테스트', date: '2026-01-01', origin, places: [{ id: 'p1', name: 'A', lat: 33.6001, lng: 130.41 }] },
  });
  t('실제 생성 엔드포인트도 routedReal=false로 정직하게 응답', gen.status === 200 && gen.json.course.routedReal === false);
  t('추정 결과라 무료체험이 차감되지 않음', gen.json.trialConsumed === false);
  const trialRow = openDb().prepare('SELECT * FROM trial_usage WHERE account_id = ?').get(accId);
  t('trial_usage 테이블에도 실제로 소진 기록이 없음', !trialRow);
}

// ============================================================
// 1-2. 승인 응답 유실(네트워크 오류) — 실제로는 토스 쪽에서 이미
//      승인이 완료된 상황. confirm 자체는 실패해도 무조건 실패로
//      단정하지 않고 조회 API로 실제 상태를 확인해 성공으로 되살린다.
// ============================================================
{
  const { createOrder, confirmPayment } = await import('../adapters/payment-toss.mjs');
  const { checkEntitlement } = await import('../routes/entitlement.mjs');
  const acc = await directAccount('confirm-lost-response@example.com');
  const order = createOrder(acc);

  const mock = mockFetchSequence([
    () => { throw new Error('simulated network timeout'); }, // 1번째 호출: confirm 자체가 실패
    () => jsonResponse(200, { status: 'DONE', orderId: order.orderId, totalAmount: order.amount, currency: 'KRW', paymentKey: 'pk_lost' }), // 2번째: 조회로 확인
  ]);
  const r = await confirmPayment({ accountId: acc, orderId: order.orderId, paymentKey: 'pk_lost', amount: order.amount });
  mock.restore();
  t('승인 응답이 네트워크 오류로 유실돼도 조회 API로 실제 상태를 확인해 성공으로 되살림', r.ok === true && mock.calls.length === 2);
  t('실제로 이용권이 부여됨(무조건 실패 확정하지 않은 결과)', checkEntitlement(acc).plan === 'paid');
}
{
  // 대조군 — confirm도 실패하고 조회도 DONE이 아니면 진짜 실패로 처리하되,
  // status를 failed로 확정 짓지 않고 재시도 여지를 남긴다(pending 유지).
  const { createOrder, confirmPayment } = await import('../adapters/payment-toss.mjs');
  const acc = await directAccount('confirm-really-failed@example.com');
  const order = createOrder(acc);
  const mock = mockFetchSequence([
    () => { throw new Error('simulated network timeout'); },
    () => jsonResponse(200, { status: 'IN_PROGRESS' }),
  ]);
  const r = await confirmPayment({ accountId: acc, orderId: order.orderId, paymentKey: 'pk_still_pending', amount: order.amount });
  mock.restore();
  t('조회로도 완료가 확인 안 되면 재시도 가능한 상태로 실패 응답(확정 실패로 낙인 안 찍음)', r.ok === false && r.reason === 'confirm-status-unknown-retry-later');
  const orderRow = openDb().prepare('SELECT status FROM orders WHERE order_id = ?').get(order.orderId);
  t('주문 상태가 함부로 failed로 확정되지 않고 pending으로 남아 재시도 가능', orderRow.status === 'pending');
}

// ============================================================
// 2. 다른 계정 주문 취소 불가 + 승인 유실/타임아웃 재조회 + 부분취소
//    ≠ 전액취소 + 과거 주문 취소가 다른 유효 이용권을 안 건드림 +
//    중복·지연 웹훅 처리
// ============================================================
{
  const { createOrder, confirmPayment, cancelPayment, handleTossWebhookEvent } = await import('../adapters/payment-toss.mjs');
  const { checkEntitlement } = await import('../routes/entitlement.mjs');

  const accA = await directAccount('cancel-owner@example.com');
  const accB = await directAccount('cancel-intruder@example.com');

  const order1 = createOrder(accA);
  {
    const mock = mockFetchSequence([() => jsonResponse(200, { status: 'DONE', orderId: order1.orderId, totalAmount: order1.amount, currency: 'KRW', paymentKey: 'pk_1' })]);
    const r = await confirmPayment({ accountId: accA, orderId: order1.orderId, paymentKey: 'pk_1', amount: order1.amount });
    mock.restore();
    t('첫 주문 승인 성공', r.ok === true);
  }
  t('승인 뒤 실제로 유료 상태', checkEntitlement(accA).plan === 'paid');

  {
    const mock = mockFetchSequence([() => jsonResponse(200, {})]);
    const r = await cancelPayment({ accountId: accB, paymentKey: 'pk_1', cancelReason: 'x' });
    mock.restore();
    t('다른 계정은 이 주문을 취소할 수 없음(계정 대조 실패)', r.ok === false && r.status === 403 && r.reason === 'order-account-mismatch' && mock.calls.length === 0);
  }
  t('취소 시도가 거부됐으니 이용권은 그대로 유지됨', checkEntitlement(accA).plan === 'paid');

  // 승인 응답이 네트워크 오류로 유실됐지만 실제로는 토스 쪽에서 이미
  // 승인이 완료된 상황 — 곧바로 실패로 단정하지 않고 조회 API로 확인해
  // 성공으로 되살려야 한다.
  const order2 = createOrder(accA); // 활성 이용권이 있어 거부될 수 있으니 먼저 확인
  t('활성 이용권이 있으면 새 주문 생성 자체가 거부됨(중복 구매 방지)', order2.ok === false && order2.reason === 'already-has-active-entitlement');

  // 중복 구매 검증을 마쳤으니 이 계정의 이용권을 취소해 두고 이어서 검증한다.
  {
    const mock = mockFetchSequence([() => jsonResponse(200, { status: 'CANCELED' })]);
    const r = await cancelPayment({ accountId: accA, paymentKey: 'pk_1', cancelReason: '테스트 정리' });
    mock.restore();
    t('정당한 소유자의 전액 취소는 성공', r.ok === true && r.entitlementRevoked === true);
  }
  t('전액 취소 후에는 free로 전환됨', checkEntitlement(accA).plan === 'free');

  // 이제 재구매 — 새 주문(order3)이 실제로 지금 유효한 이용권의 근거가
  // 된다. 그 뒤에 "과거 주문"(order1/pk_1)에 대한 지연 웹훅이 뒤늦게
  // 와도 지금의 새 이용권을 건드리면 안 된다.
  const order3 = createOrder(accA);
  t('취소 후에는 다시 주문을 만들 수 있음', order3.ok === true);
  {
    const mock = mockFetchSequence([() => jsonResponse(200, { status: 'DONE', orderId: order3.orderId, totalAmount: order3.amount, currency: 'KRW', paymentKey: 'pk_3' })]);
    const r = await confirmPayment({ accountId: accA, orderId: order3.orderId, paymentKey: 'pk_3', amount: order3.amount });
    mock.restore();
    t('재구매 승인 성공', r.ok === true);
  }
  {
    // pk_1(이미 취소된 옛 주문)에 대한 지연된 취소 웹훅이 뒤늦게 도착.
    const mock = mockFetchSequence([() => jsonResponse(200, { status: 'CANCELED', orderId: order1.orderId, totalAmount: order1.amount, currency: 'KRW' })]);
    const r = await handleTossWebhookEvent({ paymentKey: 'pk_1' });
    mock.restore();
    t('과거(이미 취소된) 주문의 지연 웹훅은 정상 처리됨', r.ok === true);
  }
  t('과거 주문의 지연 웹훅이 지금의 새 이용권(order3)을 건드리지 않음', checkEntitlement(accA).plan === 'paid');

  // 같은 성공 웹훅이 중복으로 두 번 온다 — 두 번째는 아무 부작용 없이 멱등하게 처리.
  {
    const mock = mockFetchSequence([() => jsonResponse(200, { status: 'DONE', orderId: order3.orderId, totalAmount: order3.amount, currency: 'KRW' })]);
    const r1 = await handleTossWebhookEvent({ paymentKey: 'pk_3' });
    const r2 = await handleTossWebhookEvent({ paymentKey: 'pk_3' });
    mock.restore();
    t('같은 성공 웹훅이 중복으로 와도 둘 다 정상 응답(멱등)', r1.ok === true && r2.ok === true);
  }
  t('중복 웹훅 처리 후에도 이용권 상태는 그대로 paid', checkEntitlement(accA).plan === 'paid');

  // 부분 취소 — 전액 취소와 다르게 이용권을 자동으로 건드리지 않는다.
  const orderP = { ...order3 };
  {
    const mock = mockFetchSequence([() => jsonResponse(200, { status: 'PARTIAL_CANCELED' })]);
    const r = await cancelPayment({ accountId: accA, paymentKey: 'pk_3', cancelReason: '부분 환불 테스트', cancelAmount: Math.floor(order3.amount / 2) });
    mock.restore();
    t('부분 취소는 전액 취소와 다른 결과를 돌려줌', r.ok === true && r.partial === true && r.entitlementUnchanged === true);
  }
  t('부분 취소는 이용권을 자동으로 회수하지 않음(정책 미확정 — 문서에 별도 보고)', checkEntitlement(accA).plan === 'paid');
}

// ============================================================
// 3. 결제 승인 동시 요청 — order 단위 잠금으로 중복 승인 호출 방지
// ============================================================
{
  const { createOrder, confirmPayment } = await import('../adapters/payment-toss.mjs');
  const acc = await directAccount('confirm-concurrency@example.com');
  const order = createOrder(acc);
  const db = openDb();
  // 잠금을 미리 걸어 둔다(동시 두 번째 요청이 온 상황을 재현).
  db.prepare('INSERT INTO payment_locks (order_id, job_id, started_at) VALUES (?, ?, ?)').run(order.orderId, 'other-job', new Date().toISOString());
  const mock = mockFetchSequence([() => jsonResponse(200, { status: 'DONE', orderId: order.orderId, totalAmount: order.amount, currency: 'KRW' })]);
  const r = await confirmPayment({ accountId: acc, orderId: order.orderId, paymentKey: 'pk_concurrent', amount: order.amount });
  mock.restore();
  t('이미 승인 처리 중이면 실제 토스 호출 없이 409로 거부', r.ok === false && r.status === 409 && r.reason === 'confirm-in-progress' && mock.calls.length === 0);
  db.prepare('DELETE FROM payment_locks WHERE order_id = ?').run(order.orderId);

  // 잠금이 오래돼(죽은 프로세스로 추정) 만료됐으면 회수하고 정상 진행돼야 한다.
  db.prepare('INSERT INTO payment_locks (order_id, job_id, started_at) VALUES (?, ?, ?)').run(order.orderId, 'dead-job', new Date(Date.now() - 10_000).toISOString());
  const mock2 = mockFetchSequence([() => jsonResponse(200, { status: 'DONE', orderId: order.orderId, totalAmount: order.amount, currency: 'KRW' })]);
  const r2 = await confirmPayment({ accountId: acc, orderId: order.orderId, paymentKey: 'pk_recovered', amount: order.amount });
  mock2.restore();
  t('오래된(죽은 프로세스로 추정) 결제 잠금은 회수되어 정상 진행됨', r2.ok === true && mock2.calls.length === 1);
}

// ============================================================
// 4. 코스 생성 — 저장 실패 시 체험 미차감·재시도 가능, 멱등키 본문
//    불일치 충돌, 잠금 만료 회수
// ============================================================
{
  const acc = await directAccount('gen-reliability@example.com');
  const token = directSession(acc);
  const origin = { lat: 33.59, lng: 130.40 };
  const places = [{ id: 'p1', name: 'A', lat: 33.6001, lng: 130.41 }];

  // 같은 idempotencyKey, 다른 요청 본문(장소가 다름) — 충돌로 처리.
  const first = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-mismatch', city: 'X', date: '2026-01-01', origin, places } });
  t('첫 생성 성공', first.status === 200);
  const differentBody = await api('POST', '/api/course/generate', {
    token, body: { idempotencyKey: 'k-mismatch', city: 'X', date: '2026-01-01', origin, places: [{ id: 'p2', name: 'B', lat: 33.61, lng: 130.42 }] },
  });
  t('같은 멱등키에 실제로 다른 요청 본문이 오면 충돌(409)로 거부', differentBody.status === 409 && differentBody.json.reason === 'idempotency-key-body-mismatch');
  const sameBody = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-mismatch', city: 'X', date: '2026-01-01', origin, places } });
  t('같은 멱등키에 정말 같은 본문이 다시 오면 저장된 결과를 그대로 재생', sameBody.status === 200 && sameBody.json.replay === true);

  // 잠금이 오래됐으면(죽은 프로세스로 추정) 회수하고 다시 생성할 수 있어야 한다.
  const db = openDb();
  db.prepare('DELETE FROM generation_locks WHERE account_id = ?').run(acc);
  db.prepare('INSERT INTO generation_locks (account_id, job_id, started_at) VALUES (?, ?, ?)').run(acc, 'dead-job', new Date(Date.now() - 10_000).toISOString());
  const afterStaleLock = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-after-stale-lock', city: 'X', date: '2026-01-02', origin, places } });
  t('생성 도중 프로세스가 죽어 남은 오래된 잠금은 회수되고 정상 생성됨', afterStaleLock.status === 200);
  const staleLockRow = db.prepare('SELECT * FROM generation_locks WHERE account_id = ?').get(acc);
  t('생성이 끝난 뒤에는 잠금이 정상적으로 풀려 있음', !staleLockRow);

  // 입력 검증 — 상식 밖의 좌표·개수·시간 예산은 거부한다.
  const badCoords = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-bad-1', city: 'X', date: '2026-01-01', origin: { lat: 999, lng: 130 }, places } });
  t('좌표 범위를 벗어나면 거부(위도 999)', badCoords.status === 400 && badCoords.json.reason === 'invalid-origin-coords');
  const tooMany = Array.from({ length: config.maxPlacesPerGeneration + 1 }, (_, i) => ({ id: 'm' + i, lat: 33.6, lng: 130.4 }));
  const badCount = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-bad-2', city: 'X', date: '2026-01-01', origin, places: tooMany } });
  t('장소 개수 상한을 넘으면 거부', badCount.status === 400 && badCount.json.reason === 'too-many-places');
  const badBudget = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-bad-3', city: 'X', date: '2026-01-01', origin, places, budgetMinutes: 999999 } });
  t('시간 예산이 상식 밖이면 거부', badBudget.status === 400 && badBudget.json.reason === 'invalid-budget-minutes');
}

// ============================================================
// 5. 300곳 가져오기만 했을 때 유료 장소 조회 0회 — 가져오기(저장)
//    자체는 lookup 어댑터를 절대 호출하지 않는다.
// ============================================================
{
  const acc = await directAccount('import-300@example.com');
  const token = directSession(acc);
  const places = Array.from({ length: 300 }, (_, i) => ({ id: 'imp' + i, name: '장소' + i, cat: '기타' }));
  const before = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
  const r = await api('PUT', '/api/places', { token, body: { places } });
  t('300곳 저장 성공', r.status === 200 && r.json.count === 300);
  const after = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
  t('300곳을 저장(가져오기)만 했을 때 유료 장소 조회 비용이 전혀 기록되지 않음(0건)', after === before);
}

// ============================================================
// 6. 필요한 장소만 조회 + 반복·동시 요청의 중복 호출 방지(캐시)
// ============================================================
{
  const acc = await directAccount('lookup-dedup@example.com');
  const token = directSession(acc);
  const before = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger WHERE service = ?').get('places').n;
  const first = await api('GET', `/api/places/lookup?q=${encodeURIComponent('중복조회테스트장소')}`, { token });
  const second = await api('GET', `/api/places/lookup?q=${encodeURIComponent('중복조회테스트장소')}`, { token });
  const after = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger WHERE service = ?').get('places').n;
  t('완전히 같은 질의를 반복해도 실제 유료 조회는 한 번만 기록됨(두 번째는 캐시)', after - before === 1);
  t('두 요청 모두 정상 응답(캐시 여부와 무관하게 결과는 동일하게 옴)', first.status === 200 && second.status === 200);
}

// ============================================================
// 7. 비용 한도 초과 시 외부 호출 차단 + 한도 도달 후에도 기존 데이터 열람 가능
// ============================================================
{
  const acc = await directAccount('cost-budget@example.com');
  const token = directSession(acc);
  // 계정당 하루 5원, 조회 1건당 1원 — 5건까지는 되고 6번째부터 막힌다.
  let okCount = 0, blockedStatus = null;
  for (let i = 0; i < 7; i++) {
    const r = await api('GET', `/api/places/lookup?q=${encodeURIComponent('예산테스트장소' + i)}`, { token });
    if (r.status === 200) okCount++;
    else if (blockedStatus === null) blockedStatus = r;
  }
  t('계정별 비용 한도 안에서는 정상 처리됨(5건)', okCount === 5);
  t('비용 한도를 넘으면 외부 호출 없이 차단됨(503)', blockedStatus && blockedStatus.status === 503 && blockedStatus.json.reason === 'cost-budget-exceeded');

  // 한도에 걸린 뒤에도 이미 저장해 둔 장소·코스 열람(서버 게이트를 안 타는
  // 순수 조회)은 전혀 영향을 안 받는다.
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'saved1', name: '이미 저장된 곳' }] } });
  const viewAfterBlocked = await api('GET', '/api/places', { token });
  t('비용 한도 초과 후에도 이미 저장된 장소 열람은 그대로 됨(새 외부조회가 아니므로)', viewAfterBlocked.status === 200 && viewAfterBlocked.json.places.length === 1);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
