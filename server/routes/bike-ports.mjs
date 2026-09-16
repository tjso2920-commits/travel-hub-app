'use strict';
/**
 * 자전거 공유 반납 포트 안내(차리차리 등) — 2026-09-15 신규.
 * 00_READ_FIRST_CLAUDE.md 참고: 챠리챠리 앱을 복제하지 않는다. 대여·
 * 잠금 해제·실시간 반납 상태·이용 종료 확인은 전부 공식 앱에서 한다 —
 * 여기서는 (a) 목적지 주변 반납 포트 후보(직선거리 정렬, 무료·API 0회)
 * 와 (b) 사용자가 고른 포트 하나에 대한 실제 안내(출발지→포트 자전거,
 * 포트→목적지 도보, 유료·이용권 차감)만 다룬다.
 *
 * 5절 — "포트 후보 정렬에 AI·Google Places·주소 지오코딩을 사용하지
 * 마세요. 좌표가 이미 있습니다." → nearbyBikePortsRoute는 DB에 저장된
 * 좌표로만 계산하는 순수 로컬 연산이라 비용이 전혀 들지 않는다. "모든
 * 후보의 경로를 미리 유료 계산하지 말고 선택한 포트만 계산" →
 * bikeGuideRoute만 실제 라우팅 API를 부른다. "한 번의 안내 생성은 두
 * 구간이라도 기존 생성 체계의 논리적 작업 1회로 처리" → course-
 * generation.mjs와 완전히 같은 이용권/체험 게이트(checkCourseGenerationAllowed
 * /commitCourseGenerationSuccess/consumeTrial)를 그대로 재사용한다.
 */
import { openDb, nowIso } from '../db.mjs';
import { config } from '../config.mjs';
import crypto from 'node:crypto';
import { haversineMeters, computeBikeGuideRoutes } from '../adapters/routing.mjs';
import { trialStatus, consumeTrial } from './trial.mjs';
import { checkEntitlement, checkTestAccess } from './entitlement.mjs';
import { currentPeriod, checkCourseGenerationAllowed, commitCourseGenerationSuccess } from '../entitlement-usage.mjs';
import { checkAndIncrement, hourWindow } from '../rate-limit.mjs';
import { acquireLock, releaseLock } from '../locks.mjs';
import { isRegionActive, officialMapUrlFor, activeBikeShareRegions } from '../bike-share-providers.mjs';

/* 2026-09-16 ChatGPT 재검토 5절 — "실제 스크래핑 데이터는 상업적 재사용
   조건이 확인되기 전까지 명시적으로 허용한 운영자 테스트 계정에서만
   제공하고, 일반 사용자에게는 공식 지도 링크만 제공하라. 서버에서
   제한하고 직접 API 호출로 우회 불가능하게 하라." 새 승인 플래그를
   만들지 않고, 10차 재검토가 이미 만든 계정별 test_access(관리자 승인,
   /api/admin/test-access)를 그대로 재사용한다 — "이 계정을 서버가
   테스트 대상으로 승인했는가"라는 같은 질문이기 때문이다. */
function hasRealDataAccess(accountId) {
  return !!checkTestAccess(accountId).testAccess;
}

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function isValidLatLng(p) {
  return p && isFiniteNumber(p.lat) && isFiniteNumber(p.lng) && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}

/* 지금 서버에 실제로 임포트된 지역 목록 — 클라이언트가 "이 도시에서
   자전거로 가기를 보여줄지"를 이 응답 하나로만 판정하게 한다(코드에
   도시명을 다시 하드코딩하지 않는다는 7절 지시). officialMapUrl과
   최근 임포트 시각·건수도 함께 줘서, 화면이 "데이터 기준 시각"을
   실제 값으로 보여줄 수 있게 한다. */
export function bikePortsStatusRoute(accountId) {
  const realAccess = hasRealDataAccess(accountId);
  const db = openDb();
  const regions = activeBikeShareRegions().map((r) => {
    const meta = db.prepare('SELECT source_url, retrieved_at, port_count FROM bike_share_import_meta WHERE provider_id = ? AND region_code = ?').get(r.providerId, r.regionCode);
    return {
      providerId: r.providerId,
      regionCode: r.regionCode,
      cityNames: r.cityNames,
      officialMapUrl: r.officialMapUrl,
      // 실제 임포트 건수·출처는 "실제 데이터"의 일부로 취급해 승인된
      // 테스트 계정에만 보여준다(5절) — 일반 계정도 이 지역이 언젠가
      // 지원된다는 사실(officialMapUrl)까지는 알 수 있지만, 실제로 몇
      // 곳이 들어와 있는지는 알 수 없다.
      portCount: realAccess ? (meta ? meta.port_count : 0) : 0,
      sourceUrl: realAccess ? (meta ? meta.source_url : null) : null,
      retrievedAt: realAccess ? (meta ? meta.retrieved_at : null) : null,
      realDataAccess: realAccess,
    };
  });
  return { ok: true, status: 200, regions };
}

