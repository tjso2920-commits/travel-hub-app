'use strict';
/**
 * 2026-09-11 재검토(10차) 5·6절 — AI_CLASSIFY_ADAPTER=mock을 켠 상태의
 * 라우트 성공 경로. 별도 파일로 분리한 이유는
 * server/test/ai-classify.test.mjs 상단 주석 참고(config.mjs가 모듈
 * 최초 로드 시 한 번만 process.env를 읽어서, "기본 비활성"과 "mock
 * 활성"을 같은 프로세스 안에서 동시에 검증할 수 없다).
 *
 * 확인 대상:
 * - mock을 켜면 실제로 분류 결과가 옴(구조 검증 — 실제 AI 품질과 무관).
 * - 그 비용이 cost_ledger에 'ai-classify' 서비스로 기록되고, 같은
 *   이용권 기간의 place-lookup 비용과 합산된 상한(periodCapMicros)을
 *   같이 쓴다(분리 집계 + 전체 합산 요구사항).
 * - 계정당 하루 배치 횟수 상한이 실제로 걸린다.
 * - 배치 크기 상한을 넘으면 잘리고, truncatedForBatchSize로 알려준다.
 *
 * 실행: node server/test/ai-classify-mock-enabled.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.AI_CLASSIFY_ADAPTER = 'mock';
process.env.AI_CLASSIFY_MAX_ITEMS_PER_BATCH = '3';
process.env.AI_CLASSIFY_PER_ACCOUNT_DAILY_BATCH_LIMIT = '2';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '10';
process.env.ENTITLEMENT_FREE_COURSE_LIMIT = '1';
process.env.COST_SAFETY_CAP_FREE_KRW_MICROS = String(700_000_000); // 700원.

const { config } = await import('../config.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { classifyBatchRoute } = await import('../routes/ai-classify.mjs');
const { periodCostMicros } = await import('../cost-ledger.mjs');
const { currentPeriod, reservePlaceLookupSlot, finalizePlaceLookupResult } = await import('../entitlement-usage.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}

t('사전 조건 — mock 어댑터가 실제로 켜짐', config.services.aiClassify === 'mock');

// =====================================================================
// 1) 정상 배치 — 규칙으로 못 정한 항목만 최소 필드로 보내면 결과가
//    옴(모의 결과이며 실제 품질 근거로 인용하면 안 된다는 점은
//    adapters/ai-classify.mjs 주석 참고).
// =====================================================================
const acc = directAccount('ai-mock-success@example.com');
const items = [
  { localId: 'p1', name: '스미비 야키토리 이자카야', note: '', address: '후쿠오카시' },
  { localId: 'p2', name: '이름만있는가게', note: '', address: '' },
];
const r1 = await classifyBatchRoute(acc, items);
t('1) mock 모드에서 실제로 성공 응답이 옴', r1.ok === true && r1.status === 200);
t('1) 결과 개수가 보낸 항목 수와 일치함', Array.isArray(r1.results) && r1.results.length === 2);
t('1) 각 결과가 원래 localId를 그대로 보존함', new Set(r1.results.map((x) => x.localId)).size === 2 && r1.results.every((x) => items.some((it) => it.localId === x.localId)));

// =====================================================================
// 2) 비용 원장 — AI 분류 비용이 실제로 기록되고, 같은 이용권 기간의
//    위치확인 비용과 "분리 집계되지만 상한은 합산"됨을 확인한다.
// =====================================================================
const period = currentPeriod(acc);
const costAfterAi = periodCostMicros(acc, period.periodId);
t('2) AI 분류 비용이 이 계정의 이용권 기간 원장에 실제로 기록됨(0보다 큼)', costAfterAi > 0);

// 같은 계정이 위치확인도 1건 성공시키면, 원장 합계가 "AI 비용 + 위치확인
// 비용"으로 늘어야 한다(서비스가 달라도 같은 period_id 아래 합산).
const reservation = reservePlaceLookupSlot(acc, 'local-x', 'query-x');
finalizePlaceLookupResult(acc, 'local-x', reservation, { ok: true, placeId: 'real-x' });
// 위치확인 자체는 test 어댑터라 실제 외부호출/과금이 없다(services.placeLookup
// !== 'real'). 그래서 여기서는 원장 합계가 "적어도 AI 비용만큼은 그대로
// 유지됨"만 확인한다(위치확인이 별도로 비용을 더하지 않는 이 test 모드
// 조건에서도 AI 비용 기록 자체는 독립적으로 살아남는지가 핵심이다).
const costAfterLookup = periodCostMicros(acc, period.periodId);
t('2) 위치확인(test 어댑터, 비용 미발생)을 더 해도 AI 비용 기록이 사라지지 않음', costAfterLookup === costAfterAi);

// =====================================================================
// 3) 계정당 하루 배치 횟수 상한 — 이번 설정은 2회. 세 번째 호출은
//    거절돼야 한다.
// =====================================================================
const accLimited = directAccount('ai-mock-daily-limit@example.com');
const call1 = await classifyBatchRoute(accLimited, [{ localId: 'x1', name: 'a' }]);
const call2 = await classifyBatchRoute(accLimited, [{ localId: 'x2', name: 'b' }]);
const call3 = await classifyBatchRoute(accLimited, [{ localId: 'x3', name: 'c' }]);
t('3) 하루 상한(2회) 안의 첫 두 번은 성공함', call1.ok === true && call2.ok === true);
t('3) 세 번째 호출은 하루 배치 상한으로 거절됨', call3.ok === false && call3.status === 429 && call3.reason === 'ai-classify-daily-batch-limit-reached');

// =====================================================================
// 4) 배치 크기 상한 — 이번 설정은 3개. 5개를 보내면 3개만 처리되고
//    truncatedForBatchSize=true로 알려준다.
// =====================================================================
const accBatch = directAccount('ai-mock-batch-size@example.com');
const fiveItems = Array.from({ length: 5 }, (_, i) => ({ localId: 'b' + i, name: '가게' + i }));
const r4 = await classifyBatchRoute(accBatch, fiveItems);
t('4) 배치 상한을 넘는 요청은 잘려서 처리됨(최대 3개)', r4.ok === true && r4.processedCount <= 3);
t('4) 잘렸다는 사실을 truncatedForBatchSize로 정직하게 알려줌', r4.truncatedForBatchSize === true);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
