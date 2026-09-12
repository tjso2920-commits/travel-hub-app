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

// 2026-09-11 재검토(14차) 3절 — ChatGPT 지적: "@lat,lng"는 그 장소의
// 진짜 좌표가 아니라 지도 화면의 중심(뷰포트)일 수 있다 — 예를 들어
// "/maps/place/테스트카페/@35.1,129.1,13z"에서 @ 뒤 좌표는 그 줌
// 레벨에서 지도가 보여주는 중심일 뿐, "테스트카페"의 정확한 위치라는
// 보장이 없다(사용자가 지도를 조금 움직인 뒤 공유했을 수도 있음).
// 반면 !3d!4d 패턴은 Google Maps가 특정 장소 항목의 데이터 블록에
// 실제로 박아 넣는 정밀 좌표라 장소 자체의 좌표로 신뢰할 수 있다.
// 그래서 "확정 좌표"(!3d!4d)와 "중심/뷰포트 좌표"(@, q=, ll= 등)를
// 서로 다른 함수로 분리한다 — 뒤엣것은 절대 "확정된 장소 좌표"로
// 저장하지 않고(course-generation.mjs도 p.lat/p.lng가 실제로 채워져
// 있어야만 실좌표로 쓰므로, 애초에 이 필드에 넣지 않는 것만으로
// 코스 생성이 중심좌표를 실좌표로 오인하는 경로를 막는다), 이름이
// 아예 없을 때만 "위치 확인이 더 필요함" 힌트로 클라이언트에 알려
// 준다(아래 resolvePlaceLinkRoute의 nameRequired 참고).
// import-adapter.js의 daCoordFromUrl과 판정 로직을 동기화 유지해야
// 한다(server/adapters/ai-classify.mjs의 TOP_CATEGORIES와 client
// FM_INFER 간 "수동 동기화 필요" 한계와 같은 성격 — RELEASE_STATUS.md).
function confirmedCoordFromUrl(u) {
  const t = String(u || '');
  if (!t) return null;
  const m = t.match(/!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = fm2Coord(m[1], 90), lng = fm2Coord(m[2], 180);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return null;
  return { lat, lng };
}
function centerCoordFromUrl(u) {
  const t = String(u || '');
  if (!t) return null;
  let m = t.match(/[@](-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
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

// 2026-09-11 재검토(14차) 3절 — "최종 호스트만 보면 되는 게 아니라
// 리다이렉트 중간 경유지 하나하나를 검사해야 한다": redirect:'follow'는
// 최종 res.url만 돌려주므로, 중간의 한 홉이 신뢰 안 되는 곳이어도(예:
// 공격자가 한 번은 허용 호스트를 거쳤다가 다시 내부망으로 튀는 경우)
// 겉으로는 "최종 목적지가 Google"인 것처럼 보일 수 있다. 그래서 매
// 홉을 직접 확인하고(redirect:'manual'), 상한(MAX_REDIRECT_HOPS) 안에서
// 끝나지 않으면 거절한다. 본문은 전혀 필요 없으므로(최종 URL만 필요)
// HEAD로 요청해 불필요한 응답 본문 전송을 피한다.
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_FETCH_TIMEOUT_MS = 5000;

function allowedHopUrl(u) {
  let p;
  try { p = new URL(u); } catch (e) { return null; }
  // 홉은 전부 HTTPS·기본 포트만 허용한다 — 평문 HTTP로 새거나 임의
  // 포트로 튀는 리다이렉트는 그 자체로 의심스러운 신호이기 때문이다.
  if (p.protocol !== 'https:') return null;
  if (p.port) return null;
  if (!ALLOWED_HOSTS.has(p.hostname)) return null;
  return p;
}

async function followShortLink(startUrl, fetcher) {
  let current = startUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    if (!allowedHopUrl(current)) return { ok: false, reason: 'unsupported-link' };
    let res;
    try {
      res = await fetcher(current, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(REDIRECT_FETCH_TIMEOUT_MS) });
    } catch (e) {
      return { ok: false, reason: 'link-resolve-failed' };
    }
    const status = Number(res.status) || 0;
    if (status >= 300 && status < 400) {
      const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      if (!location) return { ok: false, reason: 'link-resolve-failed' };
      let next;
      try { next = new URL(location, current).toString(); } catch (e) { return { ok: false, reason: 'link-resolve-failed' }; }
      current = next;
      continue;
    }
    if (!allowedHopUrl(current)) return { ok: false, reason: 'unsupported-link' };
    return { ok: true, finalUrl: current };
  }
  // 상한 안에 안 끝남 — 정상적인 단축 링크라면 이 정도로 안 길다.
  return { ok: false, reason: 'link-resolve-failed' };
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
    const followed = await followShortLink(raw, fetcher);
    if (!followed.ok) return { ok: false, status: 200, reason: followed.reason, followedShortLink };
    finalUrl = followed.finalUrl;
  }

  const name = nameFromUrl(finalUrl);
  const confirmedCoord = confirmedCoordFromUrl(finalUrl);
  const centerCoord = centerCoordFromUrl(finalUrl);
  if (!name && !confirmedCoord && !centerCoord) {
    // 링크는 Google Maps가 맞지만(도메인 통과), 이름도 좌표도 뽑아낼
    // 근거가 전혀 없다 — "지원 안 하는 링크를 성공으로 위장"하지
    // 않고 명시적으로 실패를 돌려준다.
    return { ok: false, status: 200, reason: 'no-place-info-found', followedShortLink };
  }
  // "중심/뷰포트 좌표"(centerCoord)는 확정 좌표로 절대 반환하지 않는다
  // (course-generation.mjs 등 뒤쪽 어디서도 p.lat/p.lng를 실좌표로 바로
  // 쓰므로, 이 필드에 아예 넣지 않는 게 안전하다) — 이름이 있으면
  // 기존 needsLookup 큐에 올라가 실제 위치 확인(Places 조회)을 거치고,
  // 이름조차 없으면 아래에서 nameRequired로 클라이언트에 입력을 요구한다.
  const lat = confirmedCoord ? confirmedCoord.lat : null;
  const lng = confirmedCoord ? confirmedCoord.lng : null;
  if (!name) {
    return { ok: true, status: 200, name: null, nameRequired: true, lat, lng, finalUrl, followedShortLink };
  }
  return { ok: true, status: 200, name, nameRequired: false, lat, lng, finalUrl, followedShortLink };
}
