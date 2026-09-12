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
 * 항목마다 네 가지를 서로 다른 필드로 분리해서 담는다(2026-09-11
 * 재검토 14차 5절 — ChatGPT 지적: 예전엔 reading 필드가 실제로는
 * 가나(일본어 읽기)인데 "한글 발음으로 변환"이라는 주석이 붙어 있어
 * 코드 주석과 실제 데이터가 서로 안 맞았고, 화면에도 가나만 보였다):
 *  - jp: 일본어 원문(한자 포함)
 *  - reading: 그 문장의 실제 가나 읽기(발음이 원문과 실제로 일치하는지
 *    항목마다 확인함)
 *  - kr: 한국어 사용자가 소리 내 읽을 수 있게 옮긴 한글 표기(발음
 *    참고용 근사치다 — 일본어의 장음·촉음 등을 한글 자모로는 완전히
 *    표현할 수 없어 정확한 발음은 아니다)
 *  - ko: 뜻(한국어 번역)
 */

// 일본 목적지에서만 노출한다(다른 나라 목적지에 일본어 기능이 섞여
// 보이면 안 된다는 지시). 2026-09-11 재검토(14차) 5절 — "가능하면
// 도시명 매칭이 아니라 국가 정보 기준으로 판단하라": city 객체에
// country 필드가 실제로 채워져 있으면(가져오기 파이프라인이 앞으로
// 국가를 채워 줄 수도 있는 자리 — import-adapter.js의 daBuildFrom의
// cities 매핑 참고) 그 값을 우선으로 쓰고, 없을 때만 기존 도시 이름
// 목록으로 대체 판단한다(도시명 목록은 여전히 import-adapter.js의
// FM_CITY_ALT와 수동 동기화가 필요하다는 한계 그대로 — RELEASE_STATUS.md
// 참고).
const JP_CITIES = new Set(['후쿠오카', '도쿄', '오사카', '교토', '삿포로', '오키나와', '나고야']);
const JP_COUNTRY_NAMES = new Set(['일본', 'japan', 'jp']);
function daIsJapanCity(cityName, countryHint) {
  const country = String(countryHint || '').trim().toLowerCase();
  if (country) return JP_COUNTRY_NAMES.has(country);
  return JP_CITIES.has(String(cityName || ''));
}

