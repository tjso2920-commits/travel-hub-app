'use strict';
/**
 * 개인화 코스 생성 — 인증 → 이용권/체험 확인 → 생성 → 결과 저장 →
 * 성공 확정까지 전부 서버가 집행한다.
 *
 * 2026-09-10 재검토(3차)의 핵심 지적: "현재 코스는 브라우저에서
 * 계산하고 /api/trial/consume은 나중에 호출한다. 동시 차감 요청 20개
 * 중 1개 성공은 '생성 1회' 보장이 아니다." 이 파일이 그 구조를 바꾼
 * 결과다: 인증 필수, 멱등성, 계정별 동시 생성 잠금, 레이트리밋, 비용
 * 드는 작업 전 게이트 확인, 실패 시 차감 제외.
 *
 * 2026-09-10 재검토(4차) 추가 수정:
 * 1. **잠금 만료·소유권 검증** — job_id로 자기가 건 잠금만 풀 수 있고,
 *    오래된 잠금(죽은 프로세스로 추정)은 회수한다(server/locks.mjs).
 * 2. **멱등키 충돌 확장** — 같은 idempotencyKey에 실제로 다른 요청
 *    본문(장소·날짜 등)이 오면 저장된 옛 결과를 그대로 주지 않고
 *    충돌(409)로 처리한다.
 * 3. **결과 저장 원자성** — 체험 차감·코스 저장·결과 기록을 하나의 DB
 *    트랜잭션으로 묶는다. 외부 라우팅 API 호출은 이 트랜잭션 밖에서
 *    이미 끝낸 뒤라 트랜잭션 자체는 순수 로컬 DB 쓰기만 포함한다(오래
 *    걸리지 않는다). 저장이 실패하면(ROLLBACK) 체험도 차감되지 않은
 *    채로 남는다.
 * 4. **입력 검증** — 좌표 범위, 장소 개수, 시간 예산이 상식적인 범위를
 *    벗어나면 그 자리에서 거부한다(서버가 좌표·개수·시간 예산을
 *    검증하라는 지시 반영).
 */
import { openDb, nowIso } from '../db.mjs';
import { config } from '../config.mjs';
import crypto from 'node:crypto';
import { computeWalkingRoute } from '../adapters/routing.mjs';
import { assembleCourse } from '../course-assembly.mjs';
import { trialStatus, consumeTrial } from './trial.mjs';
import { checkEntitlement } from './entitlement.mjs';
import { upsertAccountCourse } from './account-data.mjs';
import { checkAndIncrement, hourWindow } from '../rate-limit.mjs';
import { acquireLock, releaseLock } from '../locks.mjs';

