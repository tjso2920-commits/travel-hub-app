'use strict';
/**
 * 장소 조회 프록시 — 클라이언트는 이 엔드포인트들만 부른다.
 *
 * 2026-09-10 재검토(3차): 인증 필수 + 계정별 하루 한도(초기 가져오기/
 * 재조회 분리) + 서비스 전체 하루 차단 한도 + 짧은 캐시.
 *
 * 2026-09-10 재검토(4차) — ChatGPT가 지적한 문제와 이번에 고친 것:
 * 1. **phase가 클라이언트 자기 신고였다**: 예전엔 GET 요청의 `phase`
 *    쿼리 파라미터 값을 그대로 믿고 더 큰 한도('import')를 줬다 —
 *    클라이언트가 아무 요청에나 `phase=import`를 붙이면 큰 한도를
 *    받아갈 수 있었다(실제로 클라이언트 코드는 이 값을 쓴 적도 없어서,
 *    지금까지는 반대로 모든 조회가 항상 더 보수적인 'requery' 한도만
 *    받고 있었다 — 즉 대량 초기 확인이 사실상 막혀 있었다는 뜻이기도
 *    하다). 이제 단일 조회(GET)는 **phase 값과 무관하게 항상 requery
 *    한도만** 받는다. 더 큰 한도로 가는 유일한 문은 아래 배치
 *    엔드포인트뿐이고, 그 한도는 "클라이언트가 뭐라고 부르는지"가
 *    아니라 "서버가 실제로 한 번에 처리하는 개수"로 정해진다.
 * 2. **한도 소모 순서**: 예전엔 서비스 전체 한도를 먼저 소모하고서야
 *    계정별 한도를 확인했다 — 계정 한도로 어차피 거부될 요청이 전체
 *    한도까지 갉아먹었다. 이제 **계정별 한도를 먼저 확인**하고, 통과한
 *    요청만 전체 한도를 확인·소모한다.
 * 3. **비용 원장 연동**: 캐시 적중이 아닌 실제 어댑터 호출마다
 *    cost-ledger에 예상 비용을 기록하고, 예산을 넘으면 애초에 어댑터를
 *    부르지 않는다(6-③ 지시).
 * 4. **일괄 조회**: `/api/places/lookup-batch`로 여러 장소를 한 번의
 *    클라이언트 요청으로 처리한다("장소마다 반복 설정하지 말고 묶어서
 *    처리하라"). 배치 크기 자체가 서버 설정(`placeLookupBatchMaxItemsPerCall`)
 *    으로 제한된다 — 코스 후보가 너무 많으면 그 자리에서 잘라내고
 *    "나머지는 선택을 좁혀 달라"고 정직하게 알린다.
 *
 * 2026-09-10 재검토(5차) — ChatGPT가 실제로 재현한 캐시 버그 2건을
 * 고쳤다:
 * 1. **캐시 키가 지역을 안 담았다**: 같은 질의 문자열로 지역 힌트만
 *    다르게(Tokyo → Kyoto) 조회하면, Kyoto 조회가 Tokyo 조회 결과를
 *    그대로 돌려받았다(캐시 키가 질의 문자열만 봤기 때문). 이제 캐시
 *    키에 `expectedArea`(결과에 실제 영향을 주는 조건)를 포함한다.
 * 2. **동시 요청이 외부 호출을 중복으로 냈다**: 완전히 같은 질의를
 *    동시에 두 번 보내면, 첫 번째가 아직 캐시에 결과를 쓰기 전에
 *    두 번째가 캐시를 확인해 "없음"으로 보고 자기도 외부 호출을
 *    했다(2회 발생). 이제 진행 중인 동일 조건 조회를 하나의 Promise로
 *    합쳐(in-flight 병합), 두 번째 요청은 새 호출을 만들지 않고 첫
 *    번째의 결과를 그대로 기다린다.
 * 3. **실패/unavailable 결과가 정상 결과처럼 오래 캐시됐다**: "찾지
 *    못함"(not-found)은 안정적인 답이라 캐시해도 되지만, 네트워크
 *    오류·키 미설정 같은 일시적 실패는 캐시하지 않는다(다음 요청이
 *    바로 다시 시도할 수 있어야 한다).
 */
