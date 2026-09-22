'use strict';
/**
 * 영업시간 조회 어댑터(2026-09-22, 18차 3·4절).
 *
 * - 엔드포인트: `GET {placesApiBase}/v1/places/{placeId}` — Place Details
 *   (New). 장소 **검색**(Text Search, places.mjs)과는 완전히 다른 요청이다.
 *   검색 필드마스크에는 영업시간을 절대 넣지 않는다(모든 검색이 더 비싼
 *   등급이 되는 것을 막기 위해). 영업시간은 "코스에 실제로 담긴, 이미
 *   위치가 확인된 장소"에 대해서만, 사용자가 버튼을 눌렀을 때만 부른다.
 * - 필드마스크: id, displayName, regularOpeningHours, currentOpeningHours,
 *   utcOffsetMinutes, timeZone, businessStatus. 요청 하나는 마스크 안에서
 *   가장 높은 SKU 하나로 청구된다 — 영업시간 필드가 Enterprise 등급이라
 *   이 요청 전체가 "Place Details Enterprise" 1건이다(검색으로 교차 확인,
 *   공식 문서 직접 열람은 이 세션에서 막혀 있었다 — config.mjs 단가 주석).
 *   timeZone·utcOffsetMinutes·businessStatus는 더 낮은 등급 필드라 추가
 *   비용이 없다.
 * - **저장하지 않는다.** Google Maps Platform 약관상 장기 보관이 허용된
 *   것은 place ID(무기한)와 좌표(최대 30일)뿐이고, 영업시간에는 그런
 *   예외가 확인되지 않았다. 그래서 이 모듈과 호출부(routes/business-
 *   hours.mjs)는 응답을 DB·동기화·로그 어디에도 남기지 않고 요청한
 *   사용자에게 그대로 돌려주기만 한다(동시에 같은 장소를 부른 요청끼리
 *   진행 중인 호출 하나를 나눠 받는 것 — 병합 — 만 한다).
 * - 테스트 어댑터는 **합성 데이터**다. 실제 가게 정보가 아니며 화면에도
 *   source: 'test-adapter'로 드러난다.
 */
import { config } from '../config.mjs';
import { fetchWithTimeout } from '../net.mjs';
import { markVerified } from '../status.mjs';

export const BUSINESS_HOURS_FIELD_MASK = 'id,displayName,regularOpeningHours,currentOpeningHours,utcOffsetMinutes,timeZone,businessStatus';

