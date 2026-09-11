'use strict';
/* 2026-09-11 재검토(13차) 5절 — 일본어 실전 회화(여기서 쓸 말).
 *
 * 배경: 기존 src/index.html(옛 디자인)의 "일본어" 탭을 실제로 열어
 * 확인한 결과, 그 안의 문장은 두 갈래였다 — ① 이자카야 스몰토크·스시
 * 장인과의 대화 같은 "친교용 잡담" 위주 고정 문장, ② 나머지 대부분은
 * 사용자가 화면을 열 때마다 Gemini에게 "DAY N용 자료를 만들어"라고
 * 요청해 그 자리에서 새로 만드는 13주치 학습 커리큘럼(코드에 그렇게
 * 명시돼 있음 — 고정된 "검토된" 문장이 아니라 매번 새로 생성됨). 둘 다
 * 이번에 요구된 "식당 주문·계산·교통·숙소·재질문" 실전 여행 회화와는
 * 목적이 다르고, ②는 애초에 "고정 검토 문장"이라고 부를 수 없는 내용
 * (지시사항의 "AI가 즉석에서 만든 문장을 고정 항목처럼 제시하지 않는다"
 * 를 그대로 어기게 된다)이라 그대로 옮기지 않았다.
 *
 * 그래서 이 파일은 요구된 다섯 상황(주문·계산·교통·숙소·재질문)에 맞는
 * 아주 작은 세트를 새로 정리했다 — 전부 일본어 교재에서 흔히 쓰이는
 * です・ます체(정중체) 표준 문형이고, 특정 지역 사투리·과도하게 캐주얼한
 * 표현은 피했다(처음 만난 상대·가게 직원에게 안전하게 쓸 수 있는 격식).
 * **원어민 감수를 받았다고 주장하지 않는다** — 이 목록은 표준 교재
 * 수준 문형을 기준으로 검토했을 뿐, 실제 원어민 검수는 별도로 필요하면
 * 그때 진행해야 한다(문서에도 동일하게 명시).
 *
 * 한글 발음은 문장의 실제 가나 읽기(reading)를 그대로 한글로 옮긴
 * 것이다 — 한자 원문과 별도로 각 항목에 실제 읽는 법(모두 가나)을
 * 같이 적어 두어, 화면에서 원문·발음·뜻을 한 번에 대조 확인할 수 있게
 * 했다(발음이 원문과 실제로 일치하는지 항목마다 확인함).
 */

// 일본 목적지에서만 노출한다(다른 나라 목적지에 일본어 기능이 섞여
// 보이면 안 된다는 지시) — import-adapter.js의 FM_CITY_ALT에 있는
// 일본 도시 이름과 반드시 같은 값으로 유지해야 한다(수동 동기화 필요 —
// 다른 파일이라 직접 참조는 못 하지만, RELEASE_STATUS.md에 이 한계를
// 남긴다).
const JP_CITIES = new Set(['후쿠오카', '도쿄', '오사카', '교토', '삿포로', '오키나와', '나고야']);
function daIsJapanCity(cityName) { return JP_CITIES.has(String(cityName || '')); }