import { lookupPlace } from '../adapters/place-lookup.mjs';
import { config } from '../config.mjs';
import { openDb, nowIso } from '../db.mjs';
import { checkAndIncrement, dayWindow } from '../rate-limit.mjs';
import { chargeCost, describeCostFailure } from '../cost-ledger.mjs';
import { reservePlaceLookupSlot, finalizePlaceLookupResult, periodCostStatus } from '../entitlement-usage.mjs';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10분 — 화면을 실수로 여러 번 눌러 생기는 중복만 줄인다. Google Places API(New)의 캐시·재사용 정책 범위 안으로 의도적으로 짧게 뒀다(RELEASE_STATUS.md 참고 — 정확한 공식 한도는 이 세션이 재확인 못함).

// 질의 문자열 자체는 같아도 지역 힌트가 다르면 결과가 달라야 한다
// (동명 장소 판별 — place-lookup.mjs의 expectedArea). 캐시 키는 반드시
// 결과에 영향을 주는 조건을 전부 포함해야 한다.
function cacheKeyFor(query, expectedArea) {
  return String(query).trim().toLowerCase() + '||area:' + String(expectedArea || '').trim().toLowerCase();
}

function cacheGet(key) {
  const db = openDb();
  const row = db.prepare('SELECT result, created_at FROM lookup_cache WHERE query_key = ?').get(key);
  if (!row) return null;
  if (Date.now() - new Date(row.created_at).getTime() > CACHE_TTL_MS) return null;
  return JSON.parse(row.result);
}
function cacheSet(key, result) {
  const db = openDb();
  db.prepare(`
    INSERT INTO lookup_cache (query_key, result, created_at) VALUES (?, ?, ?)
    ON CONFLICT(query_key) DO UPDATE SET result = excluded.result, created_at = excluded.created_at
  `).run(key, JSON.stringify(result), nowIso());
}
// 안정적인 답만 캐시한다 — "찾지 못함"은 다시 물어봐도 어차피 같은
// 결과일 가능성이 높지만, 네트워크 오류·설정 미비 같은 일시적 실패는
// 정상 결과처럼 오래 재사용하면 안 된다(다음 요청이 곧바로 다시
// 시도할 수 있어야 한다).
function shouldCache(result) {
  if (result && result.ok) return true;
  return !!(result && result.reason === 'not-found');
}

// 완전히 같은 조건(질의+지역)의 조회가 동시에 여러 번 들어오면, 실제
// 외부 호출은 하나만 나가고 나머지는 그 결과를 그대로 기다린다(동시
// 요청 중복 호출 방지). 이 맵은 프로세스 하나 안에서만 유효하다 —
// 여러 프로세스로 수평 확장하면 프로세스별로 각자 중복 제거를 한다
// (cost-ledger.mjs의 "지원 운영 구성" 설명과 같은 한계).
const inFlightLookups = new Map();

/* 계정별 한도(perScope) → 전체 한도(global) 순으로 확인한다 — 계정
   한도로 거부될 요청이 전체 한도를 갉아먹지 않게(2026-09-10 재검토
   4차 지시). 둘 다 통과했을 때만 실제로 카운트를 올린다는 게 이상적
   이지만, checkAndIncrement는 "증가와 동시에 확인"하는 원자적 헬퍼라
   순서를 바꾸는 것만으로 이 요구를 만족한다 — 계정 한도에서 먼저
   걸리면 전체 한도 쪽 checkAndIncrement 자체를 아예 안 부른다. */
function checkLimits(accountId, phaseScope, perAccountLimit, by) {
  const day = dayWindow();
  const accountCheck = checkAndIncrement(`lookup:${phaseScope}:${accountId}`, day, perAccountLimit, by);
  if (!accountCheck.allowed) return { ok: false, status: 429, reason: 'account-daily-limit-reached', limit: accountCheck.limit, phase: phaseScope };
  const globalCheck = checkAndIncrement('lookup:global', day, config.placeLookupGlobalDailyCap, by);
  if (!globalCheck.allowed) return { ok: false, status: 503, reason: 'service-daily-cap-reached' };
  return { ok: true };
}

