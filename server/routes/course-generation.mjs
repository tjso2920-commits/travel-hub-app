'use strict';
/**
 * 개인화 코스 생성 — 인증 → 이용권/체험 확인 → 생성 → 결과 저장 →
 * 성공 확정까지 전부 서버가 집행한다.
 *
 * 2026-09-10 재검토(3차)의 핵심 지적: "현재 코스는 브라우저에서
 * 계산하고 /api/trial/consume은 나중에 호출한다. 동시 차감 요청 20개
 * 중 1개 성공은 '생성 1회' 보장이 아니다 — 브라우저에서 차감 요청을
 * 생략하거나 동시에 생성하면 제한을 우회할 수 있다." 이 파일이 그
 * 구조를 바꾼 결과다:
 *
 * 1. **인증 필수** — 샘플이 아닌 개인화 코스는 로그인 없이는 아예
 *    호출할 수 없다(라우트 자체가 세션 토큰을 요구한다).
 * 2. **멱등성** — 클라이언트가 만든 idempotencyKey로 같은 요청이
 *    재시도돼도 실제 작업을 다시 안 하고 저장된 결과를 그대로 준다.
 * 3. **계정별 동시 생성 잠금** — generation_locks(account_id PRIMARY
 *    KEY)로 같은 계정이 동시에 두 번 생성을 진행 못 하게 막는다.
 * 4. **레이트리밋** — 성공/실패 무관하게 시간당 시도 횟수를 제한한다
 *    (남용 방지 — 무료체험 차감 여부와는 별개 문제).
 * 5. **비용 드는 작업 전에 게이트 확인** — 이용권/체험 여부를 실제
 *    라우팅 API를 부르기 전에 먼저 확인해, 어차피 막힐 요청 때문에
 *    비용이 나가지 않게 한다.
 * 6. **"실패 시 차감 제외"** — 추정(직선거리) 결과로 대체됐을 때는
 *    무료체험을 차감하지 않는다. `routedReal === true`일 때만 딱 한
 *    번 차감한다.
 */
import { openDb, nowIso } from '../db.mjs';
import { config } from '../config.mjs';
import { computeWalkingRoute } from '../adapters/routing.mjs';
import { assembleCourse } from '../course-assembly.mjs';
import { trialStatus, consumeTrial } from './trial.mjs';
import { checkEntitlement } from './entitlement.mjs';
import { upsertAccountCourse } from './account-data.mjs';
import { checkAndIncrement, hourWindow } from '../rate-limit.mjs';

function acquireLock(accountId) {
  const db = openDb();
  try {
    db.prepare('INSERT INTO generation_locks (account_id, started_at) VALUES (?, ?)').run(accountId, nowIso());
    return true;
  } catch (e) {
    return false; // PRIMARY KEY 충돌 = 이미 진행 중인 생성이 있음
  }
}
function releaseLock(accountId) {
  const db = openDb();
  db.prepare('DELETE FROM generation_locks WHERE account_id = ?').run(accountId);
}

function findStoredResult(idempotencyKey) {
  const db = openDb();
  return db.prepare('SELECT account_id, result FROM generation_results WHERE idempotency_key = ?').get(idempotencyKey);
}
function storeResult(idempotencyKey, accountId, status, result) {
  const db = openDb();
  db.prepare(`
    INSERT INTO generation_results (idempotency_key, account_id, status, result, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(idempotencyKey, accountId, status, JSON.stringify(result), nowIso());
}

export async function generateCourseRoute(accountId, body) {
  body = body || {};
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!idempotencyKey) return { ok: false, status: 400, reason: 'missing-idempotency-key' };

  const existing = findStoredResult(idempotencyKey);
  if (existing) {
    if (existing.account_id !== accountId) return { ok: false, status: 409, reason: 'idempotency-key-conflict' };
    return { ok: true, status: 200, ...JSON.parse(existing.result), replay: true };
  }

  const city = String(body.city || '').trim();
  const date = String(body.date || '').trim();
  const origin = body.origin;
  const places = Array.isArray(body.places) ? body.places : [];
  if (!city || !date || !origin || typeof origin.lat !== 'number' || typeof origin.lng !== 'number') {
    return { ok: false, status: 400, reason: 'invalid-request' };
  }
  if (!places.length) return { ok: false, status: 400, reason: 'no-places' };

  if (!acquireLock(accountId)) {
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
      storeResult(idempotencyKey, accountId, 'rejected', rejected);
      return rejected;
    }

    // computeWalkingRoute(정확히는 orderByNearestNeighbor)는 좌표 유무를
    // 스스로 거르지 않는다 — 좌표 없는 곳까지 섞여 들어가면 순서·구간
    // 계산 자체가 깨진다(실제로 재현된 버그: 좌표 없는 곳이 stops에
    // legs 없이 끼어 들어갔었다). assembleCourse가 기대하는 "좌표 있는
    // 곳만"을 여기서 미리 걸러 넘긴다.
    const withCoords = places.filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number');
    const routeResult = withCoords.length ? await computeWalkingRoute(origin, withCoords) : { routedReal: false, ordered: [], legs: [] };
    const assembled = assembleCourse({
      places,
      startMinutes: body.startMinutes,
      budgetMinutes: body.budgetMinutes,
      routeResult,
    });
    if (!assembled.ok) {
      const failure = { ok: false, status: 400, reason: assembled.reason, excluded: assembled.excluded, excludedReasons: assembled.excludedReasons };
      storeResult(idempotencyKey, accountId, 'failed', failure);
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
    let trialConsumed = false;
    if (!isPaid && !trial.used && course.routedReal) {
      const consumed = consumeTrial(accountId);
      trialConsumed = !!consumed.consumed;
    }

    upsertAccountCourse(accountId, course);

    const success = { ok: true, status: 200, course, trialConsumed, plan: isPaid ? 'paid' : 'free' };
    storeResult(idempotencyKey, accountId, 'success', success);
    return success;
  } finally {
    releaseLock(accountId);
  }
}