// {category, jp: 원문(한자 포함), reading: 실제 가나 읽기, kr: 한글
// 발음 표기(참고용 근사치), ko: 뜻}
// 카테고리: order(주문) pay(계산) transport(교통) lodging(숙소) reask(재질문/기타)
const PHRASEBOOK_JA = [
  { id: 'order-1', category: 'order', jp: 'これをください。', reading: 'これを ください。', kr: '코레오 쿠다사이', ko: '이거 주세요.' },
  { id: 'order-2', category: 'order', jp: 'おすすめは何ですか。', reading: 'おすすめは なんですか。', kr: '오스스메와 난데스카', ko: '추천 메뉴가 뭐예요?' },
  { id: 'order-3', category: 'order', jp: '辛くしないでください。', reading: 'からく しないでください。', kr: '카라쿠 시나이데 쿠다사이', ko: '맵지 않게 해주세요.' },
  { id: 'pay-1', category: 'pay', jp: 'お会計お願いします。', reading: 'おかいけい おねがいします。', kr: '오카이케- 오네가이시마스', ko: '계산해 주세요.' },
  { id: 'pay-2', category: 'pay', jp: 'カードは使えますか。', reading: 'カードは つかえますか。', kr: '카-도와 츠카에마스카', ko: '카드 되나요?' },
  { id: 'transport-1', category: 'transport', jp: 'この電車は空港に行きますか。', reading: 'このでんしゃは くうこうに いきますか。', kr: '코노 덴샤와 쿠-코-니 이키마스카', ko: '이 열차 공항 가나요?' },
  { id: 'transport-2', category: 'transport', jp: 'タクシーを呼んでもらえますか。', reading: 'タクシーを よんでもらえますか。', kr: '타쿠시-오 욘데모라에마스카', ko: '택시 좀 불러주실 수 있어요?' },
  { id: 'lodging-1', category: 'lodging', jp: 'チェックインをお願いします。', reading: 'チェックインを おねがいします。', kr: '첵쿠인오 오네가이시마스', ko: '체크인 할게요.' },
  { id: 'lodging-2', category: 'lodging', jp: 'Wi-Fiのパスワードを教えてください。', reading: 'ワイファイの パスワードを おしえてください。', kr: '와이파이노 파스와-도오 오시에테 쿠다사이', ko: '와이파이 비밀번호 알려주세요.' },
  { id: 'reask-1', category: 'reask', jp: 'もう一度言っていただけますか。', reading: 'もういちど いって いただけますか。', kr: '모- 이치도 잇테 이타다케마스카', ko: '다시 한 번 말씀해 주시겠어요?' },
  { id: 'reask-2', category: 'reask', jp: 'ゆっくり話していただけますか。', reading: 'ゆっくり はなして いただけますか。', kr: '육쿠리 하나시테 이타다케마스카', ko: '천천히 말씀해 주시겠어요?' },
  { id: 'reask-3', category: 'reask', jp: 'トイレはどこですか。', reading: 'トイレは どこですか。', kr: '토이레와 도코데스카', ko: '화장실이 어디예요?' },
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
  // 2026-09-11 재검토(14차) 5절 — ChatGPT가 재현한 버그: 아래 4초
  // 타이머는 원래 "일정 시간 안에 재생이 시작됐다는 신호(onstart)가
  // 전혀 안 오면 실패로 본다"는 뜻으로 만든 것인데, onstart가 실제로
  // 왔을 때 이 타이머를 꺼 두지 않아서, 4초보다 긴 문장이 멀쩡히
  // 재생되고 있어도 4초 뒤 타이머가 그대로 발화해 'error' 상태로
  // 강제 전환시켰다(가짜 speech 이벤트로 재생 중→4초 경과→error 재현
  // 확인). "재생 시작 대기"와 "실제 재생 시간"은 서로 다른 것이므로,
  // 시작 신호가 오는 순간 이 타이머를 확실히 지운다.
  let startWaitTimer = null;
  const finish = (state) => {
    if (settled || myToken !== _jpTtsToken) return;
    settled = true;
    clearTimeout(startWaitTimer);
    if (onStateChange) onStateChange(state);
  };
  u.onstart = () => { clearTimeout(startWaitTimer); if (onStateChange) onStateChange('playing'); };
  u.onend = () => finish('ended');
  u.onerror = () => finish('error');
  try {
    speechSynthesis.speak(u);
  } catch (e) {
    finish('error');
    return;
  }
  // 일부 브라우저는 음성이 아예 없으면 onerror도 안 부르고 조용히
  // 아무 일도 안 일어난다 — 재생이 "시작"조차 안 되고 일정 시간이
  // 지나면 그때만 "재생 실패"로 정직하게 알린다(무한 로딩 버튼 방지).
  // onstart가 오면 위에서 즉시 지워지므로, 이 타이머는 실제 재생
  // 길이와는 무관하다.
  startWaitTimer = setTimeout(() => { if (!settled && myToken === _jpTtsToken) finish('error'); }, 4000);
}

