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

console.log(fail === 0 ? '\n전체 통과' : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
