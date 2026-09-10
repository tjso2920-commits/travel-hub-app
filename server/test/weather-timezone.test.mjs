'use strict';
/**
 * 2026-09-10 재검토(8차) 3절 — ChatGPT가 재현한 날씨 시간대 버그.
 *
 * 재현: server/adapters/weather.mjs가 공급자의 `last_updated`·`hour.time`
 * 문자열("YYYY-MM-DD HH:mm", 시간대 표기 없음 — 목적지의 "현지" 시각)을
 * `new Date(...)`로 그대로 파싱했다. 시간대 정보가 없는 날짜-시간
 * 문자열은 ECMA-262 규격상 "서버의 로컬 시간대"로 해석된다 — 서버가
 * UTC로 도는 한(대부분의 배포 환경), 예를 들어 일본 현지 21:00을
 * "21:00Z"로 잘못 해석한다. 그 잘못된 순간을 화면(weather-card.js)이
 * 다시 tz_id로 지역화하면 실제보다 9시간 더해진 값(다음날 새벽)이
 * 뜬다.
 *
 * 이 파일은 서버 프로세스의 시간대와 무관하게 항상 올바른 절대 시각을
 * 내야 한다는 걸 직접 검증한다 — realAdapter를 실제 네트워크 없이
 * globalThis.fetch를 흉내내어 검증한다(공급자 응답 형태를 그대로
 * 흉내낸 고정 데이터 — 실제 키 검증이 아니라 파싱 로직 검증).
 *
 * 실행: node server/test/weather-timezone.test.mjs
 */
process.env.TZ = 'UTC'; // 서버가 UTC로 돈다고 가정(가장 흔한 배포 조건 — 재현 조건 고정).
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.WEATHER_API_KEY = 'dummy-test-key-not-real'; // services.weather === 'real' 경로를 타게 하려는 것뿐, 실제 호출은 안 나감(fetch를 흉내냄).
process.env.WEATHER_GLOBAL_DAILY_CAP = '100000';

const originalFetch = globalThis.fetch;
let fetchCallCount = 0;
let fetchResponder = null;

globalThis.fetch = async (url) => {
  fetchCallCount++;
  const body = fetchResponder ? fetchResponder(url) : { location: {}, current: {}, forecast: { forecastday: [] } };
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
};

const { openDb, nowIso } = await import('../db.mjs');
const { weatherRoute } = await import('../routes/weather.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function clearWeatherCache() {
  const db = openDb();
  db.exec('DELETE FROM weather_cache');
}

/* 공급자 응답을 만든다 — location.localtime/hour.time은 전부 "현지
   시각" 문자열이고(공급자 실제 계약이 이렇다 — 시간대 표기가 없다),
   epoch 필드는 진짜 절대 시각(UTC 기준 유닉스초)이다. trueUtcMs는
   "실제로 지금이 언제인지"를 절대 기준(UTC 밀리초)으로 두고,
   tzOffsetMinutes로 현지 시각 문자열을 계산해 둘 사이에 일부러
   시간대 표기가 없는 격차를 만든다. */
function buildProviderResponse({ trueUtcMs, tzId, tzOffsetMinutes, tempC, feelsLikeC, forecastDayCount }) {
  const localMs = trueUtcMs + tzOffsetMinutes * 60_000;
  const localD = new Date(localMs);
  const pad = (n) => String(n).padStart(2, '0');
  const localDateStr = `${localD.getUTCFullYear()}-${pad(localD.getUTCMonth() + 1)}-${pad(localD.getUTCDate())}`;
  const localTimeStr = `${localDateStr} ${pad(localD.getUTCHours())}:${pad(localD.getUTCMinutes())}`;
  const trueEpoch = Math.floor(trueUtcMs / 1000);
  const dayStartLocalMs = Date.UTC(localD.getUTCFullYear(), localD.getUTCMonth(), localD.getUTCDate());

  // 무료 등급 계약대로 오늘 포함 최대 3일치 예보를 만든다(기본 1일 —
  // 날짜 선택 커버리지 검사에서만 여러 날을 요청한다).
  const forecastday = [];
  for (let dayOffset = 0; dayOffset < (forecastDayCount || 1); dayOffset++) {
    const thisDayStartLocalMs = dayStartLocalMs + dayOffset * 86_400_000;
    const thisDayD = new Date(thisDayStartLocalMs);
    const thisDateStr = `${thisDayD.getUTCFullYear()}-${pad(thisDayD.getUTCMonth() + 1)}-${pad(thisDayD.getUTCDate())}`;
    const hour = [];
    for (let h = 0; h < 24; h++) {
      const hourLocalMs = thisDayStartLocalMs + h * 3600_000;
      const hourUtcMs = hourLocalMs - tzOffsetMinutes * 60_000;
      hour.push({
        time_epoch: Math.floor(hourUtcMs / 1000),
        time: `${thisDateStr} ${pad(h)}:00`,
        chance_of_rain: 10,
        wind_kph: 12,
        temp_c: tempC,
      });
    }
    forecastday.push({
      date: thisDateStr,
      date_epoch: Math.floor(thisDayStartLocalMs / 1000),
      day: { maxtemp_c: tempC + 3 + dayOffset, mintemp_c: tempC - 3 + dayOffset },
      hour,
    });
  }

  return {
    location: { name: 'test-city', tz_id: tzId, localtime_epoch: trueEpoch, localtime: localTimeStr },
    current: {
      last_updated_epoch: trueEpoch,
      last_updated: localTimeStr,
      temp_c: tempC,
      feelslike_c: feelsLikeC,
      condition: { text: '맑음' },
    },
    forecast: { forecastday },
  };
}

