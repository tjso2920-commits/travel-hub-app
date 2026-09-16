'use strict';
/**
 * 자전거 공유 반납 포트 안내(차리차리 등) — 서버 라우트 검증(실제
 * 경로 성공 경로 — 실패/미지원 시 숫자 미생성 검증은
 * bike-ports-bicycle-fallback.test.mjs에 분리했다. config는 프로세스
 * 시작 시 한 번만 env를 읽으므로 같은 파일 안에서 ROUTING_TEST_FORCE
 * 값을 바꿔 가며 테스트할 수 없다 — 기존
 * generation-trial-charging-success/failure.test.mjs와 같은 분리
 * 원칙).
 *
 * 실행: node server/test/bike-ports.test.mjs
 * 실제 스크래핑 데이터는 전혀 쓰지 않는다 — 여기 넣는 포트는 전부
 * 합성(가짜) 좌표다(00_READ_FIRST_CLAUDE.md 7절 — "실제 데이터 테스트
 * 픽스처는 합성 자료로 대체").
 */
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'success';

const { createServer } = await import('../index.mjs');
const { sentEmailsForTest } = await import('../adapters/email.mjs');
const { openDb, nowIso } = await import('../db.mjs');
const { setTestAccessByEmail } = await import('../routes/entitlement.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}
async function login(email) {
  await api('POST', '/api/auth/request-code', { body: { email } });
  const code = sentEmailsForTest.filter((e) => e.to === email).pop().body.match(/(\d{6})/)[1];
  return (await api('POST', '/api/auth/verify-code', { body: { email, code } })).json;
}

// 합성 후쿠오카 근처 포트 3곳을 직접 DB에 넣는다(실 데이터 없이 재현).
function seedSyntheticPorts() {
  const db = openDb();
  const now = nowIso();
  const rows = [
    ['charichari', 'FUK', 'TEST-A', '합성 포트 A', '합성주소 A', 10, 33.590, 130.401],
    ['charichari', 'FUK', 'TEST-B', '합성 포트 B', '합성주소 B', 5, 33.600, 130.410],
    ['charichari', 'FUK', 'TEST-C', '합성 포트 C', '합성주소 C', 20, 33.700, 130.500],
  ];
  const insert = db.prepare(`INSERT INTO bike_share_ports (provider_id, region_code, port_id, title, address, capacity, lat, lng, imported_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) insert.run(...r, now);
  db.prepare(`INSERT INTO bike_share_import_meta (provider_id, region_code, source_url, endpoint, retrieved_at, port_count, imported_at) VALUES (?,?,?,?,?,?,?)`)
    .run('charichari', 'FUK', 'https://example.invalid/map', 'https://example.invalid/graphql', now, rows.length, now);
}
seedSyntheticPorts();

const acc = await login('bike-guide@example.com');

// --- 0) 2026-09-16 재검토 5절 — 승인 안 된 일반 계정은 활성 지역이
// 있어도(officialMapUrl은 보이되) 실제 포트 데이터를 하나도 못 봄.
// 상업적 재사용 조건이 확인되기 전까지는 기본값이 "외부 공개 비활성"
// 이어야 하고, 인증된 API를 직접 호출해도(우회 시도) 서버가 막아야 한다.
{
  const status = await api('GET', '/api/bike-ports/status', { token: acc.token });
  const region = status.json.regions.find((x) => x.regionCode === 'FUK');
  t('0) 일반 계정은 시딩된 실제 건수를 못 봄(0으로 가려짐)', region.portCount === 0 && region.realDataAccess === false);
  t('0) 일반 계정도 공식 지도 주소는 그대로 봄(대체 안내용)', typeof region.officialMapUrl === 'string' && region.officialMapUrl.includes('charichari.bike'));

  const nearby = await api('GET', `/api/bike-ports/nearby?providerId=charichari&regionCode=FUK&lat=33.5905&lng=130.4015`, { token: acc.token });
  t('0) 일반 계정은 지역이 활성이라 200은 오지만 포트 목록은 빔(직접 호출 우회 불가)', nearby.status === 200 && nearby.json.ports.length === 0 && nearby.json.realDataAccess === false);
  t('0) 빈 목록이어도 공식 지도 링크는 옴(화면이 기존 "후보 없음" 대체 화면으로 자연스럽게 이어짐)', typeof nearby.json.officialMapUrl === 'string');

  const guide = await api('POST', '/api/bike-ports/guide', { token: acc.token, body: {
    idempotencyKey: 'guide-blocked-1', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-A',
    origin: { lat: 33.5905, lng: 130.4015 }, destination: { lat: 33.592, lng: 130.403 },
  } });
  t('0) 일반 계정은 안내 생성 자체가 403으로 막힘', guide.status === 403 && guide.json.reason === 'real-data-access-required');
  t('0) 막힌 응답에도 공식 지도 링크는 옴', typeof guide.json.officialMapUrl === 'string');
}

// 이제부터는 운영자가 이 계정을 실제 데이터 확인용으로 승인했다고
// 가정한다(기존 test_access 재사용 — 새 승인 플래그를 안 만든다).
setTestAccessByEmail('bike-guide@example.com', true);

// --- 1) 활성 지역 상태 ---
{
  const r = await api('GET', '/api/bike-ports/status', { token: acc.token });
  t('1) 활성 지역 목록에 charichari/FUK가 실제로 보임', r.status === 200 && r.json.regions.some((x) => x.providerId === 'charichari' && x.regionCode === 'FUK'));
  const region = r.json.regions.find((x) => x.regionCode === 'FUK');
  t('1) 승인된 계정은 시딩한 합성 포트 3곳이 그대로 카운트됨', region.portCount === 3 && region.realDataAccess === true);
  t('1) 공식 지도 주소가 함께 내려옴', typeof region.officialMapUrl === 'string' && region.officialMapUrl.includes('charichari.bike'));
}

// --- 2) 근접 포트 조회(무료, 직선거리 정렬) ---
{
  const r = await api('GET', `/api/bike-ports/nearby?providerId=charichari&regionCode=FUK&lat=33.5905&lng=130.4015&limit=2`, { token: acc.token });
  t('2) 요청한 limit만큼만 옴', r.status === 200 && r.json.ports.length === 2);
  t('2) 가장 가까운 합성 포트 A가 첫 번째로 옴', r.json.ports[0].id === 'TEST-A');
  t('2) 거리가 오름차순으로 정렬됨', r.json.ports[0].distanceMeters <= r.json.ports[1].distanceMeters);
  t('2) capacity가 그대로 노출됨(가용 대수 아님 — 화면 표기 책임은 클라이언트)', r.json.ports[0].capacity === 10);

  const inactive = await api('GET', `/api/bike-ports/nearby?providerId=charichari&regionCode=TOK&lat=35&lng=139`, { token: acc.token });
  t('2) 등록 안 된(활성 아닌) 지역은 404', inactive.status === 404 && inactive.json.reason === 'region-not-active');

  const missing = await api('GET', `/api/bike-ports/nearby?providerId=charichari&regionCode=FUK`, { token: acc.token });
  t('2) 좌표 없이 요청하면 400', missing.status === 400 && missing.json.reason === 'invalid-coords');
}

// --- 3) 안내 생성 — 실제 성공(두 구간 다 성공, 시뮬레이션) ---
{
  const origin = { lat: 33.5905, lng: 130.4015 };
  const destination = { lat: 33.592, lng: 130.403 };
  const r = await api('POST', '/api/bike-ports/guide', { token: acc.token, body: {
    idempotencyKey: 'guide-1', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-A', origin, destination,
  } });
  t('3) 안내 생성 200', r.status === 200);
  t('3) 자전거 구간이 실제 성공으로 표시됨', r.json.guide.bikeLeg.real === true);
  t('3) 자전거 구간 성공 시 거리·시간 숫자가 있음', typeof r.json.guide.bikeLeg.distanceMeters === 'number' && typeof r.json.guide.bikeLeg.seconds === 'number');
  t('3) 도보 구간이 실제 성공으로 표시됨', r.json.guide.walkLeg.real === true);
  t('3) 무료체험이 차감됨(두 구간이라도 1회)', r.json.trialConsumed === true);

  const replay = await api('POST', '/api/bike-ports/guide', { token: acc.token, body: {
    idempotencyKey: 'guide-1', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-A', origin, destination,
  } });
  t('3) 같은 idempotencyKey 재요청은 재생(replay)될 뿐 다시 안 만듦', replay.status === 200 && replay.json.replay === true);

  const usage = await api('GET', '/api/account/usage', { token: acc.token });
  t('3) 재생은 사용량을 추가로 안 늘림(코스 성공 카운트 1)', usage.json.courseGenerations.used === 1);

  const second = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: 'course-after-guide', city: 'X', date: '2026-01-01', origin, places: [{ id: 'p1', name: 'A', lat: 33.593, lng: 130.404 }] } });
  t('3) 무료체험을 이미 썼으니 이후 코스 생성 시도는 결제 필요(402)', second.status === 402 && second.json.reason === 'payment-required');
}

// --- 4) 다른 포트로 안내를 다시 만들면 새 idempotencyKey라 새로 계산됨
// (재계산 자체는 화면 문구 책임 — 서버는 그냥 새 요청으로 처리) ---
{
  const acc2 = await login('bike-guide-recalc@example.com');
  setTestAccessByEmail('bike-guide-recalc@example.com', true);
  const origin = { lat: 33.5905, lng: 130.4015 };
  const destination = { lat: 33.592, lng: 130.403 };
  const first = await api('POST', '/api/bike-ports/guide', { token: acc2.token, body: {
    idempotencyKey: 'guide-recalc-A', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-A', origin, destination,
  } });
  const second = await api('POST', '/api/bike-ports/guide', { token: acc2.token, body: {
    idempotencyKey: 'guide-recalc-B', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-B', origin, destination,
  } });
  t('4) 첫 요청은 고른 포트 기준으로 새로 계산됨', first.status === 200 && first.json.guide.portId === 'TEST-A');
  t('4) 하지만 이용권 차감은 첫 성공(무료체험)에서만 — 다른 포트로 다시 요청하면 결제 필요', second.status === 402 && second.json.reason === 'payment-required');
}

// --- 5) 존재하지 않는 포트 ---
{
  const acc3 = await login('bike-guide-3@example.com');
  setTestAccessByEmail('bike-guide-3@example.com', true);
  const r = await api('POST', '/api/bike-ports/guide', { token: acc3.token, body: {
    idempotencyKey: 'guide-3', providerId: 'charichari', regionCode: 'FUK', portId: 'NOPE', origin: { lat: 33.59, lng: 130.40 }, destination: { lat: 33.6, lng: 130.41 },
  } });
  t('5) 없는 포트 id는 404', r.status === 404 && r.json.reason === 'port-not-found');
}

// --- 5b) 2026-09-16 재검토 5절 — "저장 결과 재조회도 같은 권한 검사
// 적용." 승인이 나중에 거둬지면, 예전에 이미 성공해 저장된
// idempotencyKey를 재생(replay) 요청해도 더는 볼 수 없어야 한다(승인이
// 있을 때 만든 guide-1을 재사용). ---
{
  setTestAccessByEmail('bike-guide@example.com', false);
  const origin = { lat: 33.5905, lng: 130.4015 };
  const destination = { lat: 33.592, lng: 130.403 };
  const replayAfterRevoke = await api('POST', '/api/bike-ports/guide', { token: acc.token, body: {
    idempotencyKey: 'guide-1', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-A', origin, destination,
  } });
  t('5b) 승인이 거둬지면 예전에 저장된 재생 결과도 다시 못 봄', replayAfterRevoke.status === 403 && replayAfterRevoke.json.reason === 'real-data-access-required');
  setTestAccessByEmail('bike-guide@example.com', true); // 이후 계정 사용량 확인(usage 3절)에 영향 없게 원복
}

// --- 6) 인증 없이 접근 차단 ---
{
  const r1 = await api('GET', '/api/bike-ports/status');
  t('6) 인증 없이 상태 조회 401', r1.status === 401);
  const r2 = await api('GET', '/api/bike-ports/nearby?providerId=charichari&regionCode=FUK&lat=33&lng=130');
  t('6) 인증 없이 근접 조회 401', r2.status === 401);
  const r3 = await api('POST', '/api/bike-ports/guide', { body: { idempotencyKey: 'x', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-A', origin: { lat: 33, lng: 130 }, destination: { lat: 33, lng: 130 } } });
  t('6) 인증 없이 안내 생성 401', r3.status === 401);
}

console.log(fail === 0 ? '\n전체 통과' : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
