'use strict';
/**
 * 최소 제휴 준비(2026-09-11 재검토 9차 — docs/BUSINESS_DECISIONS.md
 * 7절). /api/affiliates가 이 도시에 활성 제휴가 있을 때만 배열을
 * 돌려준다 — 지금은 등록된 실제 제휴가 하나도 없어(server/affiliates.mjs
 * 의 AFFILIATE_OFFERS가 빈 배열) 항상 빈 배열이 오고, 이 섹션은
 * 화면에 전혀 나타나지 않는다(의도된 기본 상태).
 *
 * - 로그인 불필요, 이용권/비용 원장과 무관(entitlement-usage.mjs·
 *   cost-ledger.mjs를 이 파일이 아예 import하지 않는다).
 * - 새 창(target=_blank, rel=noopener noreferrer)으로만 열고, 항상
 *   "제휴 링크"라는 표시를 붙인다.
 * - 클릭 사실만 기록한다(affiliate_click) — 예약·매출이 아니다.
 * - 코스 생성 로직과 완전히 분리돼 있다(이 파일이 course-generation.js
 *   등을 전혀 참조하지 않는다 — 제휴 유무가 추천 동선에 영향을 줄
 *   방법 자체가 코드 구조상 없다).
 */
const TYPE_LABEL = { esim: 'eSIM', transit: '교통권', ticket: '입장권', lodging: '숙소' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function offerRowHTML(o) {
  const label = TYPE_LABEL[o.type] || o.type;
  return `<a class="affiliate-row" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer" data-affiliate-type="${esc(o.type)}">
    <span class="affiliate-type">${esc(label)}</span>
    <span class="affiliate-label">${esc(o.label)}</span>
    <small class="affiliate-tag">제휴 링크 ↗</small>
  </a>`;
}

function placeholderHTML(containerId) {
  return `<div class="affiliate-section" id="${esc(containerId)}" hidden></div>`;
}

// 겹치는 로드 요청 중 가장 최근 것만 반영한다(weather-card.js의
// weatherLoadSeq와 같은 원칙 — 도시를 빠르게 바꾸면 먼저 시작된 느린
// 응답이 최신 화면을 덮어쓰는 걸 막는다).
let loadSeq = 0;

/* fire-and-forget으로 호출된다(await 안 함) — 메인 화면(코스 결과)이
   이미 그려진 뒤 이 섹션만 나중에 채운다. 활성 제휴가 없으면 조용히
   숨긴 채로 둔다("곧 열립니다" 같은 자리 채우기 없음). */
async function loadAffiliateSection(A, cityName, containerId) {
  const mySeq = ++loadSeq;
  const r = await A.api(`/api/affiliates?city=${encodeURIComponent(cityName)}`);
  if (mySeq !== loadSeq) return; // 더 최근 로드가 이미 시작됨 — 이 결과는 버린다.
  const el = document.getElementById(containerId);
  if (!el) return; // 화면이 이미 닫혔으면 조용히 무시.
  const offers = (r.ok && r.json && Array.isArray(r.json.offers)) ? r.json.offers : [];
  if (!offers.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<small class="affiliate-heading">여행 준비에 도움될 만한 것들</small>${offers.map(offerRowHTML).join('')}`;
}

/* 클릭 사실만 기록한다 — 이벤트 위임으로 한 번만 붙이면 이후 로드로
   내용이 바뀌어도(innerHTML 교체) 계속 동작한다. */
function bindAffiliateClicks(containerId) {
  const el = document.getElementById(containerId);
  if (!el || el.dataset.affiliateBound) return;
  el.dataset.affiliateBound = '1';
  el.addEventListener('click', (e) => {
    const row = e.target.closest('[data-affiliate-type]');
    if (!row) return;
    if (window.Analytics) window.Analytics.track('affiliate_click', { offer_type: row.dataset.affiliateType }).catch(() => {});
  });
}

window.Affiliates = { placeholderHTML, loadAffiliateSection, bindAffiliateClicks };
