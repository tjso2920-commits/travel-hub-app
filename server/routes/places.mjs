'use strict';
/**
 * 장소 조회 프록시 — 클라이언트는 이 엔드포인트만 부른다. 실제 조회
 * 공급자(테스트 어댑터든 실제 Google Places든)의 키·요청 한도·비용은
 * 전부 서버 쪽 관심사다(코드 검토 ④: 소비자에게 API 키를 요구하지 않는다).
 */
import { lookupPlace } from '../adapters/place-lookup.mjs';

export async function lookupPlaceRoute(query) {
  if (!query || !String(query).trim()) return { ok: false, status: 400, reason: 'missing-query' };
  const result = await lookupPlace({ query });
  return { ok: true, status: 200, result };
}