// =====================================================================
// 1) 일본(Asia/Tokyo, UTC+9) — 실제 지금이 UTC 12:00인 순간, 일본
//    현지는 같은 날 21:00이다. 관측 시각(observedAtIso)은 서버가 어느
//    시간대로 돌든 항상 "실제 UTC 12:00"이라는 하나의 절대 순간을
//    가리켜야 한다(예전 버그는 이걸 "21:00Z"로 잘못 만들었다 — 그러면
//    화면이 다시 +9시간 해서 다음날 06:00으로 보여준다).
// =====================================================================
{
  clearWeatherCache();
  const trueUtcMs = Date.UTC(2026, 8, 10, 12, 0, 0); // 2026-09-10T12:00:00Z
  fetchResponder = () => buildProviderResponse({ trueUtcMs, tzId: 'Asia/Tokyo', tzOffsetMinutes: 9 * 60, tempC: 25, feelsLikeC: 27 });

  const r = await weatherRoute(33.5902, 130.4017, 'Asia/Tokyo');
  t('1) 사전 조건 — 정상 응답', r.ok === true);
  const observedMs = new Date(r.current.observedAtIso).getTime();
  t('1) 관측 시각이 실제 절대 순간(UTC 12:00)과 정확히 일치함(서버가 UTC로 돌아도 잘못 밀리지 않음)', observedMs === trueUtcMs);
  t('1) (재현 확인) 예전 버그였다면 9시간 밀린 21:00Z가 됐을 것 — 그 값과는 다름', observedMs !== Date.UTC(2026, 8, 10, 21, 0, 0));

  // "오늘" 예보의 시간대별(hourly) 슬롯은 "지금부터" 시작한다 — 그
  // 첫 슬롯은 정확히 지금 이 순간이 속한 현지 시(21시)를 가리켜야
  // 하고, 그 시각의 절대 순간은 관측 시각과 똑같아야 한다(둘 다 같은
  // "지금"을 가리키므로).
  const hourly = r.forecastDays[0].hourly;
  t('1) 시간대별(hourly) 첫 슬롯도 절대 순간 기준으로 정확함(서버 시간대와 무관)', hourly.length > 0 && new Date(hourly[0].hourIso).getTime() === trueUtcMs);
}

// =====================================================================
// 2) 태국(Asia/Bangkok, UTC+7) — 다른 시간대에서도 같은 원리가 성립하는지.
// =====================================================================
{
  clearWeatherCache();
  const trueUtcMs = Date.UTC(2026, 8, 10, 3, 0, 0); // 2026-09-10T03:00:00Z → 태국 현지 10:00
  fetchResponder = () => buildProviderResponse({ trueUtcMs, tzId: 'Asia/Bangkok', tzOffsetMinutes: 7 * 60, tempC: 32, feelsLikeC: 38 });

  const r = await weatherRoute(13.7563, 100.5018, 'Asia/Bangkok');
  const observedMs = new Date(r.current.observedAtIso).getTime();
  t('2) 태국 — 관측 시각이 실제 절대 순간과 일치함', observedMs === trueUtcMs);
}

// =====================================================================
// 3) 뉴욕(America/New_York, 2026-09-10 기준 서머타임 EDT=UTC-4, 음수
//    오프셋) — 음수 시간대에서도 같은 원리가 성립하는지.
// =====================================================================
{
  clearWeatherCache();
  const trueUtcMs = Date.UTC(2026, 8, 10, 18, 0, 0); // 2026-09-10T18:00:00Z → 뉴욕 현지 14:00(EDT)
  fetchResponder = () => buildProviderResponse({ trueUtcMs, tzId: 'America/New_York', tzOffsetMinutes: -4 * 60, tempC: 24, feelsLikeC: 24 });

  const r = await weatherRoute(40.7128, -74.0060, 'America/New_York');
  const observedMs = new Date(r.current.observedAtIso).getTime();
  t('3) 뉴욕(음수 오프셋) — 관측 시각이 실제 절대 순간과 일치함', observedMs === trueUtcMs);
}

