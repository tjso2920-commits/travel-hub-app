'use strict';
/**
 * 현지 거리 · 옷차림 보기(2026-09-10 재검토 8차 4절 — "이미 요청한 거리
 * 영상 기능"의 범위 제한판). 날씨 카드 바로 아래에 버튼 하나만 붙이는
 * 무료 보조 기능이다 — 위치확인·코스생성 이용권/비용 원장과 전혀
 * 무관하다(entitlement-usage.mjs·cost-ledger.mjs를 이 파일이 아예
 * import하지 않는다).
 *
 * 지켜야 할 것들(요청 원문 그대로):
 * - 클릭했을 때만 공식 유튜브 임베드 플레이어를 불러온다(미리 로드 금지).
 * - 자동재생 금지, 패널을 닫으면 재생도 멈춰야 한다.
 * - 영상을 우리 서버에 절대 저장·중계하지 않는다(이 파일에 서버 호출이
 *   전혀 없다 — iframe이 사용자 브라우저에서 유튜브 도메인으로 바로
 *   연결된다).
 * - 목적지에 맞는, 사람이 직접 확인한 영상 목록만 쓴다(실시간 검색
 *   아님) — 화면 진입마다 검색 API를 부르지 않는다(STREET_VIDEOS는
 *   정적 표라 네트워크 호출 자체가 없다).
 * - 촬영 위치·제공 채널·현지 시각을 표시한다.
 * - "영상 시청 시 데이터가 사용돼요" 안내를 보여준다.
 * - 화면에 나오는 사람들을 "현지인"이라 단정하지 않는다 — "현지
 *   거리의 옷차림"이라고만 표현한다.
 * - 방송 종료·비공개·임베드 불가면 원본 유튜브 링크나 "이용 불가"
 *   안내로 대체한다(https://developers.google.com/youtube/iframe_api_reference
 *   의 onError 이벤트로 실제로 확인한다 — 추측하지 않는다).
 * - LIVE 상태를 우리가 먼저 단정하지 않는다(그런 배지를 아예 만들지
 *   않는다 — 유튜브 플레이어 자체가 실제 라이브면 자기 UI에 표시한다).
 * - 검증된 영상이 없는 도시는 버튼 자체를 숨긴다.
 * - 공식 플레이어의 채널 표시·컨트롤을 가리거나 숨기지 않는다.
 *
 * 공식 문서: https://developers.google.com/youtube/player_parameters
 *          https://developers.google.com/youtube/iframe_api_reference
 *
 * 2026-09-10 재검토(8차) — 명시적 제약: 이 세션에서는 실제 방송 존재·
 * 임베드 가능 여부를 검증할 방법이 없다(실시간 인터넷으로 영상을 직접
 * 보고 "사람 옷차림이 잘 보이는 각도인지" 판단할 수단이 없음). 그래서
 * 가짜 videoId를 지어내지 않고 STREET_VIDEOS를 빈 표로 남겨 둔다 —
 * 모든 도시에서 버튼이 숨겨진 채로 배포된다. 실제 서비스 전에 사람이
 * 직접 방송 상태·임베드 가능 여부·카메라 각도를 확인한 영상만 이 표에
 * 채워 넣어야 한다(docs/RELEASE_STATUS.md에 이 사실을 명시한다).
 */

// 도시명 → 검증된 영상 배열. 각 항목:
//   { videoId, title, channel, filmingLocation, tzId, sourceUrl, embeddable }
// embeddable: true(확인됨)|false(확인됨, 임베드 불가 — 원본 링크만 보여줌)
//   |undefined(아직 모름 — 실제로 임베드해 보고 onError로 판정).
// 절대 이 표에 검증 안 된 videoId를 채워 넣지 말 것.
const STREET_VIDEOS = {};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hasVideoFor(cityName) {
  const list = STREET_VIDEOS[cityName];
  return Array.isArray(list) && list.length > 0;
}

function pickVideo(cityName) {
  const list = STREET_VIDEOS[cityName];
  return (Array.isArray(list) && list[0]) || null;
}

function localTimeLabel(tzId) {
  try { return new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tzId || undefined }).format(new Date()); }
  catch (e) { return ''; }
}

/* https://developers.google.com/youtube/player_parameters — autoplay=0을
   명시해 절대 자동재생 안 함. playsinline=1은 모바일에서 인라인 재생
   (전체화면으로 강제 전환 안 함). rel=0은 재생 종료 후 관련 없는 채널의
   추천 영상을 덜 보여준다(공식 파라미터 — 채널 브랜딩·컨트롤과 무관,
   가리는 게 아니다). enablejsapi=1은 아래 IFrame Player API가 이
   iframe을 실제로 제어(onError 등)할 수 있게 한다. */
