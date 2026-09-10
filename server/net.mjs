'use strict';
/**
 * 외부 API 호출 공통 타임아웃 — "모든 외부 요청에 제한 시간을
 * 적용하라"(2026-09-10 재검토 4차)는 지시를 어댑터마다 따로 구현하지
 * 않기 위해 한 곳에 둔다.
 *
 * 중요한 한계: AbortController로 요청을 끊어도, 요청이 이미 공급자에
 * 도달한 뒤라면 "우리가 응답을 포기했다"는 것이지 "공급자가 그 요청을
 * 처리하지 않았다"는 뜻이 아니다 — 그래서 타임아웃(및 그 외 모든 네트워크
 * 예외)이 발생했을 때 "비용이 0원이었다"고 단정하지 않는다. 실제 비용
 * 처리는 호출부(routing.mjs/place-lookup.mjs)가 "실제 호출을 시도하기로
 * 결정한 시점"에 이미 비용을 확정 기록하므로(cost-ledger.mjs 참고), 이
 * 타임아웃 결과와 무관하게 그 기록은 남는다.
 */
export async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
