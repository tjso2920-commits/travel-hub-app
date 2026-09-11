'use strict';
/**
 * 2026-09-11 재검토(9차) 4-A절 — ChatGPT가 실제로 재현한 결함:
 * weatherRoute가 "진행 중인 요청에 합류"하기 전에 "서비스 전체 하루
 * 호출 상한"을 먼저 확인·소비했다. 그래서 캐시가 비어 있는 같은
 * 좌표로 동시에 두 요청이 들어오면, 실제 외부 호출은 딱 1번만 나가는
 * 데도(동시요청 병합) 상한을 1로 잡아 두면 [성공, 하루상한도달]처럼
 * 한쪽이 실패했다 — 두 사용자가 같은 호출 결과를 공유해야 하는데
 * 그러지 못했다.
 *
 * 실행: node server/test/weather-merge-cap.test.mjs
 */
process.env.TZ = 'UTC';
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.WEATHER_API_KEY = 'dummy-test-key-not-real';
process.env.WEATHER_GLOBAL_DAILY_CAP = '1'; // 재현 원문 그대로 — 딱 1번의 실제 호출만 허용.

let fetchCallCount = 0;
globalThis.fetch = async () => {
  fetchCallCount++;
  await new Promise((resolve) => setTimeout(resolve, 20)); // 재현 원문의 "20ms 지연 모의 fetch".
  return {
    ok: true,
    status: 200,
    json: async () => ({
      location: { name: 't', tz_id: 'Asia/Tokyo', localtime_epoch: Math.floor(Date.now() / 1000), localtime: '2026-09-11 12:00' },
      current: { last_updated_epoch: Math.floor(Date.now() / 1000), last_updated: '2026-09-11 12:00', temp_c: 25, feelslike_c: 25, condition: { text: '맑음' } },
      forecast: { forecastday: [{ date: '2026-09-11', date_epoch: Math.floor(Date.now() / 1000), day: { maxtemp_c: 28, mintemp_c: 20 }, hour: [] }] },
    }),
  };
};

const { weatherRoute } = await import('../routes/weather.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

// 캐시가 비어 있는 같은 좌표로 정확히 재현 원문 그대로 동시에 두 번
// 요청한다(Promise.all).
const [r1, r2] = await Promise.all([
  weatherRoute(35.0, 135.0, 'Asia/Tokyo'),
  weatherRoute(35.0, 135.0, 'Asia/Tokyo'),
]);

t('실제 외부 호출은 정확히 1번만 나감(동시요청 병합)', fetchCallCount === 1);
t('두 사용자 모두 성공 응답을 받음(한쪽이 "하루 상한 도달"로 실패하지 않음 — 재현 확인)', r1.ok === true && r2.ok === true);
if (r1.ok && r2.ok) {
  t('두 응답이 같은 내용을 공유함(같은 호출 결과)', r1.current.tempC === r2.current.tempC && r1.cachedAt === r2.cachedAt);
} else {
  t('두 응답이 같은 내용을 공유함(같은 호출 결과)', false);
}

// 실제로 새 외부 호출이 필요한 "다음" 요청(다른 지역, 캐시 없음)은
// 상한이 이미 1로 소진된 상태이므로 정상적으로 거절돼야 한다 —
// "합류만 하는 요청이 상한을 안 쓴다"고 해서 상한 자체가 무력화된
// 건 아님을 함께 확인한다.
const r3 = await weatherRoute(10.0, 20.0, 'Asia/Tokyo');
t('실제로 새 호출이 필요한 다른 지역 요청은 상한 소진 후 정직하게 거절됨(상한 자체는 여전히 유효)', r3.ok === false && r3.reason === 'weather-service-daily-cap-reached');

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
