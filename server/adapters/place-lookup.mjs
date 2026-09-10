'use strict';
/**
 * 장소 조회 어댑터 — 소비자에게 API 키를 요구하지 않는다는 원칙(코드
 * 검토 ④) 때문에, 이 조회는 반드시 서버에서 실행돼야 한다. 클라이언트는
 * 이 서버의 /api/places/lookup만 호출한다.
 *
 * 2026-09-09 코드 검토: "실 계정·크리덴셜이 없다는 이유로 구현을 멈추지
 * 말 것." 테스트 어댑터는 실제 코드 경로(요청 파싱 → 어댑터 호출 → 응답
 * 정규화)를 전부 그대로 타지만, 외부 네트워크 대신 미리 정해 둔 값을
 * 돌려준다 — 실제 서비스 전환은 googleAdapter의 fetch URL을 실 API로
 * 바꾸는 것만 남는다(요청/응답 정규화 로직은 이미 완성돼 있다).
 */
import { config } from '../config.mjs';

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
  return { ok: true, lat, lng, name: q, source: 'test-adapter', placeId: 'test-' + Math.abs(hash) };
}

/* 실제 Google Places 어댑터 — GOOGLE_PLACES_API_KEY가 설정된 실제
   운영 환경에서만 쓰인다. 이 함수 자체는 구현돼 있지만, 실제 키가
   없는 이 개발 환경에서는 절대 호출되지 않는다(config.testMode가
   항상 우선한다 — placeLookup()이 그 분기를 담당). */
async function googleAdapter({ query }) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { ok: false, reason: 'no-api-key-configured' };
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=geometry,name,place_id&key=${key}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, reason: 'http-error' };
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    if (!cand) return { ok: false, reason: 'not-found' };
    return {
      ok: true,
      lat: cand.geometry.location.lat,
      lng: cand.geometry.location.lng,
      name: cand.name,
      source: 'google-places',
      placeId: cand.place_id,
    };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

export async function lookupPlace(params) {
  if (config.testMode || config.adapters.placeLookup !== 'google') return testAdapter(params);
  return googleAdapter(params);
}