function daPhraseRowHTML(item) {
  return `<div class="phrase-row" data-phrase-id="${item.id}">` +
    `<div class="phrase-jp">${daEscJp(item.jp)}</div>` +
    `<div class="phrase-reading">${daEscJp(item.reading)}</div>` +
    `<div class="phrase-kr">${daEscJp(item.kr)}</div>` +
    `<div class="phrase-ko">${daEscJp(item.ko)}</div>` +
    `<button class="text-button phrase-speak-btn" data-speak="${item.id}" aria-label="${daEscJp(item.jp)} 듣기">🔊 듣기</button>` +
    `<button class="text-button phrase-large-btn" data-large="${item.id}" aria-label="${daEscJp(item.jp)} 크게 보기">🔍 크게 보기</button>` +
    `</div>`;
}
// A.esc를 그대로 쓰고 싶지만 이 파일이 import-adapter.js보다 먼저 로드될
// 수도 있어(로드 순서 방어) 최소한의 자체 이스케이프를 둔다.
function daEscJp(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 2026-09-11 재검토(14차) 5절 — "다른 문장 버튼을 누르면 이전 버튼의
// disabled/재생중 상태를 원래대로 복구해야 한다": daSpeakJa는 새 재생을
// 시작하면 이전 재생의 onStateChange를 더 이상 부르지 않는다(토큰으로
// 스스로 막음 — 여러 콜백이 뒤섞여 화면을 잘못 되돌리는 걸 막기
// 위해서다). 그래서 "이전 버튼을 원래대로 되돌리는 책임"은 재생을
// 시작하는 이 클릭 핸들러 쪽에서 직접 진다.
let _activePhraseButton = null; // { btn, original } | null
function daResetActivePhraseButton() {
  if (_activePhraseButton) {
    const { btn, original } = _activePhraseButton;
    btn.textContent = original;
    btn.disabled = false;
  }
  _activePhraseButton = null;
}

function daWirePhraseButtons(root) {
  (root || document).querySelectorAll('[data-speak]').forEach((btn) => {
    btn.onclick = () => {
      const item = PHRASEBOOK_JA.find((x) => x.id === btn.dataset.speak);
      if (!item) return;
      if (_activePhraseButton && _activePhraseButton.btn !== btn) daResetActivePhraseButton();
      const original = btn.textContent;
      _activePhraseButton = { btn, original };
      daSpeakJa(item.jp, (state) => {
        if (state === 'playing') { btn.textContent = '🔊 재생 중…'; btn.disabled = true; return; }
        if (state === 'unsupported') { btn.textContent = '이 기기는 음성 재생을 지원하지 않아요'; btn.disabled = true; setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2500); }
        else if (state === 'error') { btn.textContent = '재생 실패 · 다시 시도'; btn.disabled = false; }
        else { btn.textContent = original; btn.disabled = false; }
        if (_activePhraseButton && _activePhraseButton.btn === btn) _activePhraseButton = null;
      });
    };
  });
}

