'use strict';
/**
 * 무료체험 1회 소진 — "동시 요청·재시도로 두 번 차감되지 않는다"를
 * DB의 PRIMARY KEY 제약으로 보장한다(db.mjs 상단 설명 참고). 실패
 * (네트워크 오류 등)는 이 함수를 아예 안 부르면 되므로 차감되지
 * 않는다 — "성공"의 정의를 호출하는 쪽(코스 생성이 실제로 끝난 뒤)이
 * 정한다.
 */
import { openDb, nowIso } from '../db.mjs';
import { config } from '../config.mjs';

export function trialStatus(accountId) {
  const db = openDb();
  const row = db.prepare('SELECT consumed_at FROM trial_usage WHERE account_id = ?').get(accountId);
  return { ok: true, used: !!row, limit: config.freeTrialLimit, consumedAt: row ? row.consumed_at : null };
}

/* 성공 시 딱 한 번만 true를 돌려준다 — 이미 썼으면(동시 요청이었든,
   재시도였든) false를 돌려준다. 예외를 던지지 않고 boolean으로
   결과를 알려준다(제약 위반 자체가 "이미 있음"이라는 정상 흐름의
   일부이지 오류가 아니다). */
export function consumeTrial(accountId) {
  const db = openDb();
  try {
    db.prepare('INSERT INTO trial_usage (account_id, consumed_at) VALUES (?, ?)').run(accountId, nowIso());
    return { ok: true, consumed: true };
  } catch (e) {
    // UNIQUE/PRIMARY KEY 제약 위반 = 이미 소진됨(동시 요청이었어도 단 하나만 여기까지 성공한다).
    return { ok: true, consumed: false, reason: 'already-used' };
  }
}
