'use strict';
/**
 * 장소 조회 어댑터 — 소비자에게 API 키를 요구하지 않는다는 원칙(코드
 * 검토 ④) 때문에, 이 조회는 반드시 서버에서 실행돼야 한다. 클라이언트는
 * 이 서버의 /api/places/lookup 또는 /api/places/lookup-batch만 호출한다.
 *
 * 2026-09-10 재검토(4차) — "Legacy Find Place의 첫 후보를 바로 확정하지
 * 말고 Places API(New) 기준으로 정리하라"는 지시로 어댑터를 교체했다:
 * - 엔드포인트: `POST {placesApiBase}/v1/places:searchText`(Text Search,
 *   New) — 예전 `findplacefromtext`(Legacy)를 대체한다.
 * - 필드마스크: `places.id,places.displayName,places.location,
 *   places.formattedAddress`만 요청한다 — Places API(New)는 필드마스크에
 *   따라 과금 등급(Essentials IDs Only < Essentials < Pro < Enterprise)이
 *   갈린다고 알려져 있다(학습 기억 기준, 재확인 필요). 우리가 실제로
 *   쓰는 필드(좌표·이름·주소·placeId)는 가장 싼 등급에 속하는 것으로
 *   추정하지만, 이 세션은 mapsplatform.google.com 접속이 막혀
 *   재확인하지 못했다(RELEASE_STATUS.md 참고).
 * - **동명 장소 오확정 방지**: Text Search(New)는 여러 후보를 순서대로
 *   돌려준다. 첫 번째 후보를 무조건 쓰지 않고, 기대 지역(동/구/도시
 *   등, 클라이언트가 이미 갖고 있는 주소 힌트)과 실제로 맞는 후보를
 *   우선한다 — 그런 후보가 없으면 1순위를 쓰되 `ambiguous:true`로
 *   표시해 화면이 "이게 맞나요?" 확인을 더 분명히 하게 한다(다만 이
 *   앱은 애초에 서버 조회 결과를 자동 반영하지 않고 항상 사람이
 *   "맞아요"를 눌러야 반영한다 — daLookupCandidateSheet — 그래서
 *   ambiguous 표시는 "이번엔 특히 더 잘 확인하라"는 신호일 뿐, 자동
 *   반영 여부 자체를 바꾸지는 않는다).
 * - **기존 유효한 좌표·식별자 우선**: 이미 placeId나 좌표가 있는
 *   장소는애초에 이 어댑터까지 오지 않게 호출부(places.mjs)가
 *   걸러야 한다(중복 유료 호출 방지 — 6-② 지시).
 */
import { config } from '../config.mjs';
import { markVerified } from '../status.mjs';
import { fetchWithTimeout } from '../net.mjs';

/* 테스트 어댑터 — 이름에 "역"·"타워"가 들어가면 그럴듯한 좌표를 만들어
   돌려주고, 그 외엔 "찾지 못함"으로 정직하게 답한다. 실제 조회 성공/
   실패 양쪽 코드 경로를 실제 브라우저 없이도 서버 테스트에서 검증할 수
   있게 하기 위한 것이다 — 가짜로 "다 찾아진다"고 하지 않는다. */
function testAdapter({ query }) {
  const q = String(query || '');
  if (!q.trim()) return { ok: false, reason: 'empty-query' };
  // 결정론적인 가짜 좌표 — 같은 질의는 항상 같은 결과를 준다(테스트 재현성).
  let hash = 0;
  for (let i = 0; i < q.length; i++) hash = (hash * 31 + q.charCodeAt(i)) | 0;
  if (Math.abs(hash) % 5 === 0) return { ok: false, reason: 'not-found' };
  const lat = 33.5 + (Math.abs(hash) % 1000) / 10000;
  const lng = 130.3 + (Math.abs(hash >> 8) % 1000) / 10000;
  // 2026-09-11 재검토(10차) 5절 — 개발/테스트에서도 "확인된 유형" 우선
  // 분류 경로를 실제로 태워 볼 수 있게, 결정론적인 가짜 types를 준다
  // (실제 Google 응답의 자유형 문자열 형태를 흉내낸 것일 뿐 실제
  // 값이 아니다).
  const fakeTypes = /역|타워|station|tower/i.test(q) ? ['transit_station'] : ['restaurant', 'food'];
  return { ok: true, lat, lng, name: q, address: q, source: 'test-adapter', placeId: 'test-' + Math.abs(hash), ambiguous: false, candidates: [], types: fakeTypes, primaryType: fakeTypes[0] };
}

