'use strict';
/**
 * 실제 경로 성공(시뮬레이션) 결과는 딱 한 번만 무료체험을 차감한다.
 * 실행: node server/test/generation-trial-charging-success.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'success';

const { createServer } = await import('../index.mjs');
const { sentEmailsForTest } = await import('../adapters/email.mjs');

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
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
async function login(email) {
  await api('POST', '/api/auth/request-code', { body: { email } });
  const code = sentEmailsForTest.filter((e) => e.to === email).pop().body.match(/(\d{6})/)[1];
  return (await api('POST', '/api/auth/verify-code', { body: { email, code } })).json;
}

const acc = await login('trial-charge@example.com');
const origin = { lat: 33.590, lng: 130.400 };
const places = [{ id: 'p1', name: 'A', lat: 33.591, lng: 130.401 }];
const r = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: 'k1', city: 'X', date: '2026-01-01', origin, places } });
t('실제 경로 성공 결과로 코스가 만들어짐', r.status === 200 && r.json.course.routedReal === true);
t('실제 경로 성공은 무료체험을 차감함(trialConsumed=true)', r.json.trialConsumed === true);
const trial = await api('GET', '/api/trial', { token: acc.token });
t('서버 기준으로도 무료체험 사용됨으로 반영', trial.json.used === true);

const r2 = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: 'k2', city: 'X', date: '2026-01-02', origin, places } });
t('무료체험을 이미 쓴 뒤 두 번째 시도는 결제 필요(402)로 막힘', r2.status === 402 && r2.json.reason === 'payment-required');

server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