/* 2026-09-10 재검토(6차) — "이용권 횟수와 실제 비용 원장 분리"(2절
   지시). placeId(클라이언트가 들고 있는 로컬 장소 식별자)를 이 함수까지
   반드시 넘겨야, 이 계정이 이 장소를 신규로 확인하는 건지(이용권
   차감 대상) 아니면 이미 확인된 장소를 재사용/재조회하는 건지(미차감,
   비용만 발생 가능)를 서버가 판별할 수 있다.

   2026-09-10 재검토(7차) — ChatGPT가 재현한 우회(같은 로컬 placeId에
   서로 다른 검색어를 보내 서로 다른 실제 장소 6곳을 확인받고도 사용량은
   1로만 기록됨)를 고쳤다. 예전엔 "신규 여부"를 클라이언트가 불러주는
   placeId 문자열만으로 판정했다 — 실제로 어떤 장소가 확정됐는지와
   전혀 대조하지 않았기 때문에, 같은 문자열을 계속 재사용하면서 검색
   조건만 바꾸는 것으로 무제한 우회가 가능했다.

   이제는 두 단계로 나눈다(entitlement-usage.mjs 참고):
   1) reservePlaceLookupSlot — 외부 호출 **전**. 완전히 같은 로컬
      슬롯+완전히 같은 검색 조건(cacheKeyFor로 계산한 지문)이 이미
      기록돼 있으면 그 자리에서 "신규 아님"으로 통과(진짜 반복
      재조회). 그 외엔 "신규일 수 있다"고 보고 한도부터 확인한 뒤
      잠정 예약한다.
   2) finalizePlaceLookupResult — 외부 호출 결과가 돌아온 **후**.
      실패면 잠정 예약을 되돌린다. 성공이면 공급자가 실제로 돌려준
      real_place_id를 이 계정이 이미 확인한 적 있는지 다시 확인해,
      이미 있으면(다른 로컬 id·다른 검색 조건으로 확인된 것이어도)
      잠정 예약을 되돌린다("다른 id + 같은 실제 장소"는 비과금).
      처음 보는 real_place_id면 잠정 예약을 그대로 확정한다. */
async function runOneLookup(accountId, query, expectedArea, placeId) {
  const cacheKey = cacheKeyFor(query, expectedArea);
  const reservation = reservePlaceLookupSlot(accountId, placeId, cacheKey);
  if (!reservation.ok) {
    return { ok: false, status: 402, reason: reservation.reason, used: reservation.used, limit: reservation.limit };
  }
  const finalize = (result) => finalizePlaceLookupResult(accountId, placeId, reservation, result);

  const cached = cacheGet(cacheKey);
  if (cached) {
    finalize(cached);
    return { ok: true, result: cached, cached: true };
  }

  // 이미 같은 조건으로 진행 중인 조회가 있으면 새 외부 호출을 내지
  // 않고 그 결과를 그대로 기다린다(동시 요청 중복 호출 방지 — 실제로
  // 재현된 버그의 수정).
  const existing = inFlightLookups.get(cacheKey);
  if (existing) {
    const outcome = await existing;
    finalize(outcome.ok ? outcome.result : { ok: false });
    if (!outcome.ok) return outcome; // 비용 한도 등으로 실패한 결과도 그대로 공유
    return { ok: true, result: outcome.result, cached: true, deduped: true };
  }

  const promise = (async () => {
    // 2026-09-10 재검토(5차): 실제로 외부에 나갈 요청일 때만 비용을
    // 청구한다 — services.placeLookup이 'real'이 아니면(test/unavailable)
    // lookupPlace()는 애초에 네트워크를 타지 않는다(어댑터 안에서
    // 즉시 반환). 그런데도 비용을 청구하면 "실제로 나가지도 않은
    // 호출"에 예산을 쓰는 꼴이라, routing.mjs가 실제 Google Routes
    // 호출 경로 안에서만 비용을 청구하는 것과 같은 원칙으로 맞춘다.
    if (config.services.placeLookup === 'real') {
      // 2026-09-10 재검토(6차) — 이 호출의 내부 원가를 이 계정의 지금
      // 이용권 기간(period)에 귀속시킨다(무료체험 누적 700원/유료
      // 이용권당 누적 3,500원 안전상한 — cost-ledger.mjs가 계정·전체
      // 한도와 같은 트랜잭션에서 함께 확인한다).
      const charge = chargeCost({ accountId, service: 'places', sku: 'places-text-search', periodId: reservation.period.periodId, periodCapMicros: reservation.period.costCapMicros });
      if (!charge.ok) {
        // 2026-09-10 재검토(7차) 3절 — "이용권 몫을 다 썼다"(정당한 안내)와
        // "서비스 전체가 일시적으로 바쁘다"(운영상 안내)를 구분해서
        // 클라이언트에 전달한다(예전엔 둘 다 'cost-budget-exceeded'로
        // 뭉개졌다).
        const described = describeCostFailure(charge.reason);
        return { ok: false, status: 503, reason: described.reason, detail: charge.reason };
      }
    }
    const result = await lookupPlace({ query, expectedArea });
    if (shouldCache(result)) cacheSet(cacheKey, result);
    return { ok: true, result };
  })();
  inFlightLookups.set(cacheKey, promise);
  try {
    const outcome = await promise;
    finalize(outcome.ok ? outcome.result : { ok: false });
    return outcome;
  } finally {
    inFlightLookups.delete(cacheKey);
  }
}

