'use strict';
/**
 * 공용 고정 시간창(fixed-window) 카운터 — 로그인 코드 요청 쿨다운, 코스
 * 생성 시도 한도, 장소 조회 한도가 전부 이 하나의 패턴을 공유한다.
 *
 * 2026-09-10 재검토(3차): "속도 제한, 동시 요청 제한, 계정별 예산,
 * 서비스 전체 차단 한도를 구현하라"는 지시를 여러 곳에서 반복 구현하지
 * 않기 위해 여기 한 번만 만든다. `rate_counters` 테이블의 PRIMARY KEY
 * (scope, window_key)가 원자성을 보장한다 — 동시 요청 두 개가 같은
 * (scope, window_key)에 동시에 INSERT를 시도해도 SQLite가 하나만
 * 통과시키고(ON CONFLICT UPDATE), node:sqlite의 동기 API라 이 프로세스
 * 안에서는 그마저도 진짜 동시에 일어나지 않는다(trial_usage와 같은
 * 근거 — db.mjs 상단 설명 참고).
 */
import { openDb } from './db.mjs';

export function hourWindow(date) {
  return (date || new Date()).toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
}
export function dayWindow(date) {
  return (date || new Date()).toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

/* scope 하나·window 하나의 카운트를 by만큼 올리고(기본 1), limit을
   넘었는지 함께 돌려준다. limit이 없거나 0 이하면 "무제한"으로 취급한다
   (설정 안 하면 막지 않는다 — 값이 없을 때 조용히 0회로 막아버리는
   사고를 방지). by > 1은 "이번 한 번의 호출이 실제로는 N개 항목을
   처리한다"는 배치 상황에 쓴다(예: 장소 일괄 조회 — 호출 횟수가 아니라
   실제 처리 개수로 한도를 세야 한다). */
export function checkAndIncrement(scope, windowKey, limit, by) {
  const inc = Math.max(1, Number(by) || 1);
  const db = openDb();
  db.prepare(`
    INSERT INTO rate_counters (scope, window_key, count) VALUES (?, ?, ?)
    ON CONFLICT(scope, window_key) DO UPDATE SET count = count + excluded.count
  `).run(scope, windowKey, inc);
  const row = db.prepare('SELECT count FROM rate_counters WHERE scope = ? AND window_key = ?').get(scope, windowKey);
  const allowed = !limit || limit <= 0 || row.count <= limit;
  return { count: row.count, allowed, limit: limit || null };
}

/* 카운트를 올리지 않고 현재 값만 본다(한도 안내·디버깅용). */
export function peek(scope, windowKey) {
  const db = openDb();
  const row = db.prepare('SELECT count FROM rate_counters WHERE scope = ? AND window_key = ?').get(scope, windowKey);
  return row ? row.count : 0;
}