// {category, jp: 원문(한자 포함), reading: 실제 발음(가나만), ko: 뜻}
// 카테고리: order(주문) pay(계산) transport(교통) lodging(숙소) reask(재질문/기타)
const PHRASEBOOK_JA = [
  { id: 'order-1', category: 'order', jp: 'これをください。', reading: 'これを ください。', ko: '이거 주세요.' },
  { id: 'order-2', category: 'order', jp: 'おすすめは何ですか。', reading: 'おすすめは なんですか。', ko: '추천 메뉴가 뭐예요?' },
  { id: 'order-3', category: 'order', jp: '辛くしないでください。', reading: 'からく しないでください。', ko: '맵지 않게 해주세요.' },
  { id: 'pay-1', category: 'pay', jp: 'お会計お願いします。', reading: 'おかいけい おねがいします。', ko: '계산해 주세요.' },
  { id: 'pay-2', category: 'pay', jp: 'カードは使えますか。', reading: 'カードは つかえますか。', ko: '카드 되나요?' },
  { id: 'transport-1', category: 'transport', jp: 'この電車は空港に行きますか。', reading: 'このでんしゃは くうこうに いきますか。', ko: '이 열차 공항 가나요?' },
  { id: 'transport-2', category: 'transport', jp: 'タクシーを呼んでもらえますか。', reading: 'タクシーを よんでもらえますか。', ko: '택시 좀 불러주실 수 있어요?' },
  { id: 'lodging-1', category: 'lodging', jp: 'チェックインをお願いします。', reading: 'チェックインを おねがいします。', ko: '체크인 할게요.' },
  { id: 'lodging-2', category: 'lodging', jp: 'Wi-Fiのパスワードを教えてください。', reading: 'ワイファイの パスワードを おしえてください。', ko: '와이파이 비밀번호 알려주세요.' },
  { id: 'reask-1', category: 'reask', jp: 'もう一度言っていただけますか。', reading: 'もういちど いって いただけますか。', ko: '다시 한 번 말씀해 주시겠어요?' },
  { id: 'reask-2', category: 'reask', jp: 'ゆっくり話していただけますか。', reading: 'ゆっくり はなして いただけますか。', ko: '천천히 말씀해 주시겠어요?' },
  { id: 'reask-3', category: 'reask', jp: 'トイレはどこですか。', reading: 'トイレは どこですか。', ko: '화장실이 어디예요?' },
];
const PHRASEBOOK_CATEGORY_LABEL = { order: '주문할 때', pay: '계산할 때', transport: '이동할 때', lodging: '숙소에서', reask: '다시 물을 때' };

/* ── 기기 TTS(클릭 시에만 재생) ───────────────────────────────────────
   Gemini 등 AI 음성은 쓰지 않는다(기본 문장 열람은 유료 AI 호출 0건이어야
   한다는 지시) — 브라우저 내장 SpeechSynthesis만 쓴다. 이건 기기가 갖고
   있는 합성 음성일 뿐 원어민 녹음이 아니며, 오프라인에서 항상 재생된다고
   보장하지도 않는다(기기·브라우저에 따라 음성 데이터가 온라인에서
   내려받아질 수 있음) — 화면 문구에서도 이 두 가지를 단정하지 않는다. */
let _jpTtsToken = 0;
function daSpeakJa(text, onStateChange) {
  _jpTtsToken++;
  const myToken = _jpTtsToken;
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    if (onStateChange) onStateChange('unsupported');
    return;
  }
  // 새로 누르면 이전 재생은 취소한다 — 중복 재생(동시에 여러 문장이
  // 겹쳐 들리는 상태)을 막는다.
  try { speechSynthesis.cancel(); } catch (e) { /* 일부 환경에서 cancel 자체가 예외를 던질 수 있음 — 무시하고 계속 진행 */ }
  const u = new SpeechSynthesisUtterance(String(text || ''));
  u.lang = 'ja-JP';
  u.rate = 0.95;
  try {
    const voices = speechSynthesis.getVoices ? speechSynthesis.getVoices() : [];
    const jaVoice = voices.find((v) => /^ja(?:-|_|$)/i.test(v.lang));
    if (jaVoice) u.voice = jaVoice;
  } catch (e) { /* 음성 목록을 못 가져와도 lang만으로 기본 음성이 골라질 수 있어 계속 진행 */ }
  let settled = false;
  const finish = (state) => { if (settled || myToken !== _jpTtsToken) return; settled = true; if (onStateChange) onStateChange(state); };
  u.onstart = () => { if (onStateChange) onStateChange('playing'); };
  u.onend = () => finish('ended');
  u.onerror = () => finish('error');
  try {
    speechSynthesis.speak(u);
  } catch (e) {
    finish('error');
    return;
  }
  // 일부 브라우저는 음성이 아예 없으면 onerror도 안 부르고 조용히
  // 아무 일도 안 일어난다 — 일정 시간 안에 시작 신호가 없으면
  // "재생 실패"로 정직하게 알린다(무한 로딩 버튼 방지).
  setTimeout(() => { if (!settled && myToken === _jpTtsToken) finish('error'); }, 4000);
}

