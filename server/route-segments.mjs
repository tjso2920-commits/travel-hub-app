'use strict';
/**
 * 경로 요청을 실제 Google Routes 호출 단위(세그먼트)로 나누는 순수
 * 계산 — server/adapters/routing.mjs(실제 실행)와
 * server/entitlement-usage.mjs(AI 분류 예산 예약 계산)가 **같은
 * 함수를 공유**해서 쓴다(2026-09-11 재검토 12차 — "가능하면 경로
 * 실행과 예산 예약이 같은 비용 계산 함수를 사용하도록 하라"는 지시).
 * 이 파일을 분리한 이유는 순환 참조 방지다 — routing.mjs는 이미
 * entitlement-usage.mjs를 가져다 쓰므로, entitlement-usage.mjs가
 * routing.mjs를 거꾸로 가져오면 순환이 생긴다.
 *
 * 좌표 값 자체는 이 계산에 필요 없다(경계 지점 개수만 있으면 세그먼트
 * 수·중간 경유지 수가 정해진다) — 그래서 실제 좌표 배열이든, 예약
 * 계산이 쓰는 "이 개수만큼의 자리표시자 배열"이든 똑같이 넣을 수 있다.
 */
import { config } from './config.mjs';

/* points: 경계 지점(출발지 포함) 배열 — 실제 좌표 객체든 자리표시자든
   길이만 본다. 조각 하나의 중간 경유지 수는 routesMaxIntermediatesPerCall
   을 넘지 않는다(경계 지점 2개 제외). */
export function splitIntoSegments(points) {
  const maxIntermediates = config.routesMaxIntermediatesPerCall;
  const maxPointsPerSegment = maxIntermediates + 2; // 시작점 + 경유지들 + 도착점
  const segments = [];
  let i = 0;
  while (i < points.length - 1) {
    const end = Math.min(i + maxPointsPerSegment - 1, points.length - 1);
    segments.push(points.slice(i, end + 1));
    i = end;
  }
  return segments;
}

/* 세그먼트 하나의 중간 경유지 수를 보고 실제 요금 SKU를 정한다 —
   routing.mjs의 callGoogleRoutesAll이 쓰는 것과 완전히 같은 판정. */
export function skuForSegment(segment) {
  const intermediateCount = segment.length - 2;
  return intermediateCount >= config.routesHighVolumeThreshold ? 'routes-compute-highvolume' : 'routes-compute';
}

/* pointCount(출발지 포함 총 경계 지점 수)만으로 실제 세그먼트 분할이
   일어났을 때 SKU 목록을 미리 계산한다 — 아직 실제 좌표가 없는(예산
   예약 시점의) 코스 생성 요청에 쓴다. 자리표시자 배열(undefined로
   채운 배열)을 splitIntoSegments에 그대로 넣어 실제 실행 경로와 완전히
   같은 알고리즘을 태운다. */
export function planWorstCaseSkus(pointCount) {
  const segments = splitIntoSegments(new Array(Math.max(0, pointCount)));
  return segments.map(skuForSegment);
}
