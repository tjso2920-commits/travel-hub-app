'use strict';
/**
 * 자전거 구간이 미지원/실패했을 때 절대 숫자(거리·시간)를 만들지
 * 않는지 검증한다(00_READ_FIRST_CLAUDE.md 4절 — "지원되지 않으면
 * 시간을 생성하거나 도보 경로를 자전거 경로로 바꾸지 말고 외부 지도
 * 확인으로 대체"). 도보 어댑터의 정직한 추정(estimateFallback)과는
 * 원칙이 다르므로 별도 파일로 분리했다 — bike-ports.test.mjs(성공
 * 경로)와 같은 이유로 ROUTING_TEST_FORCE를 파일 맨 위에서 고정한다.
 *
 * 실행: node server/test/bike-ports-bicycle-fallback.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'failure';

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

{
  const db = openDb();
  const now = nowIso();
  db.prepare(`INSERT INTO bike_share_ports (provider_id, region_code, port_id, title, address, capacity, lat, lng, imported_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('charichari', 'FUK', 'TEST-A', '합성 포트 A', '합성주소 A', 10, 33.590, 130.401, now);
  db.prepare(`INSERT INTO bike_share_import_meta (provider_id, region_code, source_url, endpoint, retrieved_at, port_count, imported_at) VALUES (?,?,?,?,?,?,?)`)
    .run('charichari', 'FUK', 'https://example.invalid/map', 'https://example.invalid/graphql', now, 1, now);
}

const acc = await login('bike-fallback@example.com');
setTestAccessByEmail('bike-fallback@example.com', true);
const origin = { lat: 33.5905, lng: 130.4015 };
const destination = { lat: 33.592, lng: 130.403 };
const r = await api('POST', '/api/bike-ports/guide', { token: acc.token, body: {
  idempotencyKey: 'fallback-1', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-A', origin, destination,
} });

t('자전거 경로 미지원/실패 시에도 요청 자체는 200으로 처리됨(도보 구간은 정직한 추정으로 계속 안내)', r.status === 200);
t('자전거 구간은 real:false로 정직하게 표시됨', r.json.guide.bikeLeg.real === false);
t('자전거 구간 실패 시 distanceMeters 필드 자체가 없음(추정 시간 생성 금지)', !('distanceMeters' in r.json.guide.bikeLeg));
t('자전거 구간 실패 시 seconds 필드 자체가 없음(추정 시간 생성 금지)', !('seconds' in r.json.guide.bikeLeg));
t('실패 사유가 문자열로 함께 옴(화면이 "외부 지도에서 확인" 안내로 대체할 근거)', typeof r.json.guide.bikeLeg.reason === 'string');
t('도보 구간은 기존 원칙대로 정직한 추정치가 표시됨(real:false여도 숫자는 있음)', r.json.guide.walkLeg.real === false && typeof r.json.guide.walkLeg.distanceMeters === 'number');
t('공식 지도 링크는 항상 함께 내려옴(딥링크 아닌 지역 공식 웹지도)', typeof r.json.guide.officialMapUrl === 'string' && r.json.guide.officialMapUrl.includes('charichari.bike'));
t('도보 구간도 추정(routedReal=false)이라 무료체험은 차감되지 않음(기존 실패 시 미차감 원칙)', r.json.trialConsumed === false);

// --- 2026-09-16 ChatGPT 재검토 2·6절 — "완전한 성공은 두 구간 모두
// 실제 성공으로 정의하고, 자전거 실패+도보 성공처럼 일부만 성공한
// 경우는 미차감." ROUTING_TEST_FORCE가 파일 전체에 고정돼 있어(위에서
// 'failure') 두 구간이 항상 같은 방향으로만 실패/성공했는데,
// 전용 값(bike-fail-walk-success)으로 이 경계 상황만 따로 재현한다. */
{
  const acc2 = await login('bike-fallback-divergent@example.com');
  setTestAccessByEmail('bike-fallback-divergent@example.com', true);
  const { config } = await import('../config.mjs');
  config.routingTestForce = 'bike-fail-walk-success';
  const r2 = await api('POST', '/api/bike-ports/guide', { token: acc2.token, body: {
    idempotencyKey: 'divergent-1', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-A', origin, destination,
  } });
  t('자전거 실패+도보 성공 — 자전거는 real:false', r2.json.guide.bikeLeg.real === false);
  t('자전거 실패+도보 성공 — 도보는 real:true', r2.json.guide.walkLeg.real === true);
  t('둘 중 하나라도 실패면 "완전한 성공"이 아니므로 무료체험 미차감', r2.json.trialConsumed === false);
  const usage2 = await api('GET', '/api/account/usage', { token: acc2.token });
  t('미차감이므로 코스 성공 카운트도 그대로 0', usage2.json.courseGenerations.used === 0);
  config.routingTestForce = 'failure'; // 이 파일의 나머지 동작에 영향 없게 원복
}

console.log(fail === 0 ? '\n전체 통과' : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