function pad2(n) { return String(n).padStart(2, '0'); }
function ymdOf(d) {
  if (!d || typeof d !== 'object') return null;
  const y = Number(d.year), m = Number(d.month), day = Number(d.day);
  if (!y || !m || !day) return null;
  return `${y}-${pad2(m)}-${pad2(day)}`;
}
function normPoint(p) {
  if (!p || typeof p !== 'object') return null;
  const day = Number(p.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  return {
    day,
    hour: Number(p.hour) || 0,
    minute: Number(p.minute) || 0,
    date: ymdOf(p.date),
    truncated: p.truncated === true,
  };
}
function normHours(h) {
  if (!h || typeof h !== 'object') return null;
  const periods = (Array.isArray(h.periods) ? h.periods : [])
    .map((x) => ({ open: normPoint(x && x.open), close: normPoint(x && x.close) }))
    .filter((x) => x.open);
  const specialDays = (Array.isArray(h.specialDays) ? h.specialDays : [])
    .map((x) => ymdOf(x && x.date))
    .filter(Boolean);
  return {
    periods,
    specialDays,
    weekdayDescriptions: Array.isArray(h.weekdayDescriptions) ? h.weekdayDescriptions.map(String).slice(0, 7) : [],
  };
}

/* 공급자 응답 → 앱이 쓰는 모양. 필요한 필드만 옮기고 나머지는 버린다. */
export function normalizePlaceDetails(placeId, data) {
  const regular = normHours(data && data.regularOpeningHours);
  const current = normHours(data && data.currentOpeningHours);
  const hasAny = !!((regular && regular.periods.length) || (current && current.periods.length));
  return {
    placeId,
    status: hasAny ? 'ok' : 'no-hours',
    displayName: (data && data.displayName && data.displayName.text) || null,
    businessStatus: (data && data.businessStatus) || null,
    timeZone: (data && data.timeZone && data.timeZone.id) || null,
    utcOffsetMinutes: Number.isFinite(data && data.utcOffsetMinutes) ? data.utcOffsetMinutes : null,
    regular,
    current,
  };
}

async function googleAdapter(placeId) {
  const key = config.google.placesKey;
  if (!key) return { ok: false, reason: 'no-api-key-configured' };
  try {
    const res = await fetchWithTimeout(`${config.google.placesApiBase}/v1/places/${encodeURIComponent(placeId)}?languageCode=ko`, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': BUSINESS_HOURS_FIELD_MASK },
    }, config.externalRequestTimeoutMs);
    if (res.status === 404) return { ok: false, reason: 'not-found', status: 404 };
    if (!res.ok) return { ok: false, reason: 'http-error', status: res.status };
    const data = await res.json();
    markVerified('businessHours');
    return { ok: true, source: 'google-places', result: normalizePlaceDetails(placeId, data) };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

/* ---------- 합성 데이터(개발/테스트 전용) ---------- */
function hashOf(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function localTodayParts(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date());
  const get = (t) => (parts.find((x) => x.type === t) || {}).value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: +get('year'), m: +get('month'), d: +get('day'), wd };
}
function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
const P = (day, hour, minute) => ({ day, hour, minute });
function everyDay(fn) { const out = []; for (let d = 0; d < 7; d++) out.push(...fn(d)); return out; }

/* 패턴 이름 → 정규 영업시간(합성). 실제 가게를 흉내낸 것이 아니라 계산
   경로(휴무·브레이크·자정 넘김·24시간·정보 없음)를 하나씩 태우기 위한 것. */
const TEST_PATTERNS = {
  lunch: () => everyDay((d) => [{ open: P(d, 11, 0), close: P(d, 15, 0) }]),
  'break': () => everyDay((d) => [{ open: P(d, 11, 30), close: P(d, 14, 0) }, { open: P(d, 17, 0), close: P(d, 22, 0) }]),
  'closed-mon': () => everyDay((d) => (d === 1 ? [] : [{ open: P(d, 10, 0), close: P(d, 19, 0) }])),
  overnight: () => everyDay((d) => [{ open: P(d, 18, 0), close: P((d + 1) % 7, 2, 0) }]),
  '24h': () => [{ open: P(0, 0, 0) }],
  evening: () => everyDay((d) => [{ open: P(d, 17, 0), close: P(d, 23, 0) }]),
  none: () => [],
};
const HASH_ORDER = ['lunch', 'break', 'closed-mon', 'overnight', 'evening', '24h'];

function testAdapter(placeId) {
  const m = /^test-hours-([a-z0-9-]+?)(?:-\d+)?$/.exec(placeId);
  let pattern = m ? m[1] : HASH_ORDER[hashOf(placeId) % HASH_ORDER.length];
  if (pattern === 'fail') return { ok: false, reason: 'http-error', status: 500 };
  let specialClosedToday = false;
  if (pattern === 'special') { pattern = 'lunch'; specialClosedToday = true; }
  const build = TEST_PATTERNS[pattern] || TEST_PATTERNS.lunch;
  const periods = build();
  const tz = 'Asia/Tokyo';
  const today = localTodayParts(tz);
  // current(앞으로 7일) — 오늘부터 6일 뒤까지 요일별 정규시간을 날짜를
  // 붙여 펼친다. special 패턴은 오늘을 특별 휴무로 만든다.
  const current = { periods: [], specialDays: [] };
  if (pattern !== '24h') {
    for (let i = 0; i < 7; i++) {
      const date = addDays(today.y, today.m, today.d, i);
      const wd = (today.wd + i) % 7;
      if (specialClosedToday && i === 0) { current.specialDays.push({ date }); continue; }
      periods.filter((p) => p.open.day === wd).forEach((p) => {
        const closeDate = p.close && p.close.day !== p.open.day ? addDays(date.year, date.month, date.day, 1) : date;
        current.periods.push({ open: Object.assign({}, p.open, { date }), close: p.close ? Object.assign({}, p.close, { date: closeDate }) : undefined });
      });
    }
  } else {
    current.periods = periods;
  }
  const data = {
    id: placeId,
    displayName: { text: '합성 테스트 장소' },
    businessStatus: 'OPERATIONAL',
    timeZone: { id: tz },
    utcOffsetMinutes: 540,
    regularOpeningHours: periods.length ? { periods } : undefined,
    currentOpeningHours: periods.length ? current : undefined,
  };
  return { ok: true, source: 'test-adapter', result: normalizePlaceDetails(placeId, data) };
}

export async function fetchBusinessHours(placeId) {
  const mode = config.services.businessHours;
  if (mode === 'real') return googleAdapter(placeId);
  if (mode === 'test' && !config.isProd) return testAdapter(placeId);
  return { ok: false, reason: 'business-hours-disabled' };
}
