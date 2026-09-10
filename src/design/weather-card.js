'use strict';
/**
 * 착장 판단용 날씨 카드(2026-09-10 재검토 7차 4절) — "오늘 동선" 화면
 * 맨 위에 작은 카드로 붙인다. 승인된 디자인의 시각 스타일(spots.css의
 * .route-row·.inline-note와 같은 톤)을 그대로 따른다.
 *
 * 지켜야 할 것들(요청 원문 그대로):
 * - 기본은 현재 선택된 목적지(city) — GPS는 이 카드에서 전혀 안 쓴다
 *   ("내 주변" 모드에 GPS를 쓸 때는 사용자 동의가 있을 때만이라는 게
 *   지시였을 뿐, 이 카드 자체가 GPS를 쓸 필요는 없다 — 목적지 기반이면
 *   충분하고, 새 GPS 흐름을 만드는 건 이번 범위 밖의 기능 확장이다).
 * - 도시를 고를 때마다 새 Google Places 호출을 만들지 않는다 — 이미
 *   확인된(좌표 있는) 저장 장소들의 평균 좌표를 우선 쓰고, 그런 장소가
 *   아직 없으면 자주 쓰이는 목적지의 대략적인 좌표표(CITY_COORDS)로
 *   대체한다. 이 표에도 없으면 조용히 숨기지 않고 정직하게 "아직 지원
 *   안 함"이라고 표시한다.
 * - "현재 날씨"와 "예보"를 분명히 구분해서 라벨을 붙인다 — "실시간"이란
 *   단어는 쓰지 않고 "현재 날씨 · 몇 시 기준"으로 표기한다.
 * - 메인 화면(코스·동선)을 먼저 렌더링하고, 날씨는 비동기로 나중에
 *   채운다(loadWeatherCard는 절대 await되지 않는다 — 호출부가 fire-and-
 *   forget으로 부른다).
 * - 실패하면 마지막 캐시(있으면, 오래됐어도 시각과 함께)나 "일시적으로
 *   이용할 수 없다"는 정직한 안내로 대체한다 — 절대 오래된 값을 최신인
 *   것처럼 보여주지 않는다(weather-stale 표시).
 * - 착장 문구는 규칙 기반이다(체감온도·일교차·강수·바람) — 새 LLM API
 *   비용을 전혀 만들지 않는다.
 */

// 자주 나오는 여행지의 대략적인 좌표·시간대 — 도시를 고를 때마다 새
// Places API 호출을 만들지 않기 위한 대체표(확인된 저장 장소 좌표가
// 우선이고, 이건 그게 없을 때만 쓰는 보조 수단이다). 정확한 지오코딩이
// 아니라 "날씨를 조회할 대략적인 지점" 용도일 뿐이다.
const CITY_COORDS = {
  '후쿠오카': { lat: 33.5902, lng: 130.4017, tz: 'Asia/Tokyo' },
  '도쿄': { lat: 35.6762, lng: 139.6503, tz: 'Asia/Tokyo' },
  '오사카': { lat: 34.6937, lng: 135.5023, tz: 'Asia/Tokyo' },
  '교토': { lat: 35.0116, lng: 135.7681, tz: 'Asia/Tokyo' },
  '삿포로': { lat: 43.0618, lng: 141.3545, tz: 'Asia/Tokyo' },
  '나고야': { lat: 35.1815, lng: 136.9066, tz: 'Asia/Tokyo' },
  '오키나와': { lat: 26.2124, lng: 127.6809, tz: 'Asia/Tokyo' },
  '서울': { lat: 37.5665, lng: 126.9780, tz: 'Asia/Seoul' },
  '부산': { lat: 35.1796, lng: 129.0756, tz: 'Asia/Seoul' },
  '제주': { lat: 33.4996, lng: 126.5312, tz: 'Asia/Seoul' },
  '방콕': { lat: 13.7563, lng: 100.5018, tz: 'Asia/Bangkok' },
  '다낭': { lat: 16.0544, lng: 108.2022, tz: 'Asia/Ho_Chi_Minh' },
  '타이베이': { lat: 25.0330, lng: 121.5654, tz: 'Asia/Taipei' },
};