/* candidates 중 expectedArea(도시·동네 등 힌트 문자열)와 formattedAddress
   가 실제로 겹치는 후보를 우선한다 — "모호한 동명 장소를 첫 검색 결과
   라는 이유만으로 확정하지 말라"는 지시의 핵심 구현. 겹치는 후보가
   없으면 null을 돌려주고(호출부가 1순위를 쓰되 ambiguous로 표시한다). */
function pickByArea(candidates, expectedArea) {
  const hint = String(expectedArea || '').trim();
  if (!hint) return null;
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const hintNorm = norm(hint);
  if (!hintNorm) return null;
  return candidates.find((c) => norm(c.formattedAddress).includes(hintNorm)) || null;
}

function toCandidate(place) {
  const loc = place.location || {};
  return {
    placeId: place.id,
    name: place.displayName && place.displayName.text,
    address: place.formattedAddress,
    lat: loc.latitude,
    lng: loc.longitude,
    // 2026-09-11 재검토(10차) 5절 — "이미 확보한 신뢰 가능한 장소
    // 유형"을 분류 우선순위 체인에 쓰기 위해 캡처한다. 분류만을 위해
    // 새 유료 조회를 추가하지 말라는 지시가 있어, 새 호출을 만들지
    // 않고 위치 확인(이미 실행되는 이 호출) 응답에서 함께 얻는다.
    // 주의: 이 필드 추가가 과금 등급(Pro 유지인지, 더 비싼 등급으로
    // 바뀌는지)을 바꾸는지는 이 세션이 developers.google.com 접속이
    // 막혀 재확인하지 못했다 — 위 파일 상단 주석과 같은 상황이며,
    // 운영 전 반드시 공식 문서로 재확인해야 한다(RELEASE_STATUS.md).
    types: Array.isArray(place.types) ? place.types : [],
    primaryType: place.primaryType || null,
  };
}

/* 실제 Google Places API(New) 어댑터 — GOOGLE_PLACES_API_KEY가 설정된
   실제 운영 환경에서만 쓰인다. 이 함수 자체는 구현돼 있지만, 실제
   키가 없는 개발 환경에서는 절대 호출되지 않는다(config.testMode가
   항상 우선한다 — lookupPlace()가 그 분기를 담당). */
async function googleAdapter({ query, expectedArea }) {
  const key = config.google.placesKey;
  if (!key) return { ok: false, reason: 'no-api-key-configured' };
  try {
    const res = await fetchWithTimeout(`${config.google.placesApiBase}/v1/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress,places.types,places.primaryType',
      },
      body: JSON.stringify({ textQuery: query, languageCode: 'ko' }),
    }, config.externalRequestTimeoutMs);
    if (!res.ok) return { ok: false, reason: 'http-error', status: res.status };
    const data = await res.json();
    const places = Array.isArray(data.places) ? data.places : [];
    if (!places.length) return { ok: false, reason: 'not-found' };

    const candidates = places.slice(0, 5).map(toCandidate);
    const areaMatch = pickByArea(places, expectedArea);
    const picked = areaMatch ? toCandidate(areaMatch) : candidates[0];
    const ambiguous = candidates.length > 1 && !areaMatch;

    markVerified('placeLookup');
    return {
      ok: true,
      lat: picked.lat,
      lng: picked.lng,
      name: picked.name,
      address: picked.address,
      source: 'google-places-new',
      placeId: picked.placeId,
      ambiguous,
      candidates,
      types: picked.types,
      primaryType: picked.primaryType,
    };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

export async function lookupPlace(params) {
  if (config.services.placeLookup === 'real') return googleAdapter(params);
  // 2026-09-10: 운영인데 키가 없으면(unavailable) 조용히 가짜 좌표로
  // 넘어가지 않는다 — 정직하게 "이 기능은 지금 못 씀"이라고 답한다.
  if (config.isProd) return { ok: false, reason: 'place-lookup-unavailable' };
  return testAdapter(params);
}