export function nearbyBikePortsRoute(accountId, query) {
  const providerId = String((query && query.providerId) || '').trim();
  const regionCode = String((query && query.regionCode) || '').trim();
  const lat = Number(query && query.lat);
  const lng = Number(query && query.lng);
  if (!providerId || !regionCode) return { ok: false, status: 400, reason: 'missing-provider-or-region' };
  if (!isRegionActive(providerId, regionCode)) return { ok: false, status: 404, reason: 'region-not-active' };
  if (!isValidLatLng({ lat, lng })) return { ok: false, status: 400, reason: 'invalid-coords' };

  const officialMapUrl = officialMapUrlFor(providerId, regionCode);
  // 5절 — 상업적 재사용 조건이 확인되기 전까지 실제 포트 목록 자체는
  // 승인된 테스트 계정에만 보여준다. 일반 계정은 (지역이 활성이라
  // 200으로 응답하되) 빈 목록만 받는다 — 화면은 이미 "후보를 찾지
  // 못했어요 → 공식 지도에서 확인" 대체 화면을 갖고 있으므로 새 화면을
  // 만들 필요 없이 그대로 자연스럽게 그 화면으로 이어진다. 인증된 API를
  // 직접 호출해도(우회 시도) 서버가 여기서 막으므로 클라이언트를 안
  // 믿는다.
  if (!hasRealDataAccess(accountId)) {
    return { ok: true, status: 200, officialMapUrl, sourceUrl: null, sourceRetrievedAt: null, ports: [], realDataAccess: false };
  }

  const limit = Math.min(Math.max(Number.isFinite(Number(query && query.limit)) ? Number(query.limit) : 3, 1), 5);
  const db = openDb();
  const rows = db.prepare('SELECT port_id, title, address, capacity, lat, lng FROM bike_share_ports WHERE provider_id = ? AND region_code = ?').all(providerId, regionCode);
  const withDistance = rows.map((r) => ({ row: r, distanceMeters: haversineMeters({ lat, lng }, { lat: r.lat, lng: r.lng }) }));
  withDistance.sort((a, b) => a.distanceMeters - b.distanceMeters);
  const meta = db.prepare('SELECT source_url, retrieved_at FROM bike_share_import_meta WHERE provider_id = ? AND region_code = ?').get(providerId, regionCode);

  return {
    ok: true,
    status: 200,
    officialMapUrl,
    sourceUrl: meta ? meta.source_url : null,
    // 4절 — "직선거리로 표기하고 실제 최단 이동시간이라고 주장하지
    // 마세요": distanceMeters는 목적지↔포트 하버사인(직선) 거리다.
    sourceRetrievedAt: meta ? meta.retrieved_at : null,
    realDataAccess: true,
    ports: withDistance.slice(0, limit).map(({ row, distanceMeters }) => ({
      id: row.port_id,
      title: row.title,
      address: row.address,
      capacity: row.capacity,
      lat: row.lat,
      lng: row.lng,
      distanceMeters: Math.round(distanceMeters),
    })),
  };
}

