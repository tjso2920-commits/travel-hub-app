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
 */
import { lookupPlace } from '../adapters/place-lookup.mjs';
import { config } from '../config.mjs';
import { openDb, nowIso } from '../db.mjs';
import { checkAndIncrement, dayWindow } from '../rate-limit.mjs';
import { chargeCost } from '../cost-ledger.mjs';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10분 — 화면을 실수로 여러 번 눌러 생기는 중복만 줄인다.

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

async function runOneLookup(accountId, query, expectedArea) {
  const cacheKey = String(query).trim().toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return { ok: true, result: cached, cached: true };

  const charge = chargeCost({ accountId, service: 'places', sku: 'places-text-search' });
  if (!charge.ok) return { ok: false, status: 503, reason: 'cost-budget-exceeded', detail: charge.reason };

  const result = await lookupPlace({ query, expectedArea });
  cacheSet(cacheKey, result);
  return { ok: true, result };
}

/* 단일 조회(GET /api/places/lookup) — phase는 항상 requery 한도만 받는다
   (위 상단 설명 1번). */
export async function lookupPlaceRoute(accountId, query, expectedArea) {
  if (!accountId) return { ok: false, status: 401, reason: 'unauthorized' };
  if (!query || !String(query).trim()) return { ok: false, status: 400, reason: 'missing-query' };

  const limitCheck = checkLimits(accountId, 'requery', config.placeLookupRequeryDailyLimit);
  if (!limitCheck.ok) return limitCheck;

  const r = await runOneLookup(accountId, query, expectedArea);
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
    const r = await runOneLookup(accountId, query, item.expectedArea);
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