/* 단일 조회(GET /api/places/lookup) — phase는 항상 requery 한도만 받는다
   (위 상단 설명 1번). placeId는 이용권 차감 대상을 가리는 필수값이다
   (6차 신규 — 없으면 "이 조회가 어느 장소를 새로 확인하는 건지" 서버가
   판별할 수 없어 신규/재사용 구분 자체가 불가능해진다). */
export async function lookupPlaceRoute(accountId, query, expectedArea, placeId) {
  if (!accountId) return { ok: false, status: 401, reason: 'unauthorized' };
  if (!query || !String(query).trim()) return { ok: false, status: 400, reason: 'missing-query' };
  if (!placeId || !String(placeId).trim()) return { ok: false, status: 400, reason: 'missing-place-id' };

  const limitCheck = checkLimits(accountId, 'requery', config.placeLookupRequeryDailyLimit);
  if (!limitCheck.ok) return limitCheck;

  const r = await runOneLookup(accountId, query, expectedArea, String(placeId));
  if (!r.ok) return r;
  return { ok: true, status: 200, result: r.result, cached: r.cached };
}

/* 일괄 조회(POST /api/places/lookup-batch) — "가져오기와 유료 조회
   분리"(6-①)와 "장소마다 반복 설정 금지"(5절)를 동시에 만족한다:
   호출 자체는 클라이언트가 실제로 코스에 담은/확인하려는 장소들만
   골라 한 번에 보내는 것이라, 이 엔드포인트 존재 자체는 "가져오기
   즉시 전체 조회"를 유도하지 않는다(가져오기 화면에서는 이 엔드포인트를
   전혀 안 부른다 — src/design/spots.js 참고). 배치 크기 자체가 서버
   설정 상한이라 phase 값 조작으로 큰 한도를 받아갈 수 없다. */
export async function lookupPlacesBatchRoute(accountId, items) {
  if (!accountId) return { ok: false, status: 401, reason: 'unauthorized' };
  if (!Array.isArray(items) || !items.length) return { ok: false, status: 400, reason: 'missing-items' };

  const maxItems = config.placeLookupBatchMaxItemsPerCall;
  const overflow = items.length > maxItems;
  const toProcess = overflow ? items.slice(0, maxItems) : items;

  // 배치 일일 한도는 "호출 횟수"가 아니라 "실제로 처리하려는 개수"로
  // 센다 — 한 번에 몇 개를 묶어 보내든 실제 처리량 기준으로 공평하게
  // 소모된다.
  const limitCheck = checkLimits(accountId, 'batch', config.placeLookupBatchDailyLimit, toProcess.length);
  if (!limitCheck.ok) return limitCheck;

  const results = [];
  for (const item of toProcess) {
    const id = item && item.id;
    const query = item && item.query;
    if (!id || !query || !String(query).trim()) { results.push({ id, ok: false, reason: 'missing-query' }); continue; }
    // 배치 항목의 id가 곧 이용권 차감 판별용 placeId다(단일 조회와
    // 같은 규칙 — 6차 신규).
    const r = await runOneLookup(accountId, query, item.expectedArea, String(id));
    if (!r.ok) {
      // 예산 한도에 걸리면 이 배치의 나머지는 더 시도하지 않고 정직하게
      // "여기까지만 처리됐다"고 알린다(과도한 재시도로 상황을 더
      // 악화시키지 않는다).
      results.push({ id, ok: false, reason: r.reason });
      break;
    }
    results.push({ id, ok: true, result: r.result, cached: r.cached });
  }
  const processedIds = new Set(results.map((r) => r.id));
  const skipped = items.filter((it) => !processedIds.has(it && it.id)).map((it) => it && it.id);
  return { ok: true, status: 200, results, skipped, truncated: overflow, maxItemsPerCall: maxItems };
}
