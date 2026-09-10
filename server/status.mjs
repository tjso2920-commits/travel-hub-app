'use strict';
/**
 * "키가 있다"와 "실제로 연결해서 성공해 봤다"는 다른 사실이다(2026-09-10
 * 재검토: "상태 표시는 키 존재와 실제 연결 확인을 구분하라"). config.mjs의
 * services.*는 키 존재 여부만 본다 — 이 모듈은 실제 공급자 호출이
 * 성공했을 때만 시각을 기록한다. 프로세스 재시작하면 초기화되는 게
 * 맞다("이 프로세스가 뜬 뒤로 실제로 확인됐는지"를 보여주는 것이지
 * 영구 기록이 아니다).
 */
const lastVerifiedAt = { placeLookup: null, routing: null, payment: null, email: null };

export function markVerified(service) {
  if (service in lastVerifiedAt) lastVerifiedAt[service] = new Date().toISOString();
}

export function getVerifiedStatus() {
  return { ...lastVerifiedAt };
}