function daPhraseRowHTML(item) {
  return `<div class="phrase-row" data-phrase-id="${item.id}">` +
    `<div class="phrase-jp">${daEscJp(item.jp)}</div>` +
    `<div class="phrase-reading">${daEscJp(item.reading)}</div>` +
    `<div class="phrase-ko">${daEscJp(item.ko)}</div>` +
    `<button class="text-button phrase-speak-btn" data-speak="${item.id}" aria-label="${daEscJp(item.jp)} 듣기">🔊 듣기</button>` +
    `</div>`;
}
// A.esc를 그대로 쓰고 싶지만 이 파일이 import-adapter.js보다 먼저 로드될
// 수도 있어(로드 순서 방어) 최소한의 자체 이스케이프를 둔다.
function daEscJp(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function daWirePhraseButtons(root) {
  (root || document).querySelectorAll('[data-speak]').forEach((btn) => {
    btn.onclick = () => {
      const item = PHRASEBOOK_JA.find((x) => x.id === btn.dataset.speak);
      if (!item) return;
      const original = btn.textContent;
      daSpeakJa(item.jp, (state) => {
        if (state === 'playing') { btn.textContent = '🔊 재생 중…'; btn.disabled = true; }
        else if (state === 'unsupported') { btn.textContent = '이 기기는 음성 재생을 지원하지 않아요'; btn.disabled = true; setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2500); }
        else if (state === 'error') { btn.textContent = '재생 실패 · 다시 시도'; btn.disabled = false; }
        else { btn.textContent = original; btn.disabled = false; }
      });
    };
  });
}

/* "여기서 쓸 말" — 장소 상세에서 여는 작은 시트. 카테고리 전부를
   한 번에 보여준다(문장 수 자체가 작아 화면을 따로 나눌 필요가
   없다). */
function phrasebookSheet() {
  const byCategory = new Map();
  for (const item of PHRASEBOOK_JA) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(item);
  }
  const sections = Array.from(byCategory.entries()).map(([cat, items]) =>
    `<h3 class="phrase-cat-title">${daEscJp(PHRASEBOOK_CATEGORY_LABEL[cat] || cat)}</h3>` +
    `<div class="phrase-list">${items.map(daPhraseRowHTML).join('')}</div>`,
  ).join('');
  open('여기서 쓸 말', `<div class="detail phrasebook">` +
    `<h2>일본어로 한마디</h2>` +
    `<p class="inline-note">교재 수준 정중체 문형을 기준으로 정리했어요. 원어민 감수를 받은 것은 아니라서, 정확한 뉘앙스가 중요한 상황에서는 참고용으로만 써주세요.</p>` +
    sections +
    `<p class="inline-note">🔊 버튼은 이 기기(브라우저)의 음성 합성 기능을 쓸 뿐, 원어민 녹음이 아니에요. 일부 기기·오프라인 상태에서는 재생이 안 될 수 있어요.</p>` +
    `<button class="primary" data-dismiss>닫기</button></div>`);
  daWirePhraseButtons(document.getElementById('sheetContent'));
}

/* 여행 도구 화면 — 지금은 일본어 회화 하나뿐이지만, 나중에 다른
   도구가 늘어날 자리를 미리 마련해 둔다(프로필 시트에서 진입). */
function travelToolsSheet() {
  open('여행 도구', `<div class="detail"><h2>여행 도구</h2>` +
    `<p>목적지에 맞는 실전 도구를 모아 뒀어요.</p>` +
    `<button class="primary" data-tool="jp-phrasebook">🇯🇵 일본어로 한마디</button>` +
    `<p class="inline-note">일본 목적지를 저장한 장소가 있으면 장소 상세 화면에서도 "여기서 쓸 말"로 바로 열 수 있어요.</p>` +
    `</div>`);
  const btn = document.querySelector('[data-tool="jp-phrasebook"]');
  if (btn) btn.onclick = () => phrasebookSheet();
}