/* 확인된(좌표 있는) 저장 장소가 있으면 그 평균 좌표를 쓴다(실제 여행
   지점에 더 가깝다) — 없으면 위 대체표, 그마저 없으면 null(모른다고
   정직하게 답한다 — 지어내지 않는다). */
function resolveDestCoords(cityName, spots) {
  const withCoords = (spots || []).filter((p) => p.city === cityName && typeof p.lat === 'number' && typeof p.lng === 'number');
  const known = CITY_COORDS[cityName];
  if (withCoords.length) {
    const lat = withCoords.reduce((s, p) => s + p.lat, 0) / withCoords.length;
    const lng = withCoords.reduce((s, p) => s + p.lng, 0) / withCoords.length;
    return { lat, lng, tz: known ? known.tz : null };
  }
  if (known) return { lat: known.lat, lng: known.lng, tz: known.tz };
  return null;
}

/* 규칙 기반 착장 참고 한 줄 — 체감온도 구간 하나 + 일교차·강수·바람
   조건이 해당하면 덧붙인다. LLM 호출 없음(순수 규칙). */
function outfitNote({ feelsLikeC, maxC, minC, hourly }) {
  const notes = [];
  if (typeof feelsLikeC !== 'number') return '';
  if (feelsLikeC >= 28) notes.push('덥고 습해요 — 통풍 잘 되는 얇은 옷차림이 좋아요');
  else if (feelsLikeC >= 23) notes.push('따뜻해요 — 반팔 등 가벼운 옷차림이면 충분해요');
  else if (feelsLikeC >= 17) notes.push('선선해요 — 얇은 겉옷 하나 챙기면 좋아요');
  else if (feelsLikeC >= 11) notes.push('쌀쌀해요 — 니트나 자켓 같은 겉옷을 챙기세요');
  else if (feelsLikeC >= 5) notes.push('추워요 — 두꺼운 겉옷과 목도리를 챙기세요');
  else notes.push('많이 추워요 — 방한 외투와 장갑을 챙기세요');

  if (typeof maxC === 'number' && typeof minC === 'number' && (maxC - minC) >= 10) {
    notes.push('낮밤 기온차가 커요, 겹쳐 입기 좋은 옷 추천');
  }
  const pops = (hourly || []).map((h) => h.popPercent || 0);
  const winds = (hourly || []).map((h) => h.windKph || 0);
  if (pops.length && Math.max(...pops) >= 50) notes.push('비 소식이 있어요, 우산 챙기세요');
  if (winds.length && Math.max(...winds) >= 25) notes.push('바람이 강해요, 방풍 겉옷이 도움돼요');
  return notes.join(' · ');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtClock(iso, tz, opts) {
  try { return new Intl.DateTimeFormat('ko-KR', Object.assign({ hour: 'numeric', hour12: true, timeZone: tz || undefined }, opts)).format(new Date(iso)); }
  catch (e) { return new Date(iso).toLocaleTimeString('ko-KR'); }
}

function skeletonHTML(cityName) {
  return `<div class="weather-card" id="weatherCard" data-state="loading"><div class="weather-top"><b>${esc(cityName)} 날씨</b><span class="weather-sub">불러오는 중…</span></div></div>`;
}
function unavailableHTML(cityName, reason) {
  const msg = reason === 'no-coords'
    ? '이 목적지는 아직 날씨 정보를 지원하지 않아요.'
    : '지금은 날씨 정보를 불러올 수 없어요. 나중에 다시 확인해 주세요.';
  return `<div class="weather-card" id="weatherCard" data-state="unavailable"><div class="weather-top"><b>${esc(cityName)} 날씨</b></div><p class="weather-note">${msg}</p></div>`;
}
function cardHTML(cityName, w) {
  const cur = w.current || {};
  const day = (w.forecastDays || [])[0] || {};
  const tz = w.location && w.location.tzId;
  // 2026-09-10 재검토(7차) 4절 — "실시간"이라는 단어를 쓰지 않고 "현재
  // 날씨 · 몇 시 기준"으로만 표기한다(현재값과 예보를 분명히 구분).
  const nowLabel = fmtClock(cur.observedAtIso, tz, { minute: '2-digit' });
  const note = outfitNote({ feelsLikeC: cur.feelsLikeC, maxC: day.maxC, minC: day.minC, hourly: day.hourly });
  const hourlyHTML = (day.hourly || []).map((h) => `<div class="weather-hour"><span>${fmtClock(h.hourIso, tz)}</span><b>☔${h.popPercent}%</b><i>💨${Math.round(h.windKph)}</i></div>`).join('');
  const staleNote = w.stale
    ? `<p class="weather-note weather-stale">방금은 새로 못 받아와서 이전 값을 보여드려요(${fmtClock(w.cachedAt, tz, { minute: '2-digit' })} 기준).</p>`
    : '';
  const sourceLabel = w.source === 'weatherapi' ? 'WeatherAPI.com 제공' : '테스트 데이터(예시) · 실제 공급자 연결 전';
  return `<div class="weather-card" id="weatherCard" data-state="ready">
    <div class="weather-top"><b>${esc(cityName)} 현재 날씨 · ${nowLabel} 기준</b></div>
    <div class="weather-main"><span class="weather-temp">${Math.round(cur.tempC)}°</span><span class="weather-feels">체감 ${Math.round(cur.feelsLikeC)}°</span></div>
    <p class="weather-range">오늘 예보 · 최고 ${Math.round(day.maxC)}° · 최저 ${Math.round(day.minC)}° · 저녁 ${Math.round(day.eveningC)}°</p>
    ${hourlyHTML ? `<div class="weather-hourly">${hourlyHTML}</div>` : ''}
    ${note ? `<p class="weather-note">${esc(note)}</p>` : ''}
    ${staleNote}
    <small class="weather-source">${sourceLabel}</small>
  </div>`;
}

// 겹치는 로드 요청 중 가장 최근 것만 결과를 반영한다(예: 도시를 빠르게
// 여러 번 바꾸면, 먼저 시작된 느린 응답이 나중에 도착해 최신 화면을
// 덮어쓰는 걸 막는다 — spots.js의 daSyncPushSeq와 같은 원칙).
let weatherLoadSeq = 0;

/* fire-and-forget으로 호출된다(await 안 함) — 메인 화면은 이미 그려진
   뒤라, 이 함수가 늦게 끝나도 코스·동선 기능 사용에는 전혀 영향이
   없다. A는 window.DesignAdapter, spots는 현재 좌표를 아는 저장 장소
   배열이다. */
async function loadWeatherCard(A, cityName, spots) {
  const mySeq = ++weatherLoadSeq;
  const coords = resolveDestCoords(cityName, spots);
  if (!coords) {
    const el = document.getElementById('weatherCard');
    if (el && mySeq === weatherLoadSeq) el.outerHTML = unavailableHTML(cityName, 'no-coords');
    return;
  }
  const tzParam = coords.tz ? '&tz=' + encodeURIComponent(coords.tz) : '';
  const r = await A.api(`/api/weather?lat=${coords.lat}&lng=${coords.lng}${tzParam}`);
  if (mySeq !== weatherLoadSeq) return; // 더 최근 로드가 이미 시작됨 — 이 결과는 버린다.
  const el = document.getElementById('weatherCard');
  if (!el) return; // 화면이 이미 닫혔으면 조용히 무시.
  if (!r.ok || !r.json || r.json.ok === false) { el.outerHTML = unavailableHTML(cityName, 'error'); return; }
  el.outerHTML = cardHTML(cityName, r.json);
}

window.WeatherCard = { skeletonHTML, loadWeatherCard, resolveDestCoords, outfitNote, CITY_COORDS };
