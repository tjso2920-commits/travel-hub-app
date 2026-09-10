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
function cacheSet(key, data) {
  const db = openDb();
  db.prepare(`
    INSERT INTO weather_cache (region_key, data, created_at) VALUES (?, ?, ?)
    ON CONFLICT(region_key) DO UPDATE SET data = excluded.data, created_at = excluded.created_at
  `).run(key, JSON.stringify(data), nowIso());
}

export async function weatherRoute(lat, lng, tzHint) {
  if (lat == null || lng == null || lat === '' || lng === '') {
    return { ok: false, status: 400, reason: 'missing-coords' };
  }
  const latN = Number(lat), lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    return { ok: false, status: 400, reason: 'missing-coords' };
  }
  const key = regionKeyFor(latN, lngN);

  const cached = cacheGet(key);
  const fresh = cached && (Date.now() - new Date(cached.createdAt).getTime() < config.weatherCacheTtlMs);
  if (fresh) {
    return { ok: true, status: 200, ...cached.data, cachedAt: cached.createdAt, stale: false };
  }

  // 서비스 전체 하루 호출 상한 — 지역 캐시로 대부분의 요청은 여기까지
  // 오지도 않지만, 새 지역이 몰릴 때를 대비한 안전판이다.
  const day = dayWindow();
  const globalCheck = checkAndIncrement('weather:global', day, config.weatherGlobalDailyCap, 1);
  if (!globalCheck.allowed) {
    // 한도에 걸려도 오래된 캐시가 있으면 그거라도 시각과 함께 보여준다
    // (완전히 못 보여주는 것보다 낫다 — 단, 오래된 값임을 분명히 표시).
    if (cached) return { ok: true, status: 200, ...cached.data, cachedAt: cached.createdAt, stale: true };
    return { ok: false, status: 503, reason: 'weather-service-daily-cap-reached' };
  }

  const result = await lookupWeather({ lat: latN, lng: lngN, tzId: tzHint });
  if (!result.ok) {
    // 실제 호출이 실패했다 — 오래된 캐시라도 있으면 그 시각과 함께
    // 정직하게 보여주고, 없으면 "일시적으로 이용할 수 없다"고 답한다.
    if (cached) return { ok: true, status: 200, ...cached.data, cachedAt: cached.createdAt, stale: true };
    return { ok: false, status: 503, reason: 'weather-unavailable', detail: result.reason };
  }
  const payload = { location: result.location, current: result.current, forecastDays: result.forecastDays, source: result.source };
  cacheSet(key, payload);
  return { ok: true, status: 200, ...payload, cachedAt: nowIso(), stale: false };
}
