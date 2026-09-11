'use strict';
/**
 * 착장 판단용 날씨 카드(2026-09-10 재검토 7차 4절) — /api/weather.
 *
 * 지켜야 할 것들:
 * - **로그인 불필요**: 무료(비회원) 사용자도 날씨를 볼 수 있어야 하고,
 *   이 엔드포인트는 위치확인·코스생성 이용권/비용 원장을 전혀 건드리지
 *   않는다(entitlement-usage.mjs·cost-ledger.mjs를 import조차 안 한다 —
 *   날씨 조회가 그 두 시스템과 완전히 무관함을 코드로도 보장한다).
 * - **지역 공유 캐시**: 같은 지역(위경도를 약 1km 단위로 반올림)을 여러
 *   사용자가 같은 시간대에 봐도 실제 외부 호출은 한 번만 나간다.
 * - **자연 갱신 주기 고려**: 현재 날씨는 자주 안 바뀌므로 TTL(기본
 *   25분) 안에서는 캐시를 그대로 재사용한다 — "도시를 고를 때마다 매번
 *   호출"을 막는다.
 * - **전체 호출 상한**: 무료 등급 월 100,000회를 지키기 위해 서비스
 *   전체 하루 호출 수에 상한을 둔다(rate-limit.mjs의 공용 카운터 재사용).
 * - **실패 시**: 마지막으로 캐시된 값(있으면, 오래됐어도)을 그 시각과
 *   함께 돌려주거나, 캐시조차 없으면 "일시적으로 이용할 수 없다"고
 *   정직하게 답한다 — 가짜 데이터를 만들어내지 않는다.
 */
import { openDb, nowIso } from '../db.mjs';
import { config } from '../config.mjs';
import { checkAndIncrement, dayWindow } from '../rate-limit.mjs';
import { lookupWeather } from '../adapters/weather.mjs';

// 위경도를 약 1km 단위(소수점 둘째 자리)로 반올림해 지역을 묶는다 —
// "정확한 좌표별로 캐시"하면 사실상 캐시가 거의 안 맞는다(GPS 오차·
// 소수점 차이만으로도 다른 키가 되어 매번 새로 호출하게 된다).
function regionKeyFor(lat, lng) {
  const rlat = Math.round(Number(lat) * 100) / 100;
  const rlng = Math.round(Number(lng) * 100) / 100;
  return `${rlat},${rlng}`;
}

function cacheGet(key) {
  const db = openDb();
  const row = db.prepare('SELECT data, created_at FROM weather_cache WHERE region_key = ?').get(key);
  if (!row) return null;
  return { data: JSON.parse(row.data), createdAt: row.created_at };
}
function cacheSet(key, data, createdAt) {
  const db = openDb();
  db.prepare(`
    INSERT INTO weather_cache (region_key, data, created_at) VALUES (?, ?, ?)
    ON CONFLICT(region_key) DO UPDATE SET data = excluded.data, created_at = excluded.created_at
  `).run(key, JSON.stringify(data), createdAt);
}

// 2026-09-10 재검토(8차) 3절 — "캐시가 비어 있을 때 N개의 동시 요청이
// N번의 외부 호출을 만들면 안 된다"는 지시. place-lookup.mjs의
// inFlightLookups와 같은 원칙: 같은 지역에 이미 진행 중인 조회가 있으면
// 새 외부 호출을 내지 않고 그 결과를 그대로 기다린다.
const inFlightWeatherLookups = new Map();

/* 목적지가 고른 여행 날짜(dateStr, YYYY-MM-DD)에 해당하는 예보를
   찾는다 — 없으면(공급자가 실제로 보장하는 기간 밖) 억지로 아무 날짜나
   그 날짜인 척 보여주지 않고 "그 날짜는 아직 예보 범위 밖"이라고
   정직하게 표시할 수 있게 null을 돌려준다. */
function pickSelectedDay(forecastDays, dateStr) {
  if (!dateStr) return { day: forecastDays[0] || null, inCoverage: true };
  const day = forecastDays.find((d) => d.dateISO === dateStr) || null;
  return { day, inCoverage: !!day };
}