function buildEmbedUrl(videoId) {
  const params = new URLSearchParams({ autoplay: '0', playsinline: '1', rel: '0', enablejsapi: '1' });
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

function buttonHTML(cityName) {
  if (!hasVideoFor(cityName)) return '';
  return `<button class="text-button street-video-button" data-street-video-open="${esc(cityName)}">🎥 현지 거리 · 옷차림 보기</button>
    <div class="street-video-panel" id="streetVideoPanel" hidden></div>`;
}

/* onError 코드(공식 문서 기준): 2=잘못된 파라미터, 5=HTML5 플레이어
   오류, 100=영상을 찾을 수 없음(삭제·비공개), 101/150=제작자가 임베드
   재생을 허용하지 않음. 전부 "지금은 볼 수 없다"로 묶어 원본 링크로
   안내한다 — 추측으로 이유를 지어내지 않는다. */
function fallbackHTML(entry, reason) {
  const label = reason === 'not-embeddable' ? '이 영상은 우리 화면에서 바로 재생할 수 없어요.' : '지금은 이 영상을 볼 수 없어요(방송이 끝났거나 비공개로 바뀌었을 수 있어요).';
  return `<p class="weather-note">${label} 유튜브에서 직접 확인해 주세요.</p>
    <a class="street-video-original-link" href="${esc(entry.sourceUrl)}" target="_blank" rel="noopener noreferrer">유튜브에서 원본 보기 ↗</a>`;
}

function metaHTML(entry) {
  const time = localTimeLabel(entry.tzId);
  return `<p class="weather-note street-video-meta">촬영 장소: ${esc(entry.filmingLocation || '확인 안 됨')} · 제공 채널: ${esc(entry.channel || '확인 안 됨')}${time ? ` · 현지 시간 ${esc(time)}` : ''}</p>
    <p class="weather-note">영상 시청 시 데이터가 사용돼요.</p>
    <p class="weather-note street-video-disclaimer">이 영상은 현지 거리의 옷차림을 참고하기 위한 자료예요 — 화면에 나오는 사람들이 반드시 현지인이라는 뜻은 아니에요.</p>`;
}

let apiLoadPromise = null;
/* https://developers.google.com/youtube/iframe_api_reference — 클릭
   시에만(패널을 열 때만) 딱 한 번 불러온다. 이미 불러왔으면 그 Promise를
   재사용해 중복 스크립트 삽입을 막는다. */
function loadIframeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiLoadPromise) return apiLoadPromise;
  apiLoadPromise = new Promise((resolve) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === 'function') prevReady();
      resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return apiLoadPromise;
}

let activePlayer = null;

/* 패널을 열고 실제로 임베드한다 — 이 호출 자체가 "클릭했을 때만
   불러온다"는 지시의 실행 지점이다(그 전까지는 버튼만 있고 iframe도
   스크립트도 전혀 DOM에 없다). */
function openPanel(cityName) {
  const entry = pickVideo(cityName);
  const panel = document.getElementById('streetVideoPanel');
  if (!entry || !panel) return;
  if (entry.embeddable === false) {
    // 이미 확인된 임베드 불가 영상 — 시도조차 하지 않고 곧바로 원본
    // 링크로 안내한다(지어낸 재생 시도를 보여주지 않는다).
    panel.innerHTML = metaHTML(entry) + fallbackHTML(entry, 'not-embeddable');
    panel.hidden = false;
    return;
  }
  const playerId = 'streetVideoPlayerFrame';
  panel.innerHTML = `<div class="street-video-frame-wrap"><iframe id="${playerId}" src="${esc(buildEmbedUrl(entry.videoId))}" title="현지 거리 영상" allow="encrypted-media" allowfullscreen></iframe></div>
    <button class="text-button" data-street-video-close>영상 닫기</button>
    ${metaHTML(entry)}`;
  panel.hidden = false;

  loadIframeApi().then((YT) => {
    // 패널이 그 사이 닫혔으면(빠르게 닫기를 눌렀으면) 새로 만들지 않는다.
    if (!document.getElementById(playerId)) return;
    activePlayer = new YT.Player(playerId, {
      events: {
        onError: (e) => applyPlayerError(panel, entry, e && e.data),
      },
    });
  });
}

/* onError 코드를 실제 화면 대체로 옮기는 부분만 따로 뗐다 — 실제
   유튜브 네트워크 없이도(합성/모의 테스트에서) 이 함수만 직접 불러
   대체 화면이 맞게 뜨는지 검증할 수 있게 하기 위해서다. */
function applyPlayerError(panel, entry, code) {
  if (!panel) return;
  const notEmbeddable = code === 101 || code === 150;
  panel.innerHTML = metaHTML(entry) + fallbackHTML(entry, notEmbeddable ? 'not-embeddable' : 'unavailable');
}

/* 패널을 닫으면 반드시 재생이 멈춰야 한다 — iframe의 src를 비우는 것
   만으로 재생 중이던 미디어가 그 자리에서 멈춘다(플레이어 인스턴스가
   아직 준비 전이어도 항상 통한다). */
function closePanel() {
  const panel = document.getElementById('streetVideoPanel');
  if (!panel) return;
  const iframe = panel.querySelector('iframe');
  if (iframe) iframe.src = '';
  if (activePlayer && typeof activePlayer.destroy === 'function') {
    try { activePlayer.destroy(); } catch (e) { /* 이미 정리됨 */ }
  }
  activePlayer = null;
  panel.hidden = true;
  panel.innerHTML = '';
}

window.StreetVideo = {
  STREET_VIDEOS,
  hasVideoFor,
  buttonHTML,
  openPanel,
  closePanel,
  buildEmbedUrl,
  // 아래 둘은 실제 유튜브 네트워크 없이 오류 대체 화면을 검증하기
  // 위한 테스트 전용 훅이다 — 화면 코드가 직접 쓰지 않는다.
  _testHooks: { applyPlayerError, pickVideo },
};
