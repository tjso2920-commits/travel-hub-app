'use strict';
/**
 * 2026-09-11 재검토(13차) 4절 — 실제 AI 공급자(Anthropic Claude
 * Haiku 4.5) 연결 코드의 모의 검증. **실제 API 키로 검증한 적은
 * 없다** — 여기서는 실제 fetch 대신 이 테스트가 만든 가짜 응답을
 * 주입해, mockClassifyOne을 타지 않는 실제 공급자 코드 경로(요청
 * 구성 → 응답 파싱 → 스키마 검증 → 오류 처리)가 진짜로 동작하는지
 * 확인한다. 실과금 없음(process.env.ANTHROPIC_API_KEY는 가짜 값).
 *
 * 실행: node server/test/ai-classify-real-adapter.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-key-not-real';
process.env.AI_CLASSIFY_ENABLE_REAL = 'true';

const { config } = await import('../config.mjs');
const { classifyBatch, TOP_CATEGORIES } = await import('../adapters/ai-classify.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

t('준비 확인 — 이중 게이트(키+명시적 스위치)로 real 모드가 실제로 켜짐', config.services.aiClassify === 'real');

function anthropicResponse(textContent) {
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: textContent }] }) };
}

// =====================================================================
// 1) 정상 응답 — 실제로 파싱되고 스키마 검증을 통과함.
// =====================================================================
{
  const items = [
    { localId: 'p1', name: '카페 모모', address: '서울시 강남구', confirmedTypes: [] },
    { localId: 'p2', name: '이름불명가게', address: '', confirmedTypes: [] },
  ];
  let capturedRequest = null;
  globalThis.fetch = async (url, opts) => {
    capturedRequest = { url, opts };
    return anthropicResponse(JSON.stringify([
      { localId: 'p1', category: '카페·디저트', tags: ['조용함'], evidence: '이름에 카페 포함', confidence: 'high', unresolved: false },
      { localId: 'p2', category: null, tags: [], evidence: '근거 부족', confidence: 'low', unresolved: true },
    ]));
  };
  const r = await classifyBatch(items);
  t('1) 실제 요청이 Anthropic Messages API 엔드포인트로 나감', capturedRequest.url === `${config.anthropic.apiBase}/v1/messages`);
  t('1) 실제 모델 ID(claude-haiku-4-5)로 요청함', JSON.parse(capturedRequest.opts.body).model === 'claude-haiku-4-5');
  t('1) x-api-key 헤더로 키를 보냄(URL 쿼리 등에 노출 안 함)', capturedRequest.opts.headers['x-api-key'] === config.anthropic.apiKey);
  t('1) 응답이 ok:true로 옴', r.ok === true);
  t('1) 카페 항목이 실제로 유효한 카테고리로 분류됨', r.results.find((x) => x.localId === 'p1').category === '카페·디저트');
  t('1) 근거 부족 항목은 unresolved로 정직하게 남음', r.results.find((x) => x.localId === 'p2').unresolved === true);
}

// =====================================================================
// 2) 공급자가 스키마 밖 카테고리를 지어내면(존재하지 않는 카테고리)
//    검증에서 거부되고 unresolved로 강등됨 — AI 출력을 맹신하지 않음.
// =====================================================================
{
  globalThis.fetch = async () => anthropicResponse(JSON.stringify([
    { localId: 'p3', category: '존재하지않는카테고리', tags: [], evidence: 'x', confidence: 'high', unresolved: false },
  ]));
  const r = await classifyBatch([{ localId: 'p3', name: 'x', address: '', confirmedTypes: [] }]);
  t('2) 스키마 밖 카테고리는 실제로 거부되고 unresolved로 강등됨', r.ok === true && r.results[0].unresolved === true && r.results[0].category === null);
  t('2) 카테고리 목록 자체는 세계 공통(일본 한정 아님)', !TOP_CATEGORIES.every((c) => c.includes('日')));
}

// =====================================================================
// 3) 코드블록으로 감싸서 응답해도(```json ... ```) 실제로 파싱됨.
// =====================================================================
{
  globalThis.fetch = async () => anthropicResponse('```json\n' + JSON.stringify([{ localId: 'p4', category: '기타', tags: [], evidence: 'x', confidence: 'low', unresolved: false }]) + '\n```');
  const r = await classifyBatch([{ localId: 'p4', name: 'x', address: '', confirmedTypes: [] }]);
  t('3) 코드블록으로 감싼 JSON도 실제로 파싱됨', r.ok === true && r.results[0].category === '기타');
}

// =====================================================================
// 4) 공급자 오류(네트워크 실패·비정상 상태코드·파싱불가)는 성공한
//    척하지 않고 정직하게 실패로 전달됨(지어낸 분류로 대체 안 함).
// =====================================================================
{
  globalThis.fetch = async () => { throw new Error('network down'); };
  const r1 = await classifyBatch([{ localId: 'p5', name: 'x', address: '', confirmedTypes: [] }]);
  t('4) 네트워크 오류는 정직하게 실패로 전달됨(성공 위장 없음)', r1.ok === false && r1.reason === 'ai-classify-provider-network-error');

  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const r2 = await classifyBatch([{ localId: 'p6', name: 'x', address: '', confirmedTypes: [] }]);
  t('4) 비정상 HTTP 상태코드도 정직하게 실패로 전달됨', r2.ok === false && r2.reason === 'ai-classify-provider-http-500');

  globalThis.fetch = async () => anthropicResponse('이것은 JSON이 아닙니다');
  const r3 = await classifyBatch([{ localId: 'p7', name: 'x', address: '', confirmedTypes: [] }]);
  t('4) 파싱 불가능한 응답도 정직하게 실패로 전달됨(빈 분류로 채우지 않음)', r3.ok === false && r3.reason === 'ai-classify-provider-unparseable');
}

// =====================================================================
// 5) 요청한 항목 수만큼 max_tokens가 늘어나되 상한(4096)을 넘지 않음
//    (응답 폭주로 인한 출력 비용 급증 방지 안전판이 실제로 동작).
// =====================================================================
{
  let captured;
  globalThis.fetch = async (url, opts) => { captured = JSON.parse(opts.body); return anthropicResponse('[]'); };
  const bigBatch = Array.from({ length: 40 }, (_, i) => ({ localId: 'big' + i, name: 'x' + i, address: '', confirmedTypes: [] }));
  await classifyBatch(bigBatch);
  t('5) max_tokens가 4096을 넘지 않도록 상한이 실제로 걸림', captured.max_tokens <= 4096);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
