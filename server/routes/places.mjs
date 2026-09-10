'use strict';
/**
 * 장소 조회 프록시 — 클라이언트는 이 엔드포인트만 부른다.
 *
 * 2026-09-10 재검토(3차): "로그인 없이 호출 가능하고 사용량 제한도
 * 없다"는 지적을 반영해 (1) 인증 필수, (2) 계정별 하루 한도(초기
 * 가져오기/이후 재조회 분리 — "위치 조회 하루 30회" 같은 낮은 값은
 * 채택하지 않는다는 지시대로 기본값을 후쿠오카 160~300곳 정리를 막지
 * 않을 만큼 여유 있게 뒀다, config.mjs 참고), (3) 서비스 전체 하루
 * 차단 한도, (4) 완전히 같은 질의의 아주 짧은 중복 호출만 줄이는 캐시를
 * 추가했다.
 */
import { lookupPlace } from '../adapters/place-lookup.mjs';
import { config } from '../config.mjs';
import { openDb, nowIso } from '../db.mjs';
import { checkAndIncrement, dayWindow } from '../rate-limit.mjs';

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

/* phase: 'import'(가져오기 직후 대량 확인) | 'requery'(그 이후 개별
   재조회) — 클라이언트가 어느 맥락에서 부르는지 알려주면 서로 다른
   한도를 적용한다. 값이 없거나 모르는 값이면 더 보수적인 'requery'
   한도를 쓴다(과다 허용보다 안전한 쪽으로 기본값을 둔다). */
export async function lookupPlaceRoute(accountId, query, phase) {
  if (!accountId) return { ok: false, status: 401, reason: 'unauthorized' };
  if (!query || !String(query).trim()) return { ok: false, status: 400, reason: 'missing-query' };

  const cacheKey = String(query).trim().toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return { ok: true, status: 200, result: cached, cached: true };

  const day = dayWindow();
  const globalCheck = checkAndIncrement('lookup:global', day, config.placeLookupGlobalDailyCap);
  if (!globalCheck.allowed) return { ok: false, status: 503, reason: 'service-daily-cap-reached' };

  const normalizedPhase = phase === 'import' ? 'import' : 'requery';
  const perAccountLimit = normalizedPhase === 'import' ? config.placeLookupImportDailyLimit : config.placeLookupRequeryDailyLimit;
  const accountCheck = checkAndIncrement(`lookup:${normalizedPhase}:${accountId}`, day, perAccountLimit);
  if (!accountCheck.allowed) return { ok: false, status: 429, reason: 'account-daily-limit-reached', limit: accountCheck.limit, phase: normalizedPhase };

  const result = await lookupPlace({ query });
  cacheSet(cacheKey, result);
  return { ok: true, status: 200, result };
}
