'use strict';
/**
 * AI 보조 분류 어댑터(2026-09-11 재검토 10차 5·6절).
 *
 * **실제 AI 공급자는 아직 없다.** 이 파일은 어댑터 인터페이스와 모의
 * (mock) 계약 테스트용 구현만 담는다 — config.services.aiClassify가
 * 'real'이 되는 경로 자체가 존재하지 않는다(server/config.mjs가 항상
 * 'disabled' 또는 'mock'만 준다). 실제 공급자가 정해지면 이 파일에
 * realAdapter()를 새로 추가하고 config.mjs의 aiClassifyMode 판정을
 * 넓히면 된다 — 지금은 "새 유료 계약이나 실과금은 하지 마"라는 지시를
 * 지키기 위해 일부러 미구현 상태로 둔다.
 *
 * 입력 최소화 원칙(10차 6절, 11차 4절 강화): 이 어댑터가 받는 items는
 * 오직 {localId, name, address, confirmedTypes}뿐이다 — 개인 메모(note)
 * 는 11차부터 기본 입력에서 완전히 빠졌고, 전화번호·정밀 GPS·계정
 * 식별 정보도 절대 포함하지 않는다(호출부인 routes/ai-classify.mjs의
 * sanitizeItem이 이 필드만 추려서 넘긴다). 입력 텍스트는 어디까지나
 * "분류 대상 데이터"로만 취급되고, 그 안에 명령문처럼 보이는 문구가
 * 있어도 실행하지 않는다 — 모의 어댑터는 애초에 자유 텍스트를 해석하지
 * 않고 결정론적 해시로만 판단하므로 이 성질을 구조적으로 만족한다.
 *
 * 출력 스키마(모든 항목에 대해 검증):
 *   { localId, category: <TOP_CATEGORIES 중 하나> | null,
 *     tags: string[] (0~5개, 각 1~20자), evidence: string, confidence: 'low'|'medium'|'high' }
 * category와 tags가 둘 다 없으면(근거 부족) unresolved:true로 표시한다
 * — "의미를 알 수 없는 가게 이름만 보고 지어내지 않는다"는 원칙을
 * 검증 단계에서 강제한다.
 */
import { config } from '../config.mjs';

/* import-adapter.js의 FM_INFER 상위분류 목록과 반드시 동기화해서
   유지해야 한다(서버·클라이언트가 서로 다른 파일이라 공유 모듈로
   합치지 않는 한 수동 동기화가 필요하다 — 알려진 한계, RELEASE_STATUS.md
   에 그대로 남긴다). AI가 이 목록 밖의 카테고리를 지어내면 검증에서
   거부된다. */
export const TOP_CATEGORIES = [
  '숙소', '교통', '사우나·온천', '마사지·스파', '약국·병원', '카페·디저트',
  '바·이자카야', '관광·명소', '쇼핑', '맛집·식당', '기타',
];

function hashString(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* 모의(mock) 어댑터 — 실제 이해 없이 결정론적 해시로 "그럴듯한" 결과를
   만든다(재현 가능한 테스트를 위해서다. 실제 분류 성공률을 절대
   나타내지 않는다 — 합성 데이터 결과를 실제 평균으로 일반화하지
   말라는 지시와 정확히 같은 이유로, 이 어댑터의 결과를 실제 AI 품질의
   근거로 인용하면 안 된다). 5건 중 1건은 의도적으로 unresolved를
   돌려줘 "근거 부족은 미분류로 정직하게 남긴다" 경로도 테스트할 수
   있게 한다. */
function mockClassifyOne(item) {
  const text = `${item.name || ''} ${(item.confirmedTypes || []).join(' ')} ${item.address || ''}`;
  const h = hashString(text);
  if (!text.trim() || h % 5 === 0) {
    return { localId: item.localId, category: null, tags: [], evidence: 'insufficient-signal', confidence: 'low', unresolved: true };
  }
  const category = TOP_CATEGORIES[h % (TOP_CATEGORIES.length - 1)]; // '기타' 제외 범위에서 고름(모의 데이터가 항상 '기타'만 주면 무의미).
  return { localId: item.localId, category, tags: [], evidence: 'mock-deterministic-hash', confidence: 'medium', unresolved: false };
}

/* 출력 검증 — AI(또는 모의 어댑터)가 스키마를 벗어난 값을 주면 그
   항목만 unresolved로 강등한다(전체 배치를 실패시키지 않는다). 새
   태그 제안은 중복 정규화(trim, 길이 제한)까지 여기서 함께 확인한다. */
export function validateClassifyResult(raw, localIdSet) {
  if (!raw || typeof raw !== 'object' || !localIdSet.has(raw.localId)) return null;
  const out = { localId: raw.localId, category: null, tags: [], evidence: String(raw.evidence || '').slice(0, 200), confidence: ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'low', unresolved: true };
  if (raw.category && TOP_CATEGORIES.includes(raw.category)) { out.category = raw.category; out.unresolved = false; }
  if (Array.isArray(raw.tags)) {
    const seen = new Set();
    for (const t of raw.tags) {
      const norm = String(t || '').trim().replace(/\s+/g, ' ');
      if (!norm || norm.length > 20 || seen.has(norm.toLowerCase())) continue;
      seen.add(norm.toLowerCase());
      out.tags.push(norm);
      if (out.tags.length >= 5) break;
    }
    if (out.tags.length) out.unresolved = false;
  }
  return out;
}

/* items: [{localId, name, note, address}] — 최대
   config.aiClassify.maxItemsPerBatch개(호출부가 이미 자름). */
export async function classifyBatch(items) {
  const mode = config.services.aiClassify;
  if (mode === 'disabled') return { ok: false, reason: 'ai-classify-disabled' };
  if (mode !== 'mock') return { ok: false, reason: 'ai-classify-unavailable' };
  const list = Array.isArray(items) ? items.slice(0, config.aiClassify.maxItemsPerBatch) : [];
  if (!list.length) return { ok: true, results: [] };
  const localIdSet = new Set(list.map((x) => x.localId));
  const raw = list.map(mockClassifyOne);
  const results = raw.map((r) => validateClassifyResult(r, localIdSet)).filter(Boolean);
  return { ok: true, results, itemCount: list.length };
}
