'use strict';
/**
 * "실패 시 차감 제외" — 추정(직선거리) 결과는 무료체험을 쓰지 않는다.
 * ROUTING_TEST_FORCE는 config.mjs가 process.env를 최초 로드 시 한 번만
 * 읽으므로 반드시 이 파일의 다른 import보다 먼저 설정돼 있어야 한다
 * (그래서 success/failure를 한 파일에서 같이 검증하지 않고 분리했다).
 * 실행: node server/test/generation-trial-charging-failure.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'failure';

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

const acc = await login('trial-no-charge@example.com');
const origin = { lat: 33.590, lng: 130.400 };
const places = [{ id: 'p1', name: 'A', lat: 33.591, lng: 130.401 }];
const r = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: 'k1', city: 'X', date: '2026-01-01', origin, places } });
t('추정(실패) 결과로 코스가 만들어짐', r.status === 200 && r.json.course.routedReal === false);
t('추정 결과는 무료체험을 차감하지 않음(trialConsumed=false)', r.json.trialConsumed === false);
const trial = await api('GET', '/api/trial', { token: acc.token });
t('서버 기준으로도 여전히 무료체험 미사용 상태', trial.json.used === false);

const r2 = await api('POST', '/api/course/generate', { token: acc.token, body: { idempotencyKey: 'k2', city: 'X', date: '2026-01-02', origin, places } });
t('추정 결과가 반복돼도 계속 무료로 재시도 가능(체험이 안 깎였으므로)', r2.status === 200);

server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
