'use strict';
/**
 * 최소 제휴 준비(2026-09-11 재검토 9차) — docs/BUSINESS_DECISIONS.md
 * 7절 참고. 사업 방향(1-2절)의 "추가 수익(보조): 필요할 때만 eSIM·
 * 교통·티켓 등 제휴"를 실제로 켤 수 있는 최소 구조만 미리 만든다 —
 * 아직 승인된 실제 제휴가 하나도 없어 AFFILIATE_OFFERS가 빈 배열이고,
 * 그래서 이 기능은 지금 어떤 화면에도 나타나지 않는다(의도된 기본
 * 상태 — "곧 열립니다" 같은 자리 채우기도 안 만든다).
 *
 * 지켜야 할 것들(요청 원문 그대로):
 * - 승인된 실제 링크가 없으면 소비자 화면에서 숨긴다.
 * - 허용 도메인 화이트리스트 검증(임의 URL 노출 금지).
 * - 제휴 유무·수수료가 코스 추천 로직에 전혀 영향을 주지 않는다 —
 *   그래서 이 파일은 course-generation.mjs 등 코스 계산 코드를
 *   절대 import하지 않는다(코드 구조 자체로 분리를 보장).
 * - 사용자의 저장 목록·좌표·이메일 같은 개인 데이터를 제휴 링크로
 *   전송하지 않는다 — 여기서 돌려주는 url은 등록해 둔 정적 문자열
 *   그대로일 뿐, 쿼리 파라미터를 조합해 만들지 않는다.
 */

// 실제 승인된 제휴사의 정확한 도메인만 여기에 추가한다 — 화이트리스트에
// 없는 도메인의 링크는 activeOffersForCity가 걸러낸다.
export const ALLOWED_AFFILIATE_DOMAINS = [];

// { id, type: 'esim'|'transit'|'ticket'|'lodging', city, label, url, active }
// 도시명은 앱이 이미 쓰는 도시 표기(예: '후쿠오카')와 정확히 일치해야
// 매칭된다.
export const AFFILIATE_OFFERS = [];

const ALLOWED_TYPES = new Set(['esim', 'transit', 'ticket', 'lodging']);

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false; // http는 절대 허용 안 함.
    return ALLOWED_AFFILIATE_DOMAINS.includes(u.hostname);
  } catch (e) {
    return false;
  }
}

/* 이 도시에 지금 보여줄 수 있는 제휴만 골라 소비자 화면에 필요한
   최소 필드만 돌려준다(내부 관리용 필드는 제외). */
export function activeOffersForCity(city) {
  if (!city) return [];
  return AFFILIATE_OFFERS
    .filter((o) => o && o.active && ALLOWED_TYPES.has(o.type) && o.city === city && o.label && isAllowedUrl(o.url))
    .map((o) => ({ id: o.id, type: o.type, label: o.label, url: o.url }));
}