// 2026-09-11 재검토(14차) 5절 — "보여주기용으로 크게 표시하는 기능"
// (직원에게 화면을 보여줄 때 쓰는 용도). 별도 다이얼로그를 새로
// 열지 않고(이미 phrasebookSheet 자체가 다이얼로그 안에 있어 중첩
// 다이얼로그를 피한다) 화면 전체를 덮는 오버레이 하나만 재사용한다.
// 외부 스타일시트에 의존하지 않도록 필요한 스타일을 인라인으로 준다.
function daShowLargePhrase(item) {
  let overlay = document.getElementById('phraseLargeOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'phraseLargeOverlay';
    overlay.setAttribute('style', 'position:fixed;inset:0;background:rgba(20,20,20,.82);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px;box-sizing:border-box');
    overlay.onclick = (e) => { if (e.target === overlay) overlay.hidden = true; };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div style="background:#fff;border-radius:20px;padding:36px 28px;max-width:480px;width:100%;text-align:center;box-sizing:border-box">` +
    `<div style="font-size:34px;font-weight:700;line-height:1.4;word-break:keep-all">${daEscJp(item.jp)}</div>` +
    `<div style="font-size:22px;color:#555;margin-top:14px">${daEscJp(item.kr)}</div>` +
    `<div style="font-size:17px;color:#888;margin-top:10px">${daEscJp(item.ko)}</div>` +
    `<button class="primary" data-large-close style="margin-top:24px">닫기</button></div>`;
  overlay.querySelector('[data-large-close]').onclick = () => { overlay.hidden = true; };
  overlay.hidden = false;
}
function daHideLargePhrase() {
  const overlay = document.getElementById('phraseLargeOverlay');
  if (overlay) overlay.hidden = true;
}
function daWireLargePhraseButtons(root) {
  (root || document).querySelectorAll('[data-large]').forEach((btn) => {
    btn.onclick = () => {
      const item = PHRASEBOOK_JA.find((x) => x.id === btn.dataset.large);
      if (item) daShowLargePhrase(item);
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
    `<p class="inline-note">🔊 버튼은 이 기기(브라우저)의 음성 합성 기능을 쓸 뿐, 원어민 녹음이 아니에요. 일부 기기·오프라인 상태에서는 재생이 안 될 수 있어요. 🔍 버튼은 직원에게 화면을 보여줄 때 크게 띄워요.</p>` +
    `<button class="primary" data-dismiss>닫기</button></div>`);
  daWirePhraseButtons(document.getElementById('sheetContent'));
  daWireLargePhraseButtons(document.getElementById('sheetContent'));
  // 2026-09-11 재검토(14차) 5절 — "시트 닫힘/취소/오류 시 상태 정리."
  // 다이얼로그가 닫히는 경로는 여러 갈래(닫기 버튼·상단 × 버튼·배경
  // 클릭·ESC)지만 전부 네이티브 <dialog>의 close 이벤트로 모인다 —
  // 여기 한 곳만 정리하면 재생 중이던 음성이 시트를 닫아도 계속
  // 흘러나오거나, 버튼이 "재생 중…" 상태로 굳어 있는 일이 없다.
  if (typeof sheet !== 'undefined' && sheet && typeof sheet.addEventListener === 'function') {
    sheet.addEventListener('close', () => {
      try { speechSynthesis.cancel(); } catch (e) { /* 일부 환경에서 cancel 자체가 예외를 던질 수 있음 — 무시 */ }
      daResetActivePhraseButton();
      daHideLargePhrase();
    }, { once: true });
  }
}

/* 여행 도구 화면 — 지금은 일본어 회화 하나뿐이지만, 나중에 다른
   도구가 늘어날 자리를 미리 마련해 둔다(프로필 시트에서 진입). */
// 2026-09-11 재검토(14차) 5절 — "여행 도구 진입점에도 같은 일본 노출
// 게이팅을 적용하라": 장소 상세(spots.js의 detail())는 이미 그 장소의
// city로 daIsJapanCity를 확인해 "여기서 쓸 말"을 게이팅하고 있었는데,
// 이 여행 도구 목록 화면은 목적지와 무관하게 항상 버튼을 보여주고
// 있었다 — 두 진입점의 기준이 서로 달랐던 것 자체가 문제다. spots.js가
// 이 파일보다 먼저 로드되지 않을 수도 있어(로드 순서 방어) cities가
// 아직 없으면 안전하게 false로 본다.
function daAnyJapanDestination() {
  if (typeof cities === 'undefined' || !Array.isArray(cities)) return false;
  return cities.some((c) => daIsJapanCity(c.name, c.country));
}
function travelToolsSheet() {
  const showPhrasebook = daAnyJapanDestination();
  open('여행 도구', `<div class="detail"><h2>여행 도구</h2>` +
    `<p>목적지에 맞는 실전 도구를 모아 뒀어요.</p>` +
    (showPhrasebook
      ? `<button class="primary" data-tool="jp-phrasebook">🇯🇵 일본어로 한마디</button>` +
        `<p class="inline-note">일본 목적지를 저장한 장소가 있으면 장소 상세 화면에서도 "여기서 쓸 말"로 바로 열 수 있어요.</p>`
      : `<p class="inline-note">지금 저장된 목적지에 맞는 도구가 아직 없어요. 일본 목적지를 저장하면 실전 회화 도구가 여기에 나타나요.</p>`) +
    `</div>`);
  const btn = document.querySelector('[data-tool="jp-phrasebook"]');
  if (btn) btn.onclick = () => phrasebookSheet();
}