function requestHash(body) {
  const material = JSON.stringify({
    providerId: body.providerId, regionCode: body.regionCode, portId: body.portId,
    origin: body.origin, destination: body.destination,
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

export async function bikeGuideRoute(accountId, body) {
  body = body || {};
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!idempotencyKey) return { ok: false, status: 400, reason: 'missing-idempotency-key' };

  const providerId = String(body.providerId || '').trim();
  const regionCode = String(body.regionCode || '').trim();
  const portId = String(body.portId || '').trim();
  const origin = body.origin;
  const destination = body.destination;
  if (!providerId || !regionCode || !portId) return { ok: false, status: 400, reason: 'invalid-request' };
  if (!isValidLatLng(origin) || !isValidLatLng(destination)) return { ok: false, status: 400, reason: 'invalid-coords' };
  if (!isRegionActive(providerId, regionCode)) return { ok: false, status: 404, reason: 'region-not-active' };
  // 5절 — "저장 결과 재조회도 같은 권한 검사 적용." 승인이 나중에
  // 거둬진 계정이 예전에 저장된 재생(replay) 결과를 통해 실제 데이터를
  // 계속 들여다볼 수 없게, 이 검사를 멱등키 조회보다 먼저 한다.
  if (!hasRealDataAccess(accountId)) {
    return { ok: false, status: 403, reason: 'real-data-access-required', officialMapUrl: officialMapUrlFor(providerId, regionCode) };
  }

  const hash = requestHash({ providerId, regionCode, portId, origin, destination });
  const existing = findStoredResult(idempotencyKey);
  if (existing) {
    if (existing.account_id !== accountId) return { ok: false, status: 409, reason: 'idempotency-key-conflict' };
    if (existing.request_hash && existing.request_hash !== hash) return { ok: false, status: 409, reason: 'idempotency-key-body-mismatch' };
    return { ok: true, status: 200, ...JSON.parse(existing.result), replay: true };
  }

  // course-generation.mjs와 같은 계정별 잠금(generation_locks)을
  // 그대로 재사용한다 — 같은 계정이 코스 생성과 포트 안내를 동시에
  // 요청해도 "동시에 두 개가 진행 중"인 상태가 안 생긴다.
  const jobId = acquireLock('generation_locks', 'account_id', accountId, config.generationLockTimeoutSeconds);
  if (!jobId) return { ok: false, status: 409, reason: 'generation-in-progress' };

  try {
    const rate = checkAndIncrement(`gen:${accountId}`, hourWindow(), config.generationRateLimitPerHour);
    if (!rate.allowed) return { ok: false, status: 429, reason: 'rate-limited', limit: rate.limit };

    const trial = trialStatus(accountId);
    const ent = checkEntitlement(accountId);
    const isPaid = ent.ok && ent.plan === 'paid';
    if (trial.used && !isPaid) {
      const rejected = { ok: false, status: 402, reason: 'payment-required', price: ent.ok ? ent.price : config.price };
      storeResult(idempotencyKey, accountId, hash, 'rejected', rejected);
      return rejected;
    }
    const period = currentPeriod(accountId);
    if (isPaid) {
      const courseCheck = checkCourseGenerationAllowed(accountId);
      if (!courseCheck.ok) {
        const rejected = { ok: false, status: 403, reason: courseCheck.reason, used: courseCheck.used, limit: courseCheck.limit };
        storeResult(idempotencyKey, accountId, hash, 'rejected', rejected);
        return rejected;
      }
    }

    const portRow = openDb().prepare('SELECT port_id, title, address, lat, lng FROM bike_share_ports WHERE provider_id = ? AND region_code = ? AND port_id = ?').get(providerId, regionCode, portId);
    if (!portRow) {
      const failure = { ok: false, status: 404, reason: 'port-not-found' };
      storeResult(idempotencyKey, accountId, hash, 'failed', failure);
      return failure;
    }
    const portCoord = { lat: portRow.lat, lng: portRow.lng };

    // 두 구간 — 출발지→포트(자전거, 미지원/실패 시 숫자 없이 대체)와
    // 포트→목적지(도보, 실패해도 정직한 추정치). 2026-09-16 ChatGPT
    // 재검토 2·3절 — "완전한 성공은 두 구간 모두 실제 경로 성공으로
    // 정의"하고, "두 구간의 전체 요청 계획을 먼저 만들고 예산을 함께
    // 검사"할 것. computeBikeGuideRoutes 하나가 이 둘을 같은 트랜잭션
    // 예산 확인으로 묶는다(server/adapters/routing.mjs 참고) — 예전엔
    // 도보 구간만으로 routedReal을 판정해, 자전거가 실패해도 이용권이
    // 차감됐다.
    const { bikeLeg, walkLeg } = await computeBikeGuideRoutes({ origin, portCoord, destination, accountId });
    const routedReal = !!(bikeLeg.routedReal && walkLeg.routedReal);

    const guide = {
      providerId, regionCode, portId,
      origin, destination,
      port: { id: portRow.port_id, title: portRow.title, address: portRow.address, lat: portRow.lat, lng: portRow.lng },
      bikeLeg: bikeLeg.routedReal
        ? { real: true, distanceMeters: Math.round(bikeLeg.distanceMeters), seconds: Math.round(bikeLeg.seconds) }
        : { real: false, reason: bikeLeg.reason },
      walkLeg: { real: walkLeg.routedReal, distanceMeters: Math.round(walkLeg.distanceMeters), seconds: Math.round(walkLeg.seconds) },
      officialMapUrl: officialMapUrlFor(providerId, regionCode),
      generatedAt: nowIso(),
    };

    const db = openDb();
    let trialConsumed = false;
    let success;
    db.exec('BEGIN');
    try {
      if (!isPaid && !trial.used && routedReal) {
        const consumed = consumeTrial(accountId);
        trialConsumed = !!consumed.consumed;
        if (trialConsumed) commitCourseGenerationSuccess(accountId, period);
      }
      if (isPaid && routedReal) commitCourseGenerationSuccess(accountId, period);
      success = { ok: true, status: 200, guide, trialConsumed, plan: isPaid ? 'paid' : 'free' };
      storeResult(idempotencyKey, accountId, hash, 'success', success);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return { ok: false, status: 500, reason: 'guide-storage-failed' };
    }
    return success;
  } finally {
    releaseLock('generation_locks', 'account_id', accountId, jobId);
  }
}
