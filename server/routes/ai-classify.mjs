'use strict';
/**
 * AI 보조 분류 배치 라우트(2026-09-11 재검토 10차 5·6절).
 *
 * 원칙(요구사항 그대로):
 * - 규칙(클라이언트의 daInfer/daInferTags)으로 해결되는 항목은 애초에
 *   이 라우트까지 오지 않는다 — 클라이언트가 "미분류로 남은 항목만"
 *   골라서 보낸다(이 라우트는 그걸 신뢰하고 별도 재확인은 안 한다 —
 *   재확인하려면 또 다른 유료 조회가 필요해질 수 있어서다).
 * - 핵심 제공량(위치확인·코스생성) 예산을 먼저 확보한 뒤 AI 여유를
 *   계산한다(entitlement-usage.mjs의 aiClassifyBudgetHeadroomMicros).
 * - 계정당 하루 배치 횟수 상한 + 배치당 최대 항목 수 상한.
 * - AI가 비활성/예산 부족/공급자 오류여도 라우트 자체는 정직한 사유로
 *   응답할 뿐 서버 오류를 던지지 않는다 — 클라이언트는 이 실패를 보고
 *   규칙 기반 결과와 수동 편집으로 계속 쓸 수 있어야 한다.
 */
import crypto from 'node:crypto';
import { config } from '../config.mjs';
import { classifyBatch } from '../adapters/ai-classify.mjs';
import { chargeCost, describeCostFailure } from '../cost-ledger.mjs';
import { currentPeriod, aiClassifyBudgetHeadroomMicros } from '../entitlement-usage.mjs';
import { checkAndIncrement, dayWindow } from '../rate-limit.mjs';
import { openDb, nowIso } from '../db.mjs';

/* 입력 최소화(2026-09-11 재검토 11차 4절) — "이름·이미 확보한 유형 등
   최소 데이터만 사용". 개인 메모(note)는 이 시점부터 기본 AI 입력에서
   완전히 뺀다 — 별도의 명시적 동의 기반 "메모 전송" 기능은 실제로
   필요해지면 따로 만들 사안이지 이 배치의 필수 항목이 아니다.
   confirmedTypes는 이미 장소조회로 확정된 유형(문자열 배열)만 받는다
   — 그 밖의 필드(연락처·정밀 GPS·계정 식별자 등)는 여기서 걸러낸다. */
function sanitizeItem(x) {
  if (!x || !x.localId) return null;
  const confirmedTypes = Array.isArray(x.confirmedTypes)
    ? x.confirmedTypes.map((t) => String(t || '').slice(0, 50)).filter(Boolean).slice(0, 10)
    : [];
  return {
    localId: String(x.localId).slice(0, 100),
    name: String(x.name || '').slice(0, 200),
    address: String(x.address || '').slice(0, 200),
    confirmedTypes,
  };
}

/* 입력 해시 — 이름/주소/확인된 유형만으로 계산한다(메모는 입력에서
   빠졌으니 해시에도 안 들어간다). course-generation.mjs의 requestHash와
   같은 방식(정렬로 순서 흔들림 제거 + sha256). */