export async function weatherRoute(lat, lng, tzHint, dateStr) {
  if (lat == null || lng == null || lat === '' || lng === '') {
    return { ok: false, status: 400, reason: 'missing-coords' };
  }
  const latN = Number(lat), lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    return { ok: false, status: 400, reason: 'missing-coords' };
  }
  // 2026-09-10 재검토(8차) 3절 — 위경도 범위 검증(course-generation.mjs의
  // isValidCoord와 같은 기준). 범위를 벗어난 값을 그대로 공급자에 넘기면
  // 엉뚱한 지역(또는 오류) 응답을 "이 목적지 날씨"인 것처럼 보여줄 위험이
  // 있다.
  if (latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    return { ok: false, status: 400, reason: 'coords-out-of-range' };
  }
  const key = regionKeyFor(latN, lngN);

  const withSelectedDay = (payload, extra) => {
    const { day, inCoverage } = pickSelectedDay(payload.forecastDays || [], dateStr);
    return { ok: true, status: 200, ...payload, ...extra, selectedDay: day, selectedDateISO: dateStr || (day && day.dateISO) || null, selectedDateInCoverage: inCoverage };
  };

  const cached = cacheGet(key);
  const fresh = cached && (Date.now() - new Date(cached.createdAt).getTime() < config.weatherCacheTtlMs);
  if (fresh) {
    return withSelectedDay(cached.data, { cachedAt: cached.createdAt, stale: false });
  }

  // 같은 지역에 이미 진행 중인 외부 호출이 있으면 새로 만들지 않고
  // 그 결과를 같이 기다린다(동시 요청 병합) — place-lookup.mjs의
  // inFlightLookups와 같은 원칙.
  //
  // 2026-09-11 재검토(9차) 4-A절 — ChatGPT가 재현한 결함: 예전엔 이
  // 병합 확인보다 "서비스 전체 하루 호출 상한" 확인·소비를 먼저 했다
  // — 그러면 진행 중인 호출에 그냥 합류할 뿐인 요청도 상한을
  // 소비해서, 실제 외부 호출은 1번만 나갔는데도 동시 요청 2건 중
  // 1건이 "하루 상한 도달"로 실패했다(WEATHER_GLOBAL_DAILY_CAP=1로
  // 재현). 상한은 "실제로 새 외부 호출을 만드는 쪽"만 소비해야 한다
  // — 그래서 지금은 병합 여부를 먼저 확인하고, 새로 시작하는 경우에만
  // 상한을 확인·소비한다.
  let promise = inFlightWeatherLookups.get(key);
  let startedHere = false;
  if (!promise) {
    // 서비스 전체 하루 호출 상한 — 지역 캐시로 대부분의 요청은
    // 여기까지 오지도 않지만, 새 지역이 몰릴 때를 대비한 안전판이다.
    const day = dayWindow();
    const globalCheck = checkAndIncrement('weather:global', day, config.weatherGlobalDailyCap, 1);
    if (!globalCheck.allowed) {
      // 한도에 걸려도 오래된 캐시가 있으면 그거라도 시각과 함께
      // 보여준다(완전히 못 보여주는 것보다 낫다 — 단, 오래된 값임을
      // 분명히 표시).
      if (cached) return withSelectedDay(cached.data, { cachedAt: cached.createdAt, stale: true });
      return { ok: false, status: 503, reason: 'weather-service-daily-cap-reached' };
    }
    startedHere = true;
    promise = lookupWeather({ lat: latN, lng: lngN, tzId: tzHint }).finally(() => {
      inFlightWeatherLookups.delete(key);
    });
    inFlightWeatherLookups.set(key, promise);
  }
  const result = await promise;
  if (!result.ok) {
    // 실제 호출이 실패했다 — 오래된 캐시라도 있으면 그 시각과 함께
    // 정직하게 보여주고, 없으면 "일시적으로 이용할 수 없다"고 답한다.
    if (cached) return withSelectedDay(cached.data, { cachedAt: cached.createdAt, stale: true });
    return { ok: false, status: 503, reason: 'weather-unavailable', detail: result.reason };
  }
  const payload = { location: result.location, current: result.current, forecastDays: result.forecastDays, source: result.source };
  // cacheSet에 쓰는 시각과 응답에 실어 보내는 시각이 서로 다른
  // new Date() 호출이면 밀리초 단위로 어긋날 수 있다 — 하나만 계산해
  // 양쪽에 그대로 쓴다(캐시 공유 시 cachedAt이 항상 같아야 함).
  const fetchedAt = nowIso();
  // 이 호출을 실제로 시작한 쪽만 캐시에 쓴다 — 합류한 쪽까지 다시
  // 쓰면 의미 없이 같은 내용을 두 번 쓰는 꼴이라 그냥 생략한다.
  if (startedHere) cacheSet(key, payload, fetchedAt);
  return withSelectedDay(payload, { cachedAt: fetchedAt, stale: false });
}
