'use strict';
/**
 * 2026-09-10 재검토(7차) 4절 — "실패하면 마지막 캐시 데이터를 그 시각과
 * 함께 보여주거나, 없으면 일시적으로 이용할 수 없다고 정직하게 답한다.
 * 오래된 데이터를 최신인 것처럼 보여주지 않는다." 실제 공급자 호출을
 * 흉내 내(fetch 가로채기) 성공→실패 전환 상황을 재현한다.
 *
 * 실행: node server/test/weather-stale-fallback.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.WEATHER_API_KEY = 'fake-weather-key';
process.env.WEATHER_CACHE_TTL_MS = '200'; // 아주 짧게(200ms) — 곧 만료되게 해서 재현을 빠르게 한다.

const { createServer } = await import('../index.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function jsonResponse(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
const originalFetch = globalThis.fetch;
let mode = 'success';
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith(base)) return originalFetch(url, init);
  if (mode === 'fail') return jsonResponse(500, {});
  return jsonResponse(200, {
    location: { name: '테스트지역', tz_id: 'Asia/Tokyo', localtime: '2026-09-10 14:00' },
    current: { temp_c: 26, feelslike_c: 28, condition: { text: '맑음' }, last_updated: '2026-09-10 13:55' },
    forecast: { forecastday: [{ date: '2026-09-10', day: { maxtemp_c: 29, mintemp_c: 22 }, hour: Array.from({ length: 24 }, (_, h) => ({ time: `2026-09-10 ${String(h).padStart(2, '0')}:00`, chance_of_rain: 10, wind_kph: 12 })) }] },
  });
};

async function api(path) {
  const res = await fetch(base + path);
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}

const r1 = await api('/api/weather?lat=33.5&lng=130.4');
t('사전 조건 — 첫 조회(공급자 응답 성공)로 캐시가 만들어짐', r1.status === 200 && r1.json.ok === true && r1.json.stale === false);
const firstCachedAt = r1.json.cachedAt;

// 캐시가 만료될 때까지 기다린 뒤, 이번엔 공급자가 실패하게 만든다.
await new Promise((resolve) => setTimeout(resolve, 250));
mode = 'fail';
const r2 = await api('/api/weather?lat=33.5&lng=130.4');
t('공급자 실패 시에도 완전히 못 보여주지 않고 이전 캐시로 대체함', r2.status === 200 && r2.json.ok === true);
t('대체된 값은 오래된 값임을 stale로 정직하게 표시함', r2.json.stale === true);
t('오래된 값의 원래 시각(cachedAt)을 그대로 보존함(최신인 것처럼 속이지 않음)', r2.json.cachedAt === firstCachedAt);
t('오래된 값이어도 실제 날씨 수치 자체는 그대로 보여줌(현재 온도 26도)', r2.json.current.tempC === 26);

// 캐시조차 없는 완전히 새로운 지역에서 공급자가 실패하면 정직하게
// "일시적으로 이용할 수 없다"고만 답한다(값을 지어내지 않는다).
const r3 = await api('/api/weather?lat=10.0&lng=10.0');
t('캐시가 아예 없는 지역에서 공급자 실패 시 정직하게 이용불가로 답함', r3.status === 503 && r3.json.reason === 'weather-unavailable');

globalThis.fetch = originalFetch;
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
