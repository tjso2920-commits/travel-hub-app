'use strict';
/**
 * 공용 잠금 헬퍼 — generation_locks(코스 생성)와 payment_locks(결제
 * 승인·취소)가 같은 패턴을 쓴다(2026-09-10 재검토 4차):
 *
 * 1. PRIMARY KEY INSERT로 원자적 잠금(같은 키로 두 번 성공할 수 없다 —
 *    trial_usage/rate_counters와 같은 근거, db.mjs 상단 설명 참고).
 * 2. **잠금 소유권 검증**: 잠금을 건 요청만 자신이 건 job_id로 해제할
 *    수 있다 — "죽은 프로세스의 잠금을 회수한 새 요청"의 잠금을, 뒤늦게
 *    깨어난 원래 요청이 실수로 지워버리는 사고를 막는다.
 * 3. **만료 회수**: 잠금이 timeoutSeconds보다 오래됐으면 죽은 프로세스가
 *    남긴 것으로 보고 회수한 뒤 한 번 더 시도한다 — 그렇지 않으면 서버가
 *    작업 도중 죽었을 때 그 키는 영원히 잠긴 채로 남는다.
 */
import { openDb, uuid, nowIso } from './db.mjs';

export function acquireLock(table, keyColumn, keyValue, timeoutSeconds) {
  const db = openDb();
  const jobId = uuid();
  const insert = () => db.prepare(`INSERT INTO ${table} (${keyColumn}, job_id, started_at) VALUES (?, ?, ?)`).run(keyValue, jobId, nowIso());
  try {
    insert();
    return jobId;
  } catch (e) {
    const existing = db.prepare(`SELECT started_at FROM ${table} WHERE ${keyColumn} = ?`).get(keyValue);
    const stale = existing && (Date.now() - new Date(existing.started_at).getTime() > (timeoutSeconds || 120) * 1000);
    if (!stale) return null; // 진행 중인 다른 작업이 실제로 있음
    db.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?`).run(keyValue);
    try {
      insert();
      return jobId;
    } catch (e2) {
      return null; // 회수 직후 다른 요청이 선점 — 이번엔 양보
    }
  }
}

export function releaseLock(table, keyColumn, keyValue, jobId) {
  const db = openDb();
  db.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ? AND job_id = ?`).run(keyValue, jobId);
}
