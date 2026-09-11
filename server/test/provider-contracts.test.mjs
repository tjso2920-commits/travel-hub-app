'use strict';
/**
 * 공급자 계약(요청/응답 모양) 검증 — 실제 네트워크를 부르지 않고
 * global.fetch를 가로채 "우리 코드가 문서대로 된 요청을 만드는지,
 * 문서대로 된 응답을 정확히 해석하는지"만 확인한다.
 *
 * **중요한 한계 고지**: 이 세션은 tosspayments/resend/google 공식 문서에
 * 직접 접속하지 못해(EGRESS_BLOCKED), 아래 "문서대로"라는 말은 전부
 * 학습된 지식 기준이다 — 실제 키를 넣기 전 사람이 현재 문서와 대조해야
 * 한다(각 어댑터 파일 상단 주석에도 같은 경고가 있다). 이 테스트가
 * 통과한다고 실제 서비스 연결이 검증된 게 아니다 — 우리 코드가 "우리가
 * 이해한 계약"대로 동작한다는 것만 보장한다.
 *
 * 실행: node server/test/provider-contracts.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.GOOGLE_ROUTES_API_KEY = 'fake-routes-key';
process.env.GOOGLE_PLACES_API_KEY = 'fake-places-key';
process.env.PAYMENT_PG_SECRET = 'fake-secret-key';
process.env.TOSS_CLIENT_KEY = 'fake-client-key';
process.env.EMAIL_API_KEY = 'fake-resend-key';

const { config } = await import('../config.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

t('사전 조건 — 이 테스트는 실제 real 모드에서 어댑터 코드를 태운다(payment)', config.services.payment === 'real');
t('사전 조건 — routing도 real', config.services.routing === 'real');
t('사전 조건 — email도 real', config.services.email === 'real');
t('사전 조건 — placeLookup도 real', config.services.placeLookup === 'real');

function mockFetchOnce(handler) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function ensureAccount(id) {
  const { openDb } = await import('../db.mjs');
  const db = openDb();
  db.prepare('INSERT OR IGNORE INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, id + '@example.com', new Date().toISOString(), 'free');
}

// ============================================================
// Resend — POST https://api.resend.com/emails, Bearer 인증
// ============================================================
{
  const { sendEmail } = await import('../adapters/email.mjs');
  const mock = mockFetchOnce((url) => jsonResponse(200, { id: 'email_123' }));
  const r = await sendEmail({ to: 'user@example.com', subject: '로그인 코드', body: '코드: 123456' });
  mock.restore();
  t('Resend — 엔드포인트가 문서 기준 URL(api.resend.com/emails)', mock.calls[0].url === 'https://api.resend.com/emails');
  t('Resend — POST 메서드 사용', mock.calls[0].init.method === 'POST');
  t('Resend — Authorization: Bearer 헤더로 API 키를 보냄', mock.calls[0].init.headers.Authorization === 'Bearer fake-resend-key');
  const sentBody = JSON.parse(mock.calls[0].init.body);
  t('Resend — 본문에 to가 배열로 들어감', Array.isArray(sentBody.to) && sentBody.to[0] === 'user@example.com');
  t('Resend — 본문에 from/subject가 들어감', !!sentBody.from && sentBody.subject === '로그인 코드');
  t('Resend — 성공 응답의 id를 그대로 반환', r.ok === true && r.id === 'email_123');
}
{
  const { sendEmail } = await import('../adapters/email.mjs');
  const mock = mockFetchOnce(() => jsonResponse(422, { message: 'invalid from address', name: 'validation_error' }));
  const r = await sendEmail({ to: 'user@example.com', subject: 'x', body: 'y' });
  mock.restore();
  t('Resend — 실패 응답(4xx)은 ok:false로 정직하게 반환', r.ok === false && r.status === 422);
}

// ============================================================
// 토스페이먼츠 — POST /v1/payments/confirm, Basic 인증(시크릿키:)
// ============================================================
{
  const { createOrder, confirmPayment } = await import('../adapters/payment-toss.mjs');
  await ensureAccount('acc_1');
  const order = createOrder('acc_1');
  t('주문 생성 — 서버가 orderId·금액을 authoritative하게 만들어 둠', !!order.orderId && order.amount === config.price.amountKrw);

  const mock = mockFetchOnce((url, init) => {
    return jsonResponse(200, { status: 'DONE', orderId: order.orderId, totalAmount: order.amount, currency: 'KRW', paymentKey: 'pay_key_1' });
  });
  const r = await confirmPayment({ accountId: 'acc_1', orderId: order.orderId, paymentKey: 'pay_key_1', amount: order.amount });
  mock.restore();
  t('토스 승인 — 엔드포인트가 문서 기준 경로(/v1/payments/confirm)', mock.calls[0].url.endsWith('/v1/payments/confirm'));
  t('토스 승인 — Basic 인증 헤더를 시크릿키로 구성함', mock.calls[0].init.headers.Authorization === 'Basic ' + Buffer.from('fake-secret-key:').toString('base64'));
  const sentBody = JSON.parse(mock.calls[0].init.body);
  t('토스 승인 — 본문에 paymentKey/orderId/amount를 보냄', sentBody.paymentKey === 'pay_key_1' && sentBody.orderId === order.orderId && sentBody.amount === order.amount);
  t('토스 승인 — 실제로 서버가 정한 금액을 그대로 씀(클라이언트가 준 값이 아니라 order.amount)', sentBody.amount === order.amount);
  t('승인 성공 시 ok:true', r.ok === true);
}
{
  // 서버가 authoritative하게 정한 금액과 다른 금액으로 confirm을
  // 시도하면 토스 API를 부르지도 않고 즉시 거부해야 한다(위조 방지).
  const { createOrder, confirmPayment } = await import('../adapters/payment-toss.mjs');
  await ensureAccount('acc_2');
  const order = createOrder('acc_2');
  const mock = mockFetchOnce(() => jsonResponse(200, { status: 'DONE' }));
  const r = await confirmPayment({ accountId: 'acc_2', orderId: order.orderId, paymentKey: 'pay_key_2', amount: 1 });
  mock.restore();
  t('금액이 서버 기록과 다르면 토스 API를 아예 안 부르고 거부(위조 방지)', r.ok === false && r.reason === 'amount-mismatch' && mock.calls.length === 0);
}
{
  // 다른 계정의 주문을 승인하려 하면 거부.
  const { createOrder, confirmPayment } = await import('../adapters/payment-toss.mjs');
  await ensureAccount('acc_owner');
  await ensureAccount('acc_intruder');
  const order = createOrder('acc_owner');
  const mock = mockFetchOnce(() => jsonResponse(200, { status: 'DONE' }));
  const r = await confirmPayment({ accountId: 'acc_intruder', orderId: order.orderId, paymentKey: 'pk', amount: order.amount });
  mock.restore();
  t('다른 계정 소유의 주문은 승인할 수 없음(계정 사칭 방지)', r.ok === false && r.reason === 'order-account-mismatch' && mock.calls.length === 0);
}

// ============================================================
// Google Routes — POST /directions/v2:computeRoutes, WALK 모드
// ============================================================
{
  const { computeWalkingRoute } = await import('../adapters/routing.mjs');
  const origin = { lat: 33.590, lng: 130.400 };
  const places = [{ id: 'p1', lat: 33.591, lng: 130.401 }, { id: 'p2', lat: 33.593, lng: 130.405 }];
  const mock = mockFetchOnce((url, init) => jsonResponse(200, {
    routes: [{ legs: [{ distanceMeters: 500, duration: '400s' }, { distanceMeters: 800, duration: '650s' }] }],
  }));
  const r = await computeWalkingRoute(origin, places);
  mock.restore();
  t('Google Routes — 엔드포인트가 문서 기준 경로(directions/v2:computeRoutes)', mock.calls[0].url.includes('/directions/v2:computeRoutes'));
  t('Google Routes — X-Goog-Api-Key 헤더로 키를 보냄', mock.calls[0].init.headers['X-Goog-Api-Key'] === 'fake-routes-key');
  t('Google Routes — X-Goog-FieldMask 헤더가 있음(없으면 응답이 비어 온다고 알려짐)', !!mock.calls[0].init.headers['X-Goog-FieldMask']);
  const sentBody = JSON.parse(mock.calls[0].init.body);
  t('Google Routes — travelMode가 WALK', sentBody.travelMode === 'WALK');
  t('Google Routes — optimizeWaypointOrder를 쓰지 않음(방문 순서는 우리가 직접 정함)', sentBody.optimizeWaypointOrder === false);
  t('실제 응답 legs를 그대로 실제 경로로 인정(routedReal=true)', r.routedReal === true);
  t('구간 수가 정거장 수와 일치', r.legs.length === 2);
}
{
  // 말이 안 되는 속도(자동차 프로필 오응답 의심) 응답은 실제 경로로 인정하지 않는다.
  const { computeWalkingRoute } = await import('../adapters/routing.mjs');
  const origin = { lat: 33.590, lng: 130.400 };
  const places = [{ id: 'p1', lat: 33.591, lng: 130.401 }];
  const mock = mockFetchOnce(() => jsonResponse(200, { routes: [{ legs: [{ distanceMeters: 5000, duration: '10s' }] }] }));
  const r = await computeWalkingRoute(origin, places);
  mock.restore();
  t('말이 안 되는 속도의 응답은 실제 경로로 인정 안 함(routedReal=false)', r.routedReal === false && r.fallbackReason === 'implausible-speed');
}
{
  // API 호출 실패 시 정직하게 추정으로 대체한다.
  const { computeWalkingRoute } = await import('../adapters/routing.mjs');
  const origin = { lat: 33.590, lng: 130.400 };
  const places = [{ id: 'p1', lat: 33.591, lng: 130.401 }];
  const mock = mockFetchOnce(() => jsonResponse(500, {}));
  const r = await computeWalkingRoute(origin, places);
  mock.restore();
  t('API 호출 실패 시 성공한 척 안 하고 추정으로 대체', r.routedReal === false);
}

// ============================================================
// Google Places API(New) — POST /v1/places:searchText, 필드마스크,
// 동명 장소는 지역 힌트로 판별(2026-09-10 재검토 4차 — Legacy Find
// Place에서 전환).
// ============================================================
{
  const { lookupPlace } = await import('../adapters/place-lookup.mjs');
  const mock = mockFetchOnce((url, init) => jsonResponse(200, {
    places: [{ id: 'place_1', displayName: { text: '스타벅스 강남점' }, formattedAddress: '서울 강남구 테헤란로', location: { latitude: 37.5, longitude: 127.0 } }],
  }));
  const r = await lookupPlace({ query: '스타벅스' });
  mock.restore();
  t('Places(New) — 엔드포인트가 문서 기준 경로(v1/places:searchText)', mock.calls[0].url.endsWith('/v1/places:searchText'));
  t('Places(New) — Legacy(findplacefromtext)를 더 이상 쓰지 않음', !mock.calls[0].url.includes('findplacefromtext'));
  t('Places(New) — X-Goog-Api-Key 헤더로 키를 보냄', mock.calls[0].init.headers['X-Goog-Api-Key'] === 'fake-places-key');
  // 2026-09-11 재검토(10차) 5절 — "이미 확보한 신뢰 가능한 장소 유형"을
  // 분류 우선순위에 쓰기 위해 types/primaryType을 필드마스크에 추가했다
  // (분류만을 위한 새 유료 조회를 만들지 않고, 이미 실행되는 이 호출에
  // 얹었다). 이 필드 추가가 과금 등급을 바꾸는지는 이 세션이 재확인
  // 못했다 — place-lookup.mjs 상단 주석 참고, 운영 전 재확인 필요.
  t('Places(New) — X-Goog-FieldMask 헤더로 필요한 필드만 요청함(과금 등급 최소화 + 10차 types/primaryType 추가)', mock.calls[0].init.headers['X-Goog-FieldMask'] === 'places.id,places.displayName,places.location,places.formattedAddress,places.types,places.primaryType');
  const sentBody = JSON.parse(mock.calls[0].init.body);
  t('Places(New) — 본문에 textQuery로 질의를 보냄', sentBody.textQuery === '스타벅스');
  t('실제 후보를 찾으면 좌표·이름·placeId를 반환', r.ok === true && r.lat === 37.5 && r.lng === 127.0 && r.placeId === 'place_1');
}
{
  // 동명 장소 여러 개 — 지역 힌트(expectedArea)와 실제로 주소가 겹치는
  // 후보를 우선한다(첫 번째 결과라는 이유만으로 확정하지 않는다).
  const { lookupPlace } = await import('../adapters/place-lookup.mjs');
  const mock = mockFetchOnce(() => jsonResponse(200, {
    places: [
      { id: 'place_busan', displayName: { text: '스타벅스' }, formattedAddress: '부산 해운대구', location: { latitude: 35.1, longitude: 129.0 } },
      { id: 'place_seoul', displayName: { text: '스타벅스' }, formattedAddress: '서울 강남구', location: { latitude: 37.5, longitude: 127.0 } },
    ],
  }));
  const r = await lookupPlace({ query: '스타벅스', expectedArea: '강남구' });
  mock.restore();
  t('동명 장소가 여러 개면 지역 힌트와 실제로 맞는 후보를 고름(첫 결과를 무조건 쓰지 않음)', r.placeId === 'place_seoul');
  t('지역 힌트로 확실히 좁혔으면 ambiguous가 아님', r.ambiguous === false);
  t('나머지 후보도 candidates로 함께 내려줌(향후 화면에서 직접 고를 수 있게)', Array.isArray(r.candidates) && r.candidates.length === 2);
}
{
  // 지역 힌트와 맞는 후보가 하나도 없으면 1순위를 쓰되 ambiguous로 표시한다.
  const { lookupPlace } = await import('../adapters/place-lookup.mjs');
  const mock = mockFetchOnce(() => jsonResponse(200, {
    places: [
      { id: 'place_a', displayName: { text: '스타벅스' }, formattedAddress: '부산 해운대구', location: { latitude: 35.1, longitude: 129.0 } },
      { id: 'place_b', displayName: { text: '스타벅스' }, formattedAddress: '대구 중구', location: { latitude: 35.8, longitude: 128.6 } },
    ],
  }));
  const r = await lookupPlace({ query: '스타벅스', expectedArea: '강남구' });
  mock.restore();
  t('힌트와 맞는 후보가 없으면 1순위를 쓰되 ambiguous로 표시함(자동 확정 아님)', r.placeId === 'place_a' && r.ambiguous === true);
}
{
  const { lookupPlace } = await import('../adapters/place-lookup.mjs');
  const mock = mockFetchOnce(() => jsonResponse(200, { places: [] }));
  const r = await lookupPlace({ query: '존재하지않는곳' });
  mock.restore();
  t('후보가 없으면 지어내지 않고 not-found로 정직하게 답함', r.ok === false && r.reason === 'not-found');
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
