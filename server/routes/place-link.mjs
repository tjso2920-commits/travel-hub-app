'use strict';
/**
 * Google Maps 장소 링크 붙여넣기로 한 곳 추가(2026-09-11 재검토 13차
 * 3절) — "붙여넣은 링크로 장소를 몇 곳 추가할 수 있어야 한다"는 요구를
 * 최소한으로, 그러나 정직하게 구현한다.
 *
 * 여기서 하는 일은 딱 하나 — **링크에서 이름·좌표 힌트를 뽑아내는 것**
 * 뿐이다. Google Places API를 부르지 않으므로 비용·이용권 소모가 전혀
 * 없다(축약 링크(goo.gl/maps.app.goo.gl)의 리다이렉트를 따라가는 것도
 * Google Places API 호출이 아니라 그냥 HTTP 리다이렉트 확인일 뿐이다).
 * 이렇게 뽑아낸 이름으로 실제 위치를 "확인"하는 단계(정확한 좌표를
 * 확정하는 Places 조회)는 기존 장소 조회 라우트(routes/places.mjs)를
 * 그대로 타므로, 기존 이용권·일일 한도·비용 상한이 그대로 적용된다 —
 * 이 라우트가 우회 경로가 되지 않는다.
 *
 * "지원하지 않는 링크를 조용히 성공으로 처리하지 않는다" — Google
 * Maps 도메인이 아니거나, 리다이렉트를 따라가도 이름·좌표 둘 다 못
 * 뽑아내면 명시적으로 실패를 돌려준다(빈 이름으로 장소를 만들지 않음).
 */
import { checkAndIncrement, dayWindow } from '../rate-limit.mjs';
import { config } from '../config.mjs';

// Google이 실제로 쓰는 지도 관련 호스트만 허용한다 — 임의의 URL을
// 서버가 대신 fetch하게 만드는 SSRF 경로가 되지 않도록 화이트리스트로
// 좁힌다. 축약 링크가 리다이렉트되는 "최종" 호스트도 이 목록 안이어야
// 한다(밖으로 새 나가면 지원 안 하는 링크로 처리).
const ALLOWED_HOSTS = new Set([
  'maps.google.com', 'www.google.com', 'google.com',
  'goo.gl', 'maps.app.goo.gl',
]);
const SHORT_HOSTS = new Set(['goo.gl', 'maps.app.goo.gl']);

function fm2Coord(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  return n;
}

// import-adapter.js의 daCoordFromUrl과 같은 패턴(!3d!4d, @lat,lng,
// q=lat,lng)을 그대로 재사용한다 — 클라이언트·서버가 서로 다른 런타임
// (브라우저 vs Node)이라 모듈을 직접 공유하진 못하지만, 판정 로직 자체는
// 반드시 동기화해서 유지해야 한다(server/adapters/ai-classify.mjs의
// TOP_CATEGORIES와 client FM_INFER 간 "수동 동기화 필요" 한계와 같은
// 성격 — RELEASE_STATUS.md에 명시).
function coordFromUrl(u) {
  const t = String(u || '');
  if (!t) return null;
  let m = t.match(/!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) m = t.match(/[@](-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) m = t.match(/(?:[?&](?:q|ll|sll|center|daddr|destination|query)|query)=(-?\d{1,3}(?:\.\d+)?)(?:,|%2C)(-?\d{1,3}(?:\.\d+)?)/i);
  if (!m) return null;
  const lat = fm2Coord(m[1], 90), lng = fm2Coord(m[2], 180);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return null;
  return { lat, lng };
}
function nameFromUrl(u) {
  try {
    const parsed = new URL(u);
    const m = parsed.pathname.match(/\/maps\/place\/([^/]+)/);
    if (!m) return null;
    const decoded = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
    return decoded ? decoded.slice(0, 200) : null;
  } catch (e) { return null; }
}

export async function resolvePlaceLinkRoute(accountId, url, opts) {
  opts = opts || {};
  if (!accountId) return { ok: false, status: 401, reason: 'unauthorized' };
  const raw = String(url || '').trim();
  if (!raw) return { ok: false, status: 400, reason: 'missing-url' };

  // 순수 무료 작업이지만(비용 없음), 서버가 대신 외부 fetch를 반복
  // 수행하는 경로라 남용 방지 차원의 가벼운 계정별 하루 한도만 둔다
  // (Places/Routes 비용 상한과는 완전히 별개 — 그 한도들은 실제 위치
  // 확인 단계에서 그대로 적용된다).
  const daily = checkAndIncrement(`place-link-resolve:${accountId}`, dayWindow(), config.placeLinkResolveDailyLimit, 1);
  if (!daily.allowed) return { ok: false, status: 429, reason: 'place-link-resolve-daily-limit-reached' };

  let parsed;
  try { parsed = new URL(raw); } catch (e) { return { ok: false, status: 400, reason: 'invalid-url' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, status: 400, reason: 'invalid-url' };
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return { ok: false, status: 200, reason: 'unsupported-link' };

  let finalUrl = raw;
  let followedShortLink = false;
  if (SHORT_HOSTS.has(parsed.hostname)) {
    followedShortLink = true;
    const fetcher = opts.fetchImpl || fetch;
    try {
      const res = await fetcher(raw, { redirect: 'follow', signal: AbortSignal.timeout(5000) });
      finalUrl = res.url || raw;
    } catch (e) {
      return { ok: false, status: 200, reason: 'link-resolve-failed' };
    }
    let finalParsed;
    try { finalParsed = new URL(finalUrl); } catch (e) { return { ok: false, status: 200, reason: 'unsupported-link' }; }
    if (!ALLOWED_HOSTS.has(finalParsed.hostname)) return { ok: false, status: 200, reason: 'unsupported-link' };
  }

  const name = nameFromUrl(finalUrl);
  const coord = coordFromUrl(finalUrl);
  if (!name && !coord) {
    // 링크는 Google Maps가 맞지만(도메인 통과), 이름도 좌표도 뽑아낼
    // 근거가 전혀 없다 — "지원 안 하는 링크를 성공으로 위장"하지
    // 않고 명시적으로 실패를 돌려준다.
    return { ok: false, status: 200, reason: 'no-place-info-found', followedShortLink };
  }
  return { ok: true, status: 200, name: name || null, lat: coord ? coord.lat : null, lng: coord ? coord.lng : null, finalUrl, followedShortLink };
}