function inputHash(item) {
  const material = JSON.stringify({
    name: item.name, address: item.address,
    confirmedTypes: [...item.confirmedTypes].sort(),
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

/* 캐시 조회/저장 — (계정, 입력해시, 분류버전) 키.
   2026-09-11 재검토(12차) — ChatGPT가 실제로 재현한 결함: 캐시 키에는
   localId가 안 들어가는데(같은 이름·주소·확인유형이면 같은 입력으로
   보고 캐시를 공유해야 하므로 의도적으로 뺐다), 캐시에 저장하는
   "결과" 객체 안에는 classifyBatch가 돌려준 원래 localId가 그대로
   들어 있었다. localId A로 분류→캐시 저장 후, 완전히 다른 장소인
   localId B가 우연히 같은 이름·주소·confirmedTypes로 요청하면, 캐시
   결과에 박혀 있던 예전 localId(A)가 그대로 응답에 실려 나가 B의
   요청인데 A의 localId가 돌아왔다 — "분류 내용 캐시"와 "요청별 장소
   식별자"가 뒤섞인 게 원인이다. 캐시에는 localId를 아예 저장하지
   않고(분류 내용만), 캐시를 읽어 쓸 때 항상 "지금 요청의 localId"로
   새로 라벨링한다 — 캐시를 없애 매번 새로 분류하는 식으로 "고치는"
   건 금지(비용이 다시 든다), 분류 버전이 바뀌면 기존 캐시는 자동으로
   안 맞아 그냥 새로 분류된다(PRIMARY KEY에 버전이 포함돼 있어서 새
   버전 행이 새로 쌓일 뿐, 별도 삭제 로직 불필요). */
function getCachedResult(db, accountId, hash, version) {
  const row = db.prepare('SELECT result FROM ai_classify_cache WHERE account_id = ? AND input_hash = ? AND classification_version = ?').get(accountId, hash, version);
  if (!row) return null;
  try { return JSON.parse(row.result); } catch { return null; }
}
function storeCachedResult(db, accountId, hash, version, result) {
  const { localId, ...content } = result; // localId는 이 입력을 처음 보낸 요청자의 것일 뿐 — 캐시 내용에는 안 남긴다.
  db.prepare('INSERT OR REPLACE INTO ai_classify_cache (account_id, input_hash, classification_version, result, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, hash, version, JSON.stringify(content), nowIso());
}

/* 2026-09-11 재검토(12차) — ChatGPT가 실제로 재현한 결함: 같은 계정·
   입력·분류버전의 캐시미스 요청 두 개를 동시에(Promise.all) 보내면,
   두 요청 모두 "캐시에 없다"고 각자 독립적으로 판단해 각자 예산을
   차감하고 각자 어댑터를 불렀다(processedCount=1씩, 비용은 2배).
   places.mjs의 inFlightLookups와 완전히 같은 패턴(동시 요청 병합)을
   여기에도 적용한다 — (계정, 입력해시, 분류버전) 키 하나당 실제
   작업은 하나의 공유 Promise로만 진행되고, 그 키를 공유하는 모든
   요청자(동시에 들어온 다른 요청이든, 한 배치 안의 중복 항목이든)는
   그 Promise를 함께 기다린 뒤 각자 자기 localId로 결과를 받는다.
   이 맵은 이 프로세스 안에서만 유효하다 — 여러 프로세스로 수평
   확장하면 프로세스별로 각자 중복 제거를 한다(inFlightLookups·
   cost-ledger.mjs의 "지원 운영 구성" 설명과 같은 한계 — "실제 운영
   프로세스 구성에 맞는 동시성 보장"이 뜻하는 바가 바로 이 한계 안에서
   실제로 동작하는 보장이다). */
const aiClassifyInFlight = new Map();

export async function classifyBatchRoute(accountId, items) {
  if (!accountId) return { ok: false, status: 401, reason: 'unauthorized' };
  const list = Array.isArray(items) ? items.map(sanitizeItem).filter(Boolean) : [];
  if (!list.length) return { ok: false, status: 400, reason: 'missing-items' };

  if (config.services.aiClassify === 'disabled') {
    // 2026-09-11 재검토(10차) — "AI 키가 없으면 실제 AI 분류는 미완료로
    // 명시하라"는 지시. 이 사유를 조용히 삼키지 않고 그대로 알려서,
    // 클라이언트가 "AI 결과 없음 = 규칙/수동 편집으로 계속"임을 정확히
    // 알 수 있게 한다.
    return { ok: false, status: 200, reason: 'ai-classify-disabled' };
  }

  const truncated = list.length > config.aiClassify.maxItemsPerBatch;
  const batch = list.slice(0, config.aiClassify.maxItemsPerBatch);
  const version = config.aiClassify.classificationVersion;

  // 캐시 분리(11차 4절) — 입력 해시+분류버전+계정 기준으로 이미 분류된
  // 항목은 AI를 다시 부르지 않고 저장된 결과를 그대로 돌려준다(재가져
  // 오기/재접속/다른 기기에서 같은 항목을 또 보내도 비용·호출이 다시
  // 들지 않는다). 한도·예산 검사는 실제로 새로 분류해야 하는 항목
  // 수만 기준으로 한다 — 캐시 적중은 "실제 AI 호출"이 아니므로 하루
  // 배치 한도·예산을 갉아먹으면 안 된다.
  const db = openDb();
  const cachedResults = [];
  const hashByLocalId = new Map();
  // 2026-09-11 재검토(12차) — "배치 내 동일 입력도 중복 제거"를 위해
  // 캐시 미스 항목을 곧바로 배열로 모으지 않고 입력해시별로 묶는다 —
  // 같은 해시를 가진 항목이 여럿이면(예: 같은 이름·주소가 우연히
  // 두 곳에 저장됨) 실제 분류는 그 해시당 딱 한 번만 하고, 결과를
  // 그 해시를 공유하는 모든 localId에 그대로 나눠 준다.
  const itemsByHash = new Map();
  const hashOrder = [];
  for (const item of batch) {
    const hash = inputHash(item);
    hashByLocalId.set(item.localId, hash);
    const cached = getCachedResult(db, accountId, hash, version);
    // 캐시된 분류 내용은 그대로 두고, localId만 지금 이 요청의 것으로
    // 붙인다 — 캐시에 다른 localId가 남아 있어도(또는 애초에 없어도)
    // 항상 현재 요청과 정확히 대응한다.
    if (cached) { cachedResults.push({ ...cached, localId: item.localId }); continue; }
    if (!itemsByHash.has(hash)) { itemsByHash.set(hash, []); hashOrder.push(hash); }
    itemsByHash.get(hash).push(item);
  }

  if (!hashOrder.length) {
    return {
      ok: true, status: 200,
      results: cachedResults,
      processedCount: 0,
      cachedCount: cachedResults.length,
      skippedForBudget: 0,
      truncatedForBatchSize: truncated,
    };
  }

  const dailyKey = `ai-classify:${accountId}`;
  const daily = checkAndIncrement(dailyKey, dayWindow(), config.aiClassify.perAccountDailyBatchLimit, 1);
  if (!daily.allowed) {
    return { ok: false, status: 429, reason: 'ai-classify-daily-batch-limit-reached' };
  }
  // 전체(서비스 전역) 한도 — 계정 한도를 이미 통과한 요청만 확인한다
  // (places.mjs checkLimits와 같은 순서: 계정에서 먼저 걸리면 전체
  // 한도 카운터 자체를 건드리지 않는다).
  const global = checkAndIncrement('ai-classify:global', dayWindow(), config.aiClassify.globalDailyBatchLimit, 1);
  if (!global.allowed) {
    return { ok: false, status: 503, reason: 'ai-classify-service-daily-cap-reached' };
  }

  // 이미 다른(동시에 들어온) 요청이 같은 (계정, 해시, 버전)을 진행
  // 중이면, 이 요청은 새로 작업을 시작하지 않고 그 공유 Promise를
  // 그대로 기다린다 — 비용도 다시 청구하지 않는다.
  // 2026-09-11 재검토(13차) — ChatGPT 재현: Promise.all([요청1(단독
  // 항목), 요청2(그 항목+다른 항목)])처럼 부분적으로 겹치는 두 동시
  // 요청을 보내면, 이전(12차) 구현은 여기서 "지금 진행 중"이라고만
  // 기록해 두고, 자기 몫(newHashes)을 처리하려고 await한 뒤에야
  // "그때 가서" 다시 aiClassifyInFlight 맵을 조회했다(아래 옛 코드
  // 참고). 그런데 그 사이 원래 진행 중이던 Promise가 이미 끝나
  // finally 블록이 맵에서 항목을 지워 버렸으면, 재조회가 undefined를
  // 얻어 그 결과를 통째로 잃었다(재현: Promise.all([classifyBatchRoute
  // (acc,[shared]), classifyBatchRoute(acc,[shared,other])]) — 두 번째
  // 요청의 shared 결과가 사라짐). 고침: "지금 진행 중"이라고 판단하는
  // 바로 이 순간 Promise 객체 자체를 붙잡아 둔다 — 맵 항목이 나중에
  // 지워져도 우리가 쥔 참조는 그대로 유효하므로, 나중에 다시 맵을
  // 조회하지 않고 이 참조를 그대로 await한다.
  const inFlightHashes = [];
  const newHashes = [];
  const capturedInFlightPromises = new Map(); // hash -> 지금 이 순간 붙잡아 둔 Promise(나중에 맵에서 지워져도 안전).
  for (const hash of hashOrder) {
    const key = `${accountId}::${hash}::${version}`;
    const existing = aiClassifyInFlight.get(key);
    if (existing) { inFlightHashes.push(hash); capturedInFlightPromises.set(hash, existing); }
    else newHashes.push(hash);
  }

  const period = currentPeriod(accountId);
  const headroom = aiClassifyBudgetHeadroomMicros(accountId, period);
  const unitMicros = config.aiClassify.placeholderPerItemMicros;
  const maxAffordableNew = Math.max(0, Math.floor(headroom.headroomMicros / unitMicros));
  if (maxAffordableNew === 0 && !inFlightHashes.length) {
    // 예산 전부가 남은 핵심 제공량(위치확인·코스생성) 몫으로 이미
    // 예약돼 있고, 마침 다른 요청이 대신 진행 중인 것도 없다 — AI는
    // 그 몫을 절대 갉아먹지 않는다.
    return { ok: false, status: 200, reason: 'ai-classify-no-budget-headroom', detail: headroom, cachedResults: cachedResults.length ? cachedResults : undefined };
  }
  const affordableNewHashes = newHashes.slice(0, maxAffordableNew);
  const skippedHashes = newHashes.slice(maxAffordableNew);

  let classifyOutcome = { ok: true, byHash: new Map() };
  if (affordableNewHashes.length) {
    // 2026-09-11 재검토(11차) — 헤드룸을 "읽기"와 실제 charge를 "쓰기"로
    // 나눠서 하던 이전 방식은, 동시에 들어온 두 AI 분류 요청이 같은
    // (스테일해질 수 있는) 헤드룸을 각자 보고 판단해 버리면 원자적
    // 트랜잭션(chargeCostBatch의 BEGIN IMMEDIATE)이 지키는 건 "원래
    // 전체 상한"뿐이라 AI 몫으로 예약된 핵심 제공량 헤드룸까지는 못
    // 지키는 문제가 있었다. periodCapMicros 자체를 "헤드룸이 반영된
    // 상한"(전체 상한 - 핵심 제공량 예약분)으로 줄여서 넘기면,
    // chargeCostBatch가 이미 갖고 있는 그 원자적 트랜잭션이 곧바로 AI
    // 헤드룸 경계까지 지켜준다(새 잠금 로직을 따로 만들 필요가 없다).
    const headroomAdjustedCapMicros = Math.max(0, headroom.capMicros - headroom.reservedForCoreMicros);
    // 2026-09-11 재검토(12차) — 비용은 "요청받은 항목 수"가 아니라
    // "실제로 새로 처리해야 하는 서로 다른 입력 수"만큼만 청구한다
    // (같은 해시를 공유하는 배치 내 중복·이미 다른 요청이 처리 중인
    // 항목은 여기서 빠진다 — "동일 작업을 합쳐 한 번만 처리" 지시).
    const charge = chargeCost({ accountId, service: 'ai-classify', sku: 'ai-classify-batch', count: affordableNewHashes.length, periodId: period.periodId, periodCapMicros: headroomAdjustedCapMicros });
    if (!charge.ok) {
      const described = describeCostFailure(charge.reason);
      return { ok: false, status: 200, reason: described.reason, detail: charge.reason, cachedResults: cachedResults.length ? cachedResults : undefined };
    }

    const representativeItems = affordableNewHashes.map((hash) => itemsByHash.get(hash)[0]);
    const promise = (async () => {
      const r = await classifyBatch(representativeItems);
      if (!r.ok) return { ok: false, reason: r.reason };
      const byHash = new Map();
      for (const res of r.results) {
        const hash = hashByLocalId.get(res.localId);
        if (!hash) continue;
        byHash.set(hash, res);
        // 성공적으로 검증된 결과만 캐시에 남긴다 — 실패·타임아웃이
        // "잘못된 성공 캐시"로 이어지면 안 된다는 지시대로, r.ok가
        // false인 경로는 이 줄 자체를 절대 안 탄다.
        storeCachedResult(db, accountId, hash, version, res);
      }
      return { ok: true, byHash };
    })();
    for (const hash of affordableNewHashes) aiClassifyInFlight.set(`${accountId}::${hash}::${version}`, promise);
    try {
      classifyOutcome = await promise;
    } finally {
      // 성공하든 실패하든 반드시 여기서 지운다 — 실패가 영구 잠금으로
      // 남아 다음 재시도까지 막으면 안 된다("실패·재시도가 영구 잠금
      // 으로 이어지지 않게" 지시).
      for (const hash of affordableNewHashes) aiClassifyInFlight.delete(`${accountId}::${hash}::${version}`);
    }
  }

  if (!classifyOutcome.ok) {
    return { ok: false, status: 200, reason: classifyOutcome.reason, cachedResults: cachedResults.length ? cachedResults : undefined };
  }

  // 이미 다른 요청이 처리 중이던 해시는 그 공유 Promise(위에서 발견한
  // 순간 붙잡아 둔 참조)가 끝나기를 기다린 뒤 같은 결과를 나눠 받는다
  // (비용은 그 다른 요청이 이미 냈다). 맵을 다시 조회하지 않는다 —
  // 그게 바로 13차에서 고친 유실 원인이었다.
  const inFlightResultsByHash = new Map();
  for (const hash of inFlightHashes) {
    const p = capturedInFlightPromises.get(hash);
    const outcome = await p;
    if (outcome.ok) {
      const res = outcome.byHash.get(hash);
      if (res) inFlightResultsByHash.set(hash, res);
    }
  }

  // 2026-09-11 재검토(13차) — "유실된 결과를 성공으로 위장하지 말 것"
  // 지시 반영. 검증 실패·부분 결과 등으로 특정 해시만 결과가 없는
  // 경우를 그냥 건너뛰지 않고 unresolvedHashes에 모아 응답에 명시
  // 항목 수로 그대로 드러낸다 — 클라이언트가 "일부 항목은 이번에
  // 처리되지 않았다"를 실제로 구분할 수 있게 한다(조용한 누락 금지).
  const newResults = [];
  let processedCount = 0;
  const unresolvedHashes = [];
  for (const hash of affordableNewHashes) {
    const res = classifyOutcome.byHash.get(hash);
    if (!res) { unresolvedHashes.push(hash); continue; }
    for (const item of itemsByHash.get(hash)) { newResults.push({ ...res, localId: item.localId }); processedCount++; }
  }
  for (const hash of inFlightHashes) {
    const res = inFlightResultsByHash.get(hash);
    if (!res) { unresolvedHashes.push(hash); continue; }
    for (const item of itemsByHash.get(hash)) { newResults.push({ ...res, localId: item.localId }); processedCount++; }
  }
  const skippedForBudget = skippedHashes.reduce((sum, hash) => sum + itemsByHash.get(hash).length, 0);
  const unresolvedCount = unresolvedHashes.reduce((sum, hash) => sum + itemsByHash.get(hash).length, 0);

  return {
    ok: true, status: 200,
    results: [...cachedResults, ...newResults],
    processedCount,
    cachedCount: cachedResults.length,
    skippedForBudget,
    unresolvedCount,
    truncatedForBatchSize: truncated,
  };
}