// =====================================================================
// 4) 현지 자정 경계 — 서버 날짜(UTC 기준)와 목적지 현지 날짜가 다른
//    순간(예: UTC 16:00 = 도쿄 현지로는 이미 다음날 01:00)에도 "오늘"
//    판정이 목적지 기준이어야 한다.
// =====================================================================
{
  clearWeatherCache();
  const trueUtcMs = Date.UTC(2026, 8, 10, 16, 0, 0); // UTC 09-10 16:00 → 도쿄 현지 09-11 01:00(이미 다음날)
  fetchResponder = () => buildProviderResponse({ trueUtcMs, tzId: 'Asia/Tokyo', tzOffsetMinutes: 9 * 60, tempC: 20, feelsLikeC: 19 });

  const r = await weatherRoute(35.6762, 139.6503, 'Asia/Tokyo');
  t('4) 목적지 현지 날짜 기준으로 예보 날짜가 잡힘(서버 UTC 날짜가 아니라 09-11)', r.forecastDays[0].dateISO === '2026-09-11');
  const observedMs = new Date(r.current.observedAtIso).getTime();
  t('4) 자정 경계에서도 관측 시각은 여전히 정확한 절대 순간', observedMs === trueUtcMs);
}

// =====================================================================
// 5) 위경도 범위 검증 — 범위를 벗어난 값은 400으로 정직하게 거부한다.
// =====================================================================
{
  const r1 = await weatherRoute(999, 130, 'Asia/Tokyo');
  t('5) 위도 범위(-90~90)를 벗어나면 거부됨', r1.ok === false && r1.status === 400);
  const r2 = await weatherRoute(33, 999, 'Asia/Tokyo');
  t('5) 경도 범위(-180~180)를 벗어나면 거부됨', r2.ok === false && r2.status === 400);
}

// =====================================================================
// 6) 캐시가 비어 있을 때 동시에 N개 요청이 들어와도 실제 외부 호출은
//    한 번만 나가야 한다(동일 지역 동시요청 병합 — places.mjs의
//    inFlightLookups와 같은 원칙을 weatherRoute에도 적용).
// =====================================================================
{
  clearWeatherCache();
  fetchCallCount = 0;
  const trueUtcMs = Date.UTC(2026, 8, 10, 12, 0, 0);
  fetchResponder = () => buildProviderResponse({ trueUtcMs, tzId: 'Asia/Tokyo', tzOffsetMinutes: 9 * 60, tempC: 25, feelsLikeC: 25 });

  const results = await Promise.all([
    weatherRoute(36.1, 140.1, 'Asia/Tokyo'),
    weatherRoute(36.1, 140.1, 'Asia/Tokyo'),
    weatherRoute(36.1, 140.1, 'Asia/Tokyo'),
    weatherRoute(36.1, 140.1, 'Asia/Tokyo'),
    weatherRoute(36.1, 140.1, 'Asia/Tokyo'),
  ]);
  t('6) 동시 요청 5건 모두 성공', results.every((r) => r.ok === true));
  t('6) 캐시가 비어 있었는데도 실제 외부 호출은 정확히 1번만 나감(동시요청 병합)', fetchCallCount === 1);
}

// =====================================================================
// 7) 사용자가 고른 여행 날짜 예보 선택 — 공급자가 실제로 보장하는
//    기간(오늘 포함 3일) 안의 날짜는 그 날짜의 예보를 정확히 골라
//    주고, 그 밖의 날짜는 오늘 값을 그 날짜인 것처럼 보여주지 않고
//    "범위 밖"이라고 정직하게 표시해야 한다.
// =====================================================================
{
  clearWeatherCache();
  const trueUtcMs = Date.UTC(2026, 8, 10, 3, 0, 0); // 도쿄 현지 09-10 12:00
  fetchResponder = () => buildProviderResponse({ trueUtcMs, tzId: 'Asia/Tokyo', tzOffsetMinutes: 9 * 60, tempC: 25, feelsLikeC: 25, forecastDayCount: 3 });

  const rToday = await weatherRoute(35.0, 135.0, 'Asia/Tokyo', '2026-09-10');
  t('7) 오늘 날짜를 고르면 그 날짜 예보가 범위 안으로 잡힘', rToday.ok && rToday.selectedDateInCoverage === true && rToday.selectedDay && rToday.selectedDay.dateISO === '2026-09-10');

  clearWeatherCache();
  const rDay2 = await weatherRoute(35.0, 135.0, 'Asia/Tokyo', '2026-09-12');
  t('7) 3일 예보 범위 안의 미래 날짜(+2일)도 정확히 그 날짜 예보로 잡힘(오늘 값이 아님)', rDay2.ok && rDay2.selectedDateInCoverage === true && rDay2.selectedDay && rDay2.selectedDay.dateISO === '2026-09-12' && rDay2.selectedDay.maxC !== rDay2.forecastDays[0].maxC);

  clearWeatherCache();
  const rOutOfRange = await weatherRoute(35.0, 135.0, 'Asia/Tokyo', '2026-09-30');
  t('7) 공급자가 보장하는 범위(3일) 밖의 날짜는 범위 밖으로 정직하게 표시됨(오늘 값을 그 날짜인 척 안 보여줌)', rOutOfRange.ok && rOutOfRange.selectedDateInCoverage === false && rOutOfRange.selectedDay === null);
  t('7) 범위 밖이어도 현재 날씨(current)는 여전히 정상 제공됨(오늘 지금 기준 값 자체는 유효)', typeof rOutOfRange.current.tempC === 'number');
}

globalThis.fetch = originalFetch;
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
