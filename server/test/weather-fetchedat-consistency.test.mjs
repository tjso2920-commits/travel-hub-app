'use strict';
/**
 * 2026-09-11 재검토(13차) — ChatGPT 지적: weather-merge-cap.test.mjs의
 * "두 응답이 같은 내용을 공유함" 검증이 fetchedAt 불일치로 실패한다는
 * 재현. 원인은 routes/weather.mjs가 동시 요청 병합용 공유 Promise를
 * await한 "뒤"에, 그 Promise를 기다린 각 호출자가 각자 따로
 * nowIso()(=new Date().toISOString())를 불러 fetchedAt을 계산했던 것 —
 * 실제 조회는 한 번뿐인데 응답마다 밀리초가 달라질 수 있었다.
 *
 * 이 결함은 "운"에 크게 좌우된다 — 두 동시 요청이 우연히 같은 밀리초
 * 안에 재개되면 옛 버그도 우연히 통과한 것처럼 보인다(자바스크립트
 * Date의 밀리초 해상도, 매우 빠른 로컬 실행 환경에서 흔함). "밀리초
 * 경계에서도" 검증하라는 지시를 실제로 지키려면 운에 맡기지 않고
 * new Date()가 호출될 때마다 반드시 다른 밀리초를 돌려주도록 강제해야
 * 한다 — 그래야 "각자 따로 계산"하는 옛 코드였다면 반드시 실패로
 * 드러나고, "한 번만 계산해 공유"하는 고친 코드는 몇 번을 불러도
 * 항상 통과한다.
 *
 * 실행: node server/test/weather-fetchedat-consistency.test.mjs
 */
process.env.TZ = 'UTC';
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.WEATHER_API_KEY = 'dummy-test-key-not-real';
process.env.WEATHER_GLOBAL_DAILY_CAP = '100000'; // 상한 재현이 아니라 fetchedAt 일관성만 보므로 넉넉히 둔다.

let fetchCallCount = 0;
globalThis.fetch = async () => {
  fetchCallCount++;
  await new Promise((resolve) => setTimeout(resolve, 15));
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

// "밀리초 경계"를 실제 실행 타이밍의 운에 맡기지 않고 결정론적으로
// 강제한다 — new Date()(인자 없이 호출)가 불릴 때마다 반드시 이전과
// 다른 밀리초를 돌려주게 한다. new Date(문자열)처럼 인자가 있는 호출은
// (cacheGet의 createdAt 파싱 등) 건드리지 않는다 — 실제 "지금 시각
// 계산" 호출만 흉내낸다.
const RealDate = Date;
let tick = 0;
class SteppedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + (tick++) * 1000);
    else super(...args);
  }
  static now() { return RealDate.now() + tick * 1000; }
}
globalThis.Date = SteppedDate;
try {
  // 캐시가 비어 있는 좌표로 정확히 동시에(Promise.all) 세 번 요청한다
  // — 동시요청 병합 경로(startedHere 쪽 하나 + 합류하는 쪽 둘)를
  // 모두 거치게 해서, "합류한 쪽도 시작한 쪽과 정확히 같은 fetchedAt을
  // 받는지"까지 함께 확인한다.
  const [r1, r2, r3] = await Promise.all([
    weatherRoute(48.0, 88.0, 'Asia/Tokyo'),
    weatherRoute(48.0, 88.0, 'Asia/Tokyo'),
    weatherRoute(48.0, 88.0, 'Asia/Tokyo'),
  ]);

  t('실제 외부 호출은 정확히 1번만 나감(동시요청 병합)', fetchCallCount === 1);
  t('세 요청 모두 성공함', r1.ok === true && r2.ok === true && r3.ok === true);
  if (r1.ok && r2.ok && r3.ok) {
    t('밀리초 경계를 강제해도 세 응답의 fetchedAt(cachedAt)이 전부 정확히 같음', r1.cachedAt === r2.cachedAt && r2.cachedAt === r3.cachedAt);
    t('내용(온도)도 당연히 같음(같은 실제 호출 결과 공유)', r1.current.tempC === r2.current.tempC && r2.current.tempC === r3.current.tempC);
  } else {
    t('밀리초 경계를 강제해도 세 응답의 fetchedAt(cachedAt)이 전부 정확히 같음', false);
  }

  // 완전히 새 지역으로 또 한 번(이번엔 순차) 요청해도 여전히 일관됨을
  // 확인한다 — 매번 다른 밀리초를 강제하는 상태에서 "시작한 쪽 혼자"
  // 처리하는 경로도 문제없이 자기 자신과는 항상 같은 값을 씀.
  const r4 = await weatherRoute(49.0, 89.0, 'Asia/Tokyo');
  t('새 지역 단독 요청도 정상적으로 성공하고 자기 fetchedAt을 가짐', r4.ok === true && typeof r4.cachedAt === 'string' && r4.cachedAt.length > 0);
} finally {
  globalThis.Date = RealDate;
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