function requestHash(body) {
  // 멱등키가 같은데 실제 내용이 다른 요청을 구분하기 위한 지문. 순서에
  // 안 흔들리게 장소는 id만 정렬해서 뽑는다(같은 장소 집합이면 배열
  // 순서가 달라도 같은 요청으로 본다 — 그 정도 차이까지 충돌로 볼
  // 필요는 없다).
  const placeIds = Array.isArray(body.places) ? body.places.map((p) => p && p.id).sort() : [];
  const material = JSON.stringify({
    city: body.city, date: body.date, origin: body.origin,
    startMinutes: body.startMinutes, budgetMinutes: body.budgetMinutes,
    placeIds,
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

function findStoredResult(idempotencyKey) {
  const db = openDb();
  return db.prepare('SELECT account_id, request_hash, result FROM generation_results WHERE idempotency_key = ?').get(idempotencyKey);
}
function storeResult(idempotencyKey, accountId, hash, status, result) {
  const db = openDb();
  db.prepare(`
    INSERT INTO generation_results (idempotency_key, account_id, request_hash, status, result, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(idempotencyKey, accountId, hash, status, JSON.stringify(result), nowIso());
}

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function isValidLatLng(p) {
  return p && isFiniteNumber(p.lat) && isFiniteNumber(p.lng) && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}

/* 서버가 좌표 범위·개수·시간 예산을 검증한다(2026-09-10 재검토 4차 —
   "임의 개수·비정상 값을 그대로 외부 API에 넘기지 말라"). 여기서
   막으면 애초에 비용이 드는 라우팅 호출까지 가지도 않는다. */
function validateRequest(body) {
  const origin = body.origin;
  if (!origin || !isValidLatLng(origin)) return 'invalid-origin-coords';
  const places = Array.isArray(body.places) ? body.places : [];
  if (!places.length) return 'no-places';
  if (places.length > config.maxPlacesPerGeneration) return 'too-many-places';
  for (const p of places) {
    if (p && (p.lat !== undefined || p.lng !== undefined) && !isValidLatLng(p)) return 'invalid-place-coords';
  }
  if (body.startMinutes !== undefined && (!isFiniteNumber(body.startMinutes) || body.startMinutes < 0 || body.startMinutes > 24 * 60)) {
    return 'invalid-start-minutes';
  }
  if (body.budgetMinutes !== undefined && body.budgetMinutes !== null) {
    if (!isFiniteNumber(body.budgetMinutes) || body.budgetMinutes < 0 || body.budgetMinutes > config.maxBudgetMinutes) return 'invalid-budget-minutes';
  }
  return null;
}

export async function generateCourseRoute(accountId, body) {
  body = body || {};
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!idempotencyKey) return { ok: false, status: 400, reason: 'missing-idempotency-key' };

  const hash = requestHash(body);
  const existing = findStoredResult(idempotencyKey);
  if (existing) {
    if (existing.account_id !== accountId) return { ok: false, status: 409, reason: 'idempotency-key-conflict' };
    if (existing.request_hash && existing.request_hash !== hash) {
      return { ok: false, status: 409, reason: 'idempotency-key-body-mismatch' };
    }
    return { ok: true, status: 200, ...JSON.parse(existing.result), replay: true };
  }

  const city = String(body.city || '').trim();
  const date = String(body.date || '').trim();
  if (!city || !date) return { ok: false, status: 400, reason: 'invalid-request' };
  const invalidReason = validateRequest(body);
  if (invalidReason) return { ok: false, status: 400, reason: invalidReason };
  const origin = body.origin;
  const places = body.places;

  const jobId = acquireLock('generation_locks', 'account_id', accountId, config.generationLockTimeoutSeconds);
  if (!jobId) {
    return { ok: false, status: 409, reason: 'generation-in-progress' };
  }

  try {
    const rate = checkAndIncrement(`gen:${accountId}`, hourWindow(), config.generationRateLimitPerHour);
    if (!rate.allowed) return { ok: false, status: 429, reason: 'rate-limited', limit: rate.limit };

    // 비용 드는 라우팅 호출 전에 먼저 이용권/체험 여부를 확인한다 —
    // 어차피 결제가 필요한 요청 때문에 실제 API 비용이 나가지 않게.
    const trial = trialStatus(accountId);
    const ent = checkEntitlement(accountId);
    const isPaid = ent.ok && ent.plan === 'paid';
    if (trial.used && !isPaid) {
      const rejected = { ok: false, status: 402, reason: 'payment-required', price: ent.ok ? ent.price : config.price };
      storeResult(idempotencyKey, accountId, hash, 'rejected', rejected);
      return rejected;
    }

    // computeWalkingRoute(정확히는 orderByNearestNeighbor)는 좌표 유무를
    // 스스로 거르지 않는다 — 좌표 없는 곳까지 섞여 들어가면 순서·구간
    // 계산 자체가 깨진다(실제로 재현된 버그: 좌표 없는 곳이 stops에
    // legs 없이 끼어 들어갔었다). assembleCourse가 기대하는 "좌표 있는
    // 곳만"을 여기서 미리 걸러 넘긴다.
    const withCoords = places.filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number');
    const routeResult = withCoords.length ? await computeWalkingRoute(origin, withCoords, accountId) : { routedReal: false, ordered: [], legs: [] };
    const assembled = assembleCourse({
      places,
      startMinutes: body.startMinutes,
      budgetMinutes: body.budgetMinutes,
      routeResult,
    });
    if (!assembled.ok) {
      const failure = { ok: false, status: 400, reason: assembled.reason, excluded: assembled.excluded, excludedReasons: assembled.excludedReasons };
      storeResult(idempotencyKey, accountId, hash, 'failed', failure);
      return failure;
    }

    const course = {
      made: new Date().toISOString().slice(0, 10),
      date, city, origin,
      mode: 'walking',
      startMinutes: body.startMinutes || 0,
      budgetMinutes: body.budgetMinutes || null,
      stops: assembled.stops,
      endAt: assembled.endAt,
      walkTotal: assembled.walkTotal,
      routedReal: assembled.routedReal,
      totalMeters: assembled.totalMeters,
      excludedIds: assembled.excluded.map((p) => p.id),
      excludedReasons: assembled.excludedReasons,
      source: 'server',
    };

    // "실패 시 차감 제외" — 추정(routedReal=false) 결과는 무료체험을
    // 쓰지 않는다. 정확히 이 조건에서만, 그리고 딱 한 번만 차감한다.
    //
    // 2026-09-10 재검토(4차): 체험 차감 + 코스 저장 + 결과 기록을 하나의
    // DB 트랜잭션으로 묶는다 — 외부 라우팅 API 호출은 이미 끝난 뒤라
    // 이 블록 안에는 네트워크 대기가 없다(순수 로컬 쓰기만). 저장이
    // 실패하면 전부 롤백돼 체험도 차감되지 않은 채로 남는다(재시도 시
    // 같은 idempotencyKey가 아직 "없음"이라 정상적으로 다시 시도된다).
    const db = openDb();
    let trialConsumed = false;
    let success;
    db.exec('BEGIN');
    try {
      if (!isPaid && !trial.used && course.routedReal) {
        const consumed = consumeTrial(accountId);
        trialConsumed = !!consumed.consumed;
      }
      upsertAccountCourse(accountId, course);
      success = { ok: true, status: 200, course, trialConsumed, plan: isPaid ? 'paid' : 'free' };
      storeResult(idempotencyKey, accountId, hash, 'success', success);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return { ok: false, status: 500, reason: 'course-storage-failed' };
    }
    return success;
  } finally {
    releaseLock('generation_locks', 'account_id', accountId, jobId);
  }
}
