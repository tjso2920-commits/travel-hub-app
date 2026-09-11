'use strict';
/**
 * 승인 디자인(spots.js) + 실데이터 통합.
 * 02_DESIGN_CONTRACT.md: "spots.js: 샘플 데이터와 UI 이벤트. 실데이터 어댑터로 대체"
 *
 * 원본과 다른 부분만 이 파일 안 주석으로 표시했다. render/toggle/open 같은
 * 이벤트 배선은 승인 원본과 동일하게 두고, 데이터가 어디서 오는지·사진이
 * 없을 때 뭘 보여줄지·지도 링크가 뭘 가리키는지만 실데이터에 맞게 바꿨다.
 */
const $ = (s) => document.querySelector(s), sheet = $('#sheet');
const A = window.DesignAdapter;

/* ── 샘플(체험용) — 승인 원본 그대로. 실제 저장 데이터와 절대 안 섞는다.
   05_IMPORT_ONBOARDING_SPEC.md: "샘플 버튼: 내 파일 없이 먼저 체험하기" */
const SAMPLE_SPOTS = [
  { id: 's1', name: '골목 안 작은 이자카야', category: '이자카야', area: '후쿠오카 · 다이묘', memo: '첫날 저녁, 카운터 자리에서', image: 'assets/izakaya.webp', city: '후쿠오카' },
  { id: 's2', name: '햇살 드는 커피 바', category: '카페', area: '후쿠오카 · 야쿠인', memo: '느긋하게 시작하는 아침', image: 'assets/cafe.webp', city: '후쿠오카' },
  { id: 's3', name: '취향을 찾는 사케 숍', category: '주판점', area: '후쿠오카 · 하카타', memo: '집에 가져갈 한 병 고르기', image: 'assets/sake.webp', city: '후쿠오카' },
];
const SAMPLE_CITIES = [{ name: '후쿠오카', label: 'FUKUOKA, JAPAN', country: '일본', count: 3 }];

/* ── 실데이터 상태 ── */
let foodMap = A.loadFoodMap();
let built = A.buildSpots(foodMap);
let spots = built.spots;
let cities = built.cities;
let usingSample = spots.length === 0; // 담아 둔 게 하나도 없으면 처음엔 샘플로 보여준다(이탈 방지)
if (usingSample) { spots = SAMPLE_SPOTS; cities = SAMPLE_CITIES; }
// 2026-09-11 재검토(10차) 7절 — 페이지를 새로고침해도(로그인 상태
// 유지) 이 계정이 서버 승인 테스트 계정인지 다시 확인한다. 백그라운드
// 호출이라 화면 렌더링을 막지 않는다 — 응답이 오기 전까지는
// A.testModeAllowed()가 false(보수적 기본값)를 준다.
if (A.sessionToken(foodMap)) A.refreshTestAccess(A.sessionToken(foodMap));

// 2026-09-11 재검토(10차) 7절 — 이번 세션에서 실제로 사용자가 허용한
// GPS 좌표(코스 출발지의 "현재 위치에서 출발" 버튼이 채운다). 세션
// 메모리에만 두고 저장소에 남기지 않는다 — 앱을 다시 열면 다시
// 물어본다(위치 권한을 앱 진입부터 강요하지 않는다는 원칙과 일관).
let _myGpsLocation = null;
// 2026-09-11 재검토(11차) 5절 — "GPS 거절 시 숙소 또는 직접 지정
// 위치를 쓸 수 있게 해." 숙소(trip.lodging)는 지금 이름 문자열만
// 저장하고 좌표가 없어(실제 위치 확인을 거친 적 없음) 그대로 기준점
// 으로 쓸 수 없다 — 대신 사용자가 직접 좌표를 입력하는 경로를 모든
// 사용자에게 연다(예전엔 테스트 계정 전용 화면에만 있었다). GPS와
// 마찬가지로 세션 메모리에만 두고 저장소·서버에는 절대 안 보낸다.
let _myManualLocation = null;
/* 거리순 정렬·코스 출발점이 전부 같은 기준을 쓰도록 하나로 모은
   공통 위치 공급 함수. 우선순위: ①서버가 승인한 테스트 계정의 테스트
   위치(개발자/검증용) ②이번 세션에 실제로 허용받은 GPS ③사용자가
   직접 입력한 좌표(GPS를 거절했을 때의 대안) ④평균 위치(자동 계산,
   사용자가 지정한 값이 아님을 항상 "평균 위치"라는 이름으로만
   부른다). 좌표를 하나도 못 구하면 null — 호출부가 "기준을 못 정함"
   으로 정직하게 표시한다.
   "내 주변 날씨"는 아직 구현되지 않았다(2026-09-11 재검토 11차 —
   "향후"라는 주석만 있던 상태를 그대로 연결 완료로 보고하지 말라는
   지시에 따라 명시적으로 남긴다). 실제로 만들 때는 이 함수를 그대로
   재사용해야 한다 — 목적지 날씨(weather-card.js)는 의도적으로 GPS를
   전혀 안 쓰는 별개 기준이니 혼동하지 않는다. */
function daLocationBasis() {
  const testLoc = A.testModeAllowed() ? A.getTestLocation() : null;
  if (testLoc) return { lat: testLoc.lat, lng: testLoc.lng, source: 'test', label: `${A.t('location.testPrefix')}(${testLoc.label})` };
  if (_myGpsLocation) return { lat: _myGpsLocation.lat, lng: _myGpsLocation.lng, source: 'gps', label: A.t('location.gps') };
  if (_myManualLocation) return { lat: _myManualLocation.lat, lng: _myManualLocation.lng, source: 'manual', label: '직접 지정 위치' };
  const avg = A.centroid(spots.filter((p) => p.city === city));
  if (avg) return { lat: avg.lat, lng: avg.lng, source: 'average', label: A.t('location.average') };
  return null;
}
/* 2026-09-11 재검토(11차) 5절 — "거리순 옆에서 '내 위치 기준'을
   선택하면 그때 GPS 권한을 요청해. 앱 시작부터 위치 팝업을 띄우지
   마." 이 함수는 사용자가 버튼을 직접 눌렀을 때만 호출된다(자동
   실행 없음). 테스트 위치가 이미 켜져 있으면 그게 우선이므로 굳이
   실제 GPS를 부르지 않는다(daLocationBasis와 같은 우선순위를 존중). */
function daRequestMyLocation() {
  if (A.testModeAllowed() && A.getTestLocation()) { daToast('테스트 위치가 켜져 있어 그 값을 그대로 씁니다.'); return; }
  if (!navigator.geolocation) { manualLocationSheet(); return; }
  daToast('위치 확인 중…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      _myGpsLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      render();
      daToast('내 위치를 기준으로 정렬했어요.');
    },
    () => { manualLocationSheet(); },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}
/* GPS를 거절했거나 지원하지 않을 때의 대안 — 좌표를 직접 입력한다
   (예: 숙소 좌표를 지도에서 확인해 붙여넣기). 서버에는 전혀 안
   보내고 이 세션(메모리)에만 둔다 — 테스트 위치와 달리 관리자 승인이
   필요 없는 일반 사용자용 대안이다. */
function manualLocationSheet() {
  open('직접 위치 입력', `<div class="detail"><h2>위치 확인을 못 받았어요</h2><p>좌표를 알고 있으면(예: 숙소 위치) 직접 입력해서 거리순 기준으로 쓸 수 있어요. 입력한 좌표는 이 기기의 지금 화면에서만 쓰이고 저장·전송되지 않아요.</p>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">위도<input class="xinput" id="manualLocLat" placeholder="예: 33.5904" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">경도<input class="xinput" id="manualLocLng" placeholder="예: 130.4207" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<button class="primary" id="manualLocApplyBtn" style="margin-top:10px">이 좌표로 적용</button><button class="text-button" data-dismiss>평균 위치로 계속 보기</button></div>`);
  $('#manualLocApplyBtn').onclick = () => {
    const lat = parseFloat($('#manualLocLat').value);
    const lng = parseFloat($('#manualLocLng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { alert('위도·경도를 숫자로 입력해 주세요.'); return; }
    _myManualLocation = { lat, lng };
    render();
    sheet.close();
    daToast('직접 입력한 위치를 기준으로 정렬했어요.');
  };
}

let city = cities[0] ? cities[0].name : '';
let filter = '전체', visitFilter = '전체', selected = new Set(), route = new Set(), selecting = false;
// 6-1절 — 정렬 방식. 위치 권한 없이도 목록이 그대로 쓰이도록 기본은
// recent(최근 추가순)다. distance는 좌표 확인된 장소들의 평균 좌표를
// "평균 위치" 기준으로 쓴다(정렬만을 위한 유료 지오코딩 호출 금지) —
// 2026-09-11 재검토(10차) 7절: 사용자가 지정한 게 아니므로 "지정 위치"
// 라고 부르지 않는다.
let sortMode = 'recent';
// 6-2절 — 세부 다중 태그 필터(상위분류 filter와 별개, AND 조건으로 겹쳐 씀).
// 지금 보유한 장소 중 실제 존재하는 태그만 칩으로 보여준다(버튼 과잉 방지).
let activeTags = new Set();
// 6-4절 — "불편함 보내기"에 같이 보낼 최소 진단정보. appBuild는 배포
// 파이프라인이 아직 없어 라운드 번호로만 최소 식별한다(정식 semver
// 아님 — 정직하게 그 정도로만 쓴다). currentScreenLabel은 open()이
// 호출될 때마다 그 시트의 제목으로 갱신된다. lastErrorCode는 지금은
// 장소 위치 확인 실패 사유 하나만 부분적으로 채운다(전체 실패 경로를
// 다 걸지는 않았다 — 이번 라운드의 의도된 최소 범위로 문서에 남긴다).
const APP_BUILD = 'r9-12';
let currentScreenLabel = '내 스팟';
let lastErrorCode = '';
function daDeviceTypeBucket() {
  const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  return 'Desktop';
}

/* 2026-09-10 재검토(7차) — "계정 전환 후 늦게 도착한 응답이 다른 계정
   화면에 섞이지 않게 하라"는 지시. 로그인·로그아웃마다 1씩 올리는
   세대(epoch) 번호를 둔다 — daSyncPush/daSyncPullAndMerge처럼 서버
   응답을 나중에 foodMap에 반영하는 비동기 함수는, 응답이 도착한
   시점의 세대가 요청을 보낼 때의 세대와 다르면(그 사이 로그아웃하고
   다른 계정으로 로그인했다는 뜻) 그 응답을 그냥 버린다 — 이미 화면에
   떠 있는 다른 계정의 데이터를 늦게 도착한 이전 계정 응답이 덮어쓰는
   사고를 막는다. */
let sessionEpoch = 0;

/* 2026-09-09 코드 검토 — 로드맵 ⑨(구매 흐름)·⑩(측정). 측정은 절대
   화면 동작을 막으면 안 된다(analytics.js가 아직 안 붙었거나 서버가
   없어도 앱은 그대로 써야 한다) — 그래서 존재 여부를 매번 확인하고
   실패를 삼킨다. window.daSessionToken은 analytics.js가 결제 결과
   이벤트에 계정을 같이 실어 보낼 때 쓴다(개인정보 아닌 내부 식별자).
   foodMap.session은 다른 저장 데이터와 같은 localStorage 키
   (foodmap_v1)에 얹는다 — 새 저장 키를 안 만든다. */
function daTrackSafe(name, props) { if (window.Analytics) window.Analytics.track(name, props).catch(() => {}); }
window.daSessionToken = () => (foodMap.session && foodMap.session.token) || null;
daTrackSafe('channel_inflow', { channel: window.Analytics ? window.Analytics.classifyChannel() : 'unknown' });

/* ── 계정별 서버 저장(로드맵 신규 — "장소 보관함과 날짜별 일정을
   계정별로 서버에 저장·복구") ─────────────────────────────────────────
   전체 치환 동기화다(diff 동기화 아님) — 이 규모(개인 저장 목록)에서는
   매번 전체를 보내도 무리가 없고, 부분 동기화의 충돌 처리 복잡도를
   피할 수 있다. id(장소)/city+date(코스) 기준으로 "이미 로컬에 있으면
   로컬을 우선하고, 로컬에 없는 서버 항목만 추가로 끌어온다"는 단순한
   규칙을 쓴다 — 로그인 직후 "이 기기에서 로그인 전에 만든 손님 데이터"
   와 "이 계정으로 다른 기기에서 이미 올려 둔 데이터"를 둘 다 잃지
   않는 가장 안전한 방향이다(복잡한 필드 단위 병합 대신, 있는 걸
   지우지 않는 쪽으로 보수적으로 합친다). */
/* 2026-09-10 재검토(6차) 3-⑤ — "여행·방문 기록은 /api/trips/sync,
   /api/visits/sync로 옮겨야 6절(R5-7)에서 구현한 충돌 보호가 실제로
   적용된다"는 지시. 예전 /api/courses 전체 치환 PUT은 tripId가 없는
   레거시 코스만 계속 담당하게 좁힌다(trip에 딸린 코스를 그 경로로도
   보내면 버전 보호 없이 통째로 덮어써져 R5-7이 막으려던 문제가 그대로
   재발한다) — tripId가 있는 코스는 /api/trips/sync의 courses 필드로만
   보낸다(trips.mjs의 syncTrips가 날짜별 upsert로 보수적으로 병합). */
/* 2026-09-10 재검토(7차) — "/api/places 전체치환으로 오래된 기기가
   최신 수정을 덮어쓰는 문제"를 실제로 고쳤다(account-data.mjs의
   syncPlaces 참고 — 버전 비교+보수적 병합, 삭제는 배열에 없다고
   추측하지 않고 foodMap.deletedPlaceIds로 명시한 것만 지운다). 그리고
   "daSyncPush가 일부 응답 실패를 확인하지 않는다"는 지적도 고쳤다 —
   이제 각 응답의 .ok를 실제로 확인해서, 실패한 것은 로컬을 덮어쓰지도
   않고(안 잃음) 성공한 것만 반영한다. 반환값(성공 여부)은 daLogout이
   "동기화가 실제로 끝났는지"를 판단하는 데 쓴다. */
let daSyncPushSeq = 0;
/* 2026-09-11 재검토(10차) — 충돌 자동 재시도 폭주 방지. 재병합해도
   다른 기기가 계속 동시에 고치는 중이면 매번 다시 충돌이 나 무한히
   즉시 재시도(setTimeout(...,0))할 수 있다. 연속 자동 재시도 횟수를
   세어 한도(3회)를 넘기면 즉시 재시도를 멈추고 다음 자연스러운
   daSyncPushSafe 호출(사용자 조작 등)을 기다린다 — 데이터는 이미
   로컬에 병합돼 안전하게 남아 있으므로 지금 당장 더 밀어붙이지 않아도
   잃을 게 없다. 성공적으로(충돌 없이) 끝난 push는 이 카운터를 0으로
   되돌린다. */
let daSyncConflictRetryCount = 0;
const DA_SYNC_CONFLICT_RETRY_LIMIT = 3;
function daScheduleConflictRetry() {
  daSyncConflictRetryCount++;
  if (daSyncConflictRetryCount > DA_SYNC_CONFLICT_RETRY_LIMIT) {
    daToast('다른 기기와 계속 동시에 저장되고 있어요. 잠시 후 다시 시도해 주세요.');
    return;
  }
  setTimeout(() => daSyncPushSafe(), 0);
}

/* 2026-09-10 재검토(8차) — 알림용 토스트. 이미 index.html에 있는
   #toast 요소(승인 디자인이 만들어 둔 것, 지금까지는 아무도 안 씀)를
   그대로 쓴다 — 새 UI 요소를 만들지 않는다. 충돌 자동 재병합처럼
   사용자가 몰라도 되지만 알면 좋은 일이 있을 때만 짧게 띄운다(막는
   확인창이 아니라 지나가는 안내 — "확인 제공"의 가벼운 형태). */
let _toastTimer = null;
function daToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* 2026-09-10 재검토(8차) — 장소 동기화 충돌(서버 기준 버전과 이 기기의
   기준 버전이 다름) 3-way 재병합. base=이 기기가 이 장소를 마지막으로
   서버와 맞췄을 때의 내용, mine=지금 이 기기의 로컬 내용,
   theirs=서버가 돌려준 지금 값. 규칙: 내가 실제로 고친 필드는 절대
   잃지 않는다(같은 필드를 서버 쪽도 고쳤어도 내 값을 지킨다) — 내가
   안 건드린 필드는 서버의 최신 값을 그대로 받아들인다. 이렇게 하면
   "서버 데이터와 내 미저장 수정 둘 다 보존"이 대부분의 실제 상황
   (서로 다른 필드를 고침)에서 정확히 맞아떨어지고, 정말 같은 필드를
   양쪽이 고친 드문 경우에도 최소한 내 수정이 조용히 사라지진 않는다. */
/* 2026-09-11 재검토(9차) — ChatGPT가 실제 코드로 재현한 두 가지 결함을
   고쳤다.
   (재현 B-1) 기준(base)을 모를 때 예전엔 {...theirs}만 반환해 아직
   서버에 한 번도 안 보낸 로컬 미저장 값을 통째로 지웠다. 이제
   base가 없으면 "mine이 실제로 뭘 고쳤는지" 판별할 방법이 없다고
   보고, 모든 필드를 "건드렸을 수 있다"고 안전하게 가정해 mine 값을
   지킨다(서버 값을 잃는 대신, 우연히 같은 값인 필드만 충돌 아님으로
   건너뛴다).
   (재현 B-2) 정확히 같은 필드를 양쪽이 서로 다르게 고친 진짜 충돌일
   때, 예전엔 mine만 채택하고 theirs 쪽 값은 완전히 사라졌다(다음
   자동 저장으로 덮여 "서버 값도 보존"이라는 보고와 달랐다). 이제
   mine 값을 지키되(조용히 사라지지 않게) theirs 값도
   `_fieldConflicts`에 나란히 남겨 둔다 — 사용자가 장소 상세에서
   "다른 기기 값 쓰기"를 눌러 직접 한 번 풀 수 있게(반복 확인창이
   아니라 상세 화면의 조용한 안내 + 버튼 하나). 이 값은 다음에 이
   병합 결과가 실제로 성공 저장되는 순간(성공 경로는 serverPlace를
   그대로 쓰므로 이 필드가 없다) 자연히 사라진다 — 별도 정리 로직이
   필요 없다. */
/* 2026-09-11 재검토(10차) — courses/trips 충돌도 같은 3-way 재병합이
   필요하다는 지적(ChatGPT 재현: SERVER-NEW가 버전만 바뀐 재제출에
   덮여 사라짐)에 따라, places 전용이던 로직을 "정체성 필드(식별자)
   목록"만 다르게 받는 범용 함수로 뽑아낸다. places는 base(기준
   스냅샷)를 추적하지만 courses/trips는 아직 그런 추적이 없다 — base가
   없을 때의 동작(모든 필드를 "내가 건드렸을 수 있다"로 보고, 서로
   다르면 병합 + 충돌 기록)은 그대로 재사용된다. */
/* 2026-09-11 재검토(11차) — ChatGPT가 실제로 재현한 필드 삭제 부활
   버그: base={note:old}, mine={}(note를 지움), theirs={note:old,
   version:2}를 넣으면 note=old가 되살아났다. 원인은 Object.keys(mine)
   만 훑었기 때문 — mine에서 지운 필드는 애초에 이 반복문에 안
   들어오고, merged는 {...theirs}로 시작하므로 그 필드가 조용히
   theirs 값 그대로 남았다. 이제는 mine과 base의 키를 합쳐서 훑어
   "mine에는 없는데 base에는 있던 키"(=mine이 명시적으로 지운 필드)도
   놓치지 않는다 — theirs가 그 사이 안 건드렸으면(또는 theirs도
   지웠으면) 삭제를 그대로 반영하고, theirs가 그 필드를 고쳤으면
   (지움 vs 수정의 진짜 충돌) 삭제를 우선 반영하되 theirs 값을
   _fieldConflicts에 남겨 되살릴 수 있게 한다. */
function daRemergeGenericConflict(mine, base, theirs, identityKeys) {
  if (!mine) return { ...theirs };
  const merged = { ...theirs };
  const fieldConflicts = {};
  const skipKeys = new Set([...identityKeys, 'version', 'updatedAt', '_fieldConflicts']);
  const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // base가 있으면 mine과 base 양쪽 키를 모두 훑는다(삭제 판정에 필요).
  // base가 없으면 예전과 동일하게 mine의 키만 훑는다 — 기준 스냅샷이
  // 없을 때는 "원래 없던 필드"와 "지운 필드"를 구분할 방법이 없다.
  const keys = base ? new Set([...Object.keys(mine), ...Object.keys(base)]) : new Set(Object.keys(mine));
  for (const key of keys) {
    if (skipKeys.has(key)) continue;
    const minePresent = has(mine, key);
    const mineVal = mine[key];
    if (!base) {
      if (!minePresent) continue;
      if (has(theirs, key) && eq(mineVal, theirs[key])) continue; // 우연히 같은 값 — 충돌 아님.
      merged[key] = mineVal; // 내가 고쳤을 수 있는 값은 조용히 사라지지 않는다.
      if (has(theirs, key)) fieldConflicts[key] = { mine: mineVal, theirs: theirs[key] };
      continue;
    }
    const basePresent = has(base, key);
    const baseVal = base[key];
    // mine이 지웠으면(base엔 있었는데 mine엔 없음) 명백한 변경으로 본다.
    const mineChanged = minePresent ? (!basePresent || !eq(mineVal, baseVal)) : basePresent;
    if (!mineChanged) continue; // 안 건드림 — 서버 값(merged엔 이미 theirs) 그대로.
    const theirsPresent = has(theirs, key);
    const theirsVal = theirs[key];
    const theirsChanged = theirsPresent ? (!basePresent || !eq(theirsVal, baseVal)) : basePresent;
    if (!minePresent) {
      // mine이 지운 필드 — theirs가 그 사이 안 건드렸거나 마찬가지로
      // 지웠으면 조용히 지운다. theirs가 그 사이 값을 실제로 고쳤으면
      // "지움 vs 수정"의 진짜 충돌이므로 삭제를 우선 반영하되(mine
      // 우선 원칙 유지) theirs 값을 _fieldConflicts에 남겨 되살릴 수
      // 있게 한다.
      delete merged[key];
      if (theirsChanged && theirsPresent) fieldConflicts[key] = { mine: undefined, theirs: theirsVal };
      continue;
    }
    if (theirsPresent && eq(mineVal, theirsVal)) continue; // 우연히 같은 값 — 충돌 아님.
    merged[key] = mineVal; // 내가 고쳤을 수 있는 값은 조용히 사라지지 않는다.
    if (theirsChanged) fieldConflicts[key] = { mine: mineVal, theirs: theirsPresent ? theirsVal : undefined };
  }
  for (const key of identityKeys) merged[key] = mine[key];
  merged.version = theirs.version; // 다음 시도의 기준 버전 — 서버가 방금 알려준 값.
  merged.updatedAt = new Date().toISOString();
  if (Object.keys(fieldConflicts).length) merged._fieldConflicts = fieldConflicts;
  return merged;
}
function daRemergePlaceConflict(mine, base, theirs) {
  return daRemergeGenericConflict(mine, base, theirs, ['id']);
}
/* 2026-09-11 재검토(11차) — "장소에만 해결 버튼이 있는 상태로 완료
   처리하지 마"라는 지시에 따라 places 전용이던 필드 충돌 안내를
   courses/trips에도 재사용할 수 있게 공통 렌더러로 뽑는다. mine이
   삭제한 필드(theirs만 값이 있고 mine은 undefined)도 "(삭제됨)"으로
   정직하게 보여준다(문자열 "undefined"를 그대로 보여주지 않는다). */
const DA_FIELD_CONFLICT_LABELS = { note: '메모', cat: '유형', city: '도시', name: '이름', address: '주소', startDate: '시작일', endDate: '종료일', lodging: '숙소', memo: '메모' };
function daFieldConflictBlockHTML(conflicts, resolveAttrName, idForAttr) {
  if (!conflicts || !Object.keys(conflicts).length) return '';
  const fmt = (v) => (v === undefined ? '(삭제됨)' : A.esc(String(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)));
  return Object.entries(conflicts).map(([key, v]) => {
    const label = DA_FIELD_CONFLICT_LABELS[key] || key;
    return `<div class="inline-note">${A.esc(label)}이(가) 다른 기기와 다르게 저장돼 있어요 — 지금은 내 값을 유지 중이에요.<br>` +
      `내 값: “${fmt(v.mine)}” · 다른 기기 값: “${fmt(v.theirs)}”<br>` +
      `<button class="text-button" data-${resolveAttrName}="${A.esc(idForAttr)}|${A.esc(key)}">다른 기기 값으로 바꾸기</button></div>`;
  }).join('');
}

async function daSyncPush(token) {
  if (!token) return { placesOk: true, coursesOk: true, tripsOk: true, visitsOk: true, tagsOk: true, allOk: true, hasUnresolvedConflicts: false, fullySynced: true };
  const epochAtStart = sessionEpoch;
  // 2026-09-10 재검토(7차) — daSyncPushSafe는 로컬이 바뀔 때마다 fire-
  // and-forget으로 겹쳐 불릴 수 있다(예: 방문 표시 직후 + 곧이어 여행
  // 만들기). 두 호출이 동시에 나가면 응답이 요청 순서와 다르게 돌아올
  // 수 있어, 먼저 시작한(하지만 나중에 응답이 온) 낡은 호출이 그 사이
  // 이미 최신 상태를 반영한 나중 호출의 결과를 덮어쓸 수 있다. 매
  // 호출마다 일련번호를 매겨, 이 호출이 시작된 뒤 더 새 호출이
  // 시작됐으면(mySeq가 더 이상 최신이 아니면) 이 응답은 적용하지 않고
  // 버린다 — 항상 "가장 나중에 시작한 요청"의 결과만 신뢰한다.
  const mySeq = ++daSyncPushSeq;
  const tripsPayload = (foodMap.trips || []).map((t) => ({
    ...t, courses: (foodMap.courses || []).filter((c) => c.tripId === t.tripId),
  }));
  const pendingDeleted = (foodMap.deletedPlaceIds || []).slice(); // [{id, baseVersion}]
  // 2026-09-10 재검토(8차) — "저장 중 추가 수정" 보호: 이 요청을 보내는
  // 바로 이 순간의 장소 내용을 스냅샷으로 고정해 둔다. await 하는 동안
  // (네트워크 왕복) 사용자가 같은 장소를 또 고치면, 응답이 왔을 때
  // "그 사이 내가 또 뭘 바꿨는지"를 이 스냅샷과 비교해 알아낼 수 있다
  // — 그렇게 하지 않으면 서버 응답으로 통째로 덮어쓸 때 이 요청이
  // 나간 "이후"에 생긴 새 로컬 수정을 조용히 잃어버린다.
  const outgoingPlaces = (foodMap.places || []).map((p) => ({ ...p }));
  const requestSnapshot = new Map(outgoingPlaces.map((p) => [p.id, A.placeContentKey(p)]));
  // 2026-09-11 재검토(11차) — 태그 레지스트리(사용자가 만든 태그 +
  // 기본 태그 표시명 override)도 계정별로 서버에 동기화한다. 저장
  // 중에 새로 만든 태그가 사라지지 않게(장소와 같은 이유) 요청 스냅샷을
  // 남긴다.
  const outgoingTags = (A.rawCustomTags || []).map((tg) => ({ ...tg }));
  const pendingDeletedTags = (A.deletedTagIds || []).slice();
  const tagRequestSnapshot = new Set(outgoingTags.map((tg) => tg.id));
  const [placesRes, coursesRes, tripsRes, visitsRes, tagsRes] = await Promise.all([
    A.api('/api/places', { method: 'PUT', token, body: { places: outgoingPlaces, deletedIds: pendingDeleted } }),
    A.api('/api/courses', { method: 'PUT', token, body: { courses: (foodMap.courses || []).filter((c) => !c.tripId) } }),
    A.api('/api/trips/sync', { method: 'POST', token, body: { trips: tripsPayload } }),
    A.api('/api/visits/sync', { method: 'POST', token, body: { visits: foodMap.visits || [] } }),
    A.api('/api/tags', { method: 'PUT', token, body: { tags: outgoingTags, deletedIds: pendingDeletedTags } }),
  ]);
  // 응답이 오는 사이 로그아웃하고 다른 계정으로 로그인했으면(세대가
  // 바뀌었으면) 지금 이 응답을 화면에 반영하지 않는다 — 다른 계정의
  // 데이터를 이전 계정의 늦은 응답이 덮어쓰는 사고를 막는다.
  if (sessionEpoch !== epochAtStart) return { placesOk: false, coursesOk: false, tripsOk: false, visitsOk: false, tagsOk: false, allOk: false, stale: true };
  // 그 사이 더 최신 daSyncPush가 이미 시작됐으면 이 응답은 낡은 것 —
  // 적용하지 않는다(그 최신 호출이 알아서 반영한다).
  if (mySeq !== daSyncPushSeq) return { placesOk: false, coursesOk: false, tripsOk: false, visitsOk: false, tagsOk: false, allOk: false, stale: true };

  let localViewNeedsRefresh = false; // 재병합/삭제충돌 복구로 화면이 보는 spots/cities를 즉시 갱신해야 하는지.
  let placesRemergedAny = false;
  const placesOk = !!(placesRes.ok && placesRes.json && Array.isArray(placesRes.json.places));
  const coursesOk = !!(coursesRes.ok && coursesRes.json && Array.isArray(coursesRes.json.courses));
  const tripsOk = !!(tripsRes.ok && tripsRes.json && Array.isArray(tripsRes.json.trips));
  const visitsOk = !!(visitsRes.ok && visitsRes.json && Array.isArray(visitsRes.json.visits));
  // 서버가 실제로 받아 병합한 전체 목록을 그대로 돌려준다 — 로컬을 그
  // 결과로 맞춘다(trips/visits와 동일한 패턴). 실패한 것은 로컬을 그대로
  // 두고(잃지 않음) 다음 daSyncPushSafe 호출 때 다시 시도된다.
  if (placesOk) {
    const conflicts = Array.isArray(placesRes.json.conflicts) ? placesRes.json.conflicts : [];
    const editConflictById = new Map(conflicts.filter((c) => c.placeId && c.serverPlace && c.reason !== 'stale-base-version-delete').map((c) => [c.placeId, c]));
    // 2026-09-10 재검토(8차) — "단순히 서버 값을 받아 로컬 수정까지
    // 조용히 없애지 않기." 서버가 승인한 전체 배열을 그대로 덮어쓰지
    // 않고, 각 장소마다 "요청 시점 이후 로컬이 더 바뀌었는지"(저장 중
    // 추가 수정) 또는 "충돌로 반려됐는지"를 확인해 필요하면 3-way
    // 재병합한다.
    // 2026-09-11 재검토(9차) — 재병합이 일어난 장소는 병합 결과(내가
    // 고른 값)가 아니라 "서버가 지금 실제로 확정한 값"을 다음 기준선
    // (baseline)으로 남겨야 한다. 병합 결과를 기준으로 삼으면, 방금
    // 지킨 내 값과 기준이 똑같아져 버려 다음 충돌 때 "안 건드림"으로
    // 오인해 조용히 서버 값으로 되돌려질 수 있다(ChatGPT 재현).
    const baselineOverrides = new Map();
    const merged = placesRes.json.places.map((serverPlace) => {
      const mine = (foodMap.places || []).find((p) => p.id === serverPlace.id);
      if (!mine) return serverPlace;
      const conflict = editConflictById.get(serverPlace.id);
      const baseKey = requestSnapshot.get(serverPlace.id);
      const mineKey = A.placeContentKey(mine);
      const changedDuringFlight = baseKey !== undefined && mineKey !== baseKey;
      if (!conflict && !changedDuringFlight) return serverPlace; // 가장 흔한 경우 — 그대로 받아들인다.
      const base = A.getPlaceBaseline(serverPlace.id);
      placesRemergedAny = true;
      const theirsUsed = conflict ? conflict.serverPlace : serverPlace; // 서버가 지금 실제로 갖고 있는 값.
      baselineOverrides.set(serverPlace.id, theirsUsed);
      return daRemergePlaceConflict(mine, base, theirsUsed);
    });
    // 2026-09-11 재검토(10차) — ChatGPT가 점검하라고 지시한 항목: "저장
    // 중 새 장소 추가 보존"을 실제로 재현해 확인한 결과, 진짜 결함이
    // 있었다. merged는 서버가 돌려준 배열만 훑으므로, 이 요청이 나간
    // "이후"(요청 스냅샷에도 없고 서버 응답에도 없는) 새로 추가된
    // 장소는 여기서 통째로 빠진다 — 다음 줄의 foodMap.places = merged가
    // 그 새 장소를 조용히 지워 버렸다. 요청 스냅샷(requestSnapshot)에도
    // 없고 서버 응답에도 없는 로컬 id는 "이번 요청이 나간 뒤 새로
    // 생긴 것"이 확실하므로 그대로 살려 둔다 — 다음 daSyncPushSafe가
    // 알아서 서버에 반영한다.
    const mergedIds = new Set(merged.map((p) => p.id));
    const addedDuringOrAfterFlight = (foodMap.places || []).filter((p) => p && p.id && !mergedIds.has(p.id) && !requestSnapshot.has(p.id));
    foodMap.places = [...merged, ...addedDuringOrAfterFlight];
    // 서버가 확정한 값을 새 기준으로 삼는다 — 재병합이 일어난
    // 장소는 baselineOverrides에 담아 둔 "서버가 지금 실제로 갖고
    // 있는 값"을 쓰고(내가 고른 병합 결과가 아니라), 그 외에는
    // 배열의 값(=serverPlace) 그대로 쓴다.
    A.resyncPlacesBaseline(foodMap.places, baselineOverrides);

    // 2026-09-11 재검토(9차) — ChatGPT가 재현한 우회: 삭제 요청이
    // "기준 버전이 안 맞다"고 반려됐을 때(다른 기기가 그 사이 이
    // 장소를 실제로 고쳤다는 뜻) 예전엔 서버가 돌려준 최신 버전을
    // 그대로 새 기준으로 삼아 다음 저장 때 다시 삭제를 시도했다 —
    // 그런데 그 사이 생긴 최신 수정(예: 새 메모)은 생존 장소에 전혀
    // 병합된 적이 없으므로, 재시도가 성공하는 순간 그 수정이 통째로
    // 사라진다. 절대 자동으로 재삭제하지 않는다 — 서버의 최신 내용을
    // 그대로 로컬에 되살리고(데이터 보존), 병합 당시의 survivor와
    // 다시 중복 후보로 이어 사용자가 최신 내용을 보고 직접 한 번 더
    // 정리하게 한다(반복 확인창이 아니라 지나가는 안내 하나 + 중복
    // 후보 표시).
    const deleteConflictById = new Map(conflicts.filter((c) => c.reason === 'stale-base-version-delete' && c.serverPlace).map((c) => [c.placeId, c]));
    let restoredAny = false;
    for (const item of pendingDeleted) {
      const dc = deleteConflictById.get(item.id);
      if (!dc) continue;
      if ((foodMap.places || []).some((p) => p.id === item.id)) continue; // 이미 다른 경로로 되살아나 있음(중복 방지).
      const restored = { ...dc.serverPlace, mergeConflictRestored: true };
      foodMap.places.push(restored);
      const survivor = item.survivorId ? (foodMap.places || []).find((p) => p.id === item.survivorId) : null;
      if (survivor) {
        survivor.dupCandidateIds = Array.isArray(survivor.dupCandidateIds) ? survivor.dupCandidateIds : [];
        if (!survivor.dupCandidateIds.includes(restored.id)) survivor.dupCandidateIds.push(restored.id);
        restored.dupCandidateIds = [survivor.id];
      }
      restoredAny = true;
    }
    // 반려된 삭제는 큐에서 완전히 제거한다(재시도 금지) — 나머지(이번
    // 응답과 무관하게 이미 있던) 대기 항목만 그대로 남긴다.
    const stillNew = (foodMap.deletedPlaceIds || []).filter((d) => !pendingDeleted.some((pd) => pd.id === d.id));
    foodMap.deletedPlaceIds = stillNew;
    if (restoredAny) {
      daToast('다른 기기에서 방금 수정된 장소가 있어 병합을 취소했어요. 중복 후보에서 다시 확인해 주세요.');
    }

    if (placesRemergedAny) {
      daToast('다른 기기의 수정과 함께 자동으로 합쳐진 장소가 있어요.');
      // 재병합한 값과 반려된 삭제는 다음 사용자 조작을 기다리지 않고
      // 곧바로 한 번 더 시도한다(fire-and-forget — 이 호출 자체를
      // 막지 않는다). 단, 무한 반복은 daScheduleConflictRetry가 막는다.
      daScheduleConflictRetry();
    }
    localViewNeedsRefresh = placesRemergedAny || restoredAny;
  }
  // 2026-09-11 재검토(9차) — ChatGPT가 지적한 점검: "HTTP 200과 충돌
  // 해결 완료는 다르다"는 원칙이 courses/trips에도 적용되는지 확인한
  // 결과, 둘 다 places와 똑같은 결함이 있었다 — 서버(account-data.mjs
  // 의 syncCourses, trips.mjs의 syncTrips)는 기준 버전이 안 맞으면
  // 그 항목을 반영하지 않고 conflicts로 보고할 뿐인데, 클라이언트는
  // conflicts를 전혀 안 보고 서버가 돌려준 배열(=반려된 항목은 옛
  // 값 그대로)을 통째로 대입했다 — 방금 고친 로컬 값이 조용히
  // 사라진다. places처럼 기준(base) 스냅샷을 따로 추적하진 않지만,
  // "충돌난 항목은 내가 뭘 고쳤는지 몰라도 최소한 조용히 안 지운다"
  // 는 원칙(daRemergePlaceConflict의 base-없음 경로와 동일)을 그대로
  // 적용한다 — 내 값을 지키고 기준 버전만 서버 값으로 올려 재시도한다.
  // visits는 서버가 충돌 시에도 합집합으로 병합해 돌려주므로(날짜를
  // 절대 버리지 않음) 그대로 대입해도 안전하다 — 여기서 손대지 않는다.
  let coursesRemergedAny = false;
  if (coursesOk) {
    const conflicts = Array.isArray(coursesRes.json.conflicts) ? coursesRes.json.conflicts : [];
    const courseKey = (c) => `${c.city}__${c.date}`;
    const conflictByKey = new Map(conflicts.filter((c) => c.city && c.date && c.serverCourse).map((c) => [courseKey(c), c]));
    const mineByKey = new Map((foodMap.courses || []).filter((c) => !c.tripId).map((c) => [courseKey(c), c]));
    // 2026-09-11 재검토(10차) — ChatGPT 재현: 예전엔 충돌 시 서버가
    // 실제로 갖고 있는 내용(conflict.serverCourse)을 완전히 버리고 내
    // 로컬 객체 전체를 버전만 바꿔 재제출했다 — 그 사이 다른 기기가
    // 고친 필드(예: note='SERVER-NEW')가 재시도 성공과 동시에 통째로
    // 사라졌다. courses는 places처럼 기준(base) 스냅샷을 추적하지
    // 않으므로 daRemergeGenericConflict를 base=null로 호출해 "내가
    // 건드렸을 수 있는 모든 필드는 병합, 서로 다른 필드는 양쪽 값을
    // _fieldConflicts에 보존"하는 안전한 경로를 그대로 재사용한다.
    const courseBaselineOverrides = new Map();
    const mergedLegacy = coursesRes.json.courses.map((serverCourse) => {
      const conflict = conflictByKey.get(courseKey(serverCourse));
      if (!conflict) return serverCourse;
      const mine = mineByKey.get(courseKey(serverCourse));
      if (!mine) return serverCourse;
      coursesRemergedAny = true;
      const base = A.getCourseBaseline(serverCourse.city, serverCourse.date);
      courseBaselineOverrides.set(courseKey(serverCourse), conflict.serverCourse);
      return daRemergeGenericConflict(mine, base, conflict.serverCourse, ['city', 'date']);
    });
    // account_courses는 tripId 없는 레거시 코스만 담당한다 — trip에
    // 딸린 코스(foodMap.courses 중 tripId 있는 것)는 그대로 두고, 그
    // 부분만 서버의 병합 결과로 맞춘다.
    const tripCourses = (foodMap.courses || []).filter((c) => c.tripId);
    foodMap.courses = [...mergedLegacy, ...tripCourses];
    // 2026-09-11 재검토(11차) — foodMap.course는 foodMap.courses 안의
    // 한 항목을 "가리키는 포인터"일 뿐인데, 위에서 배열을 통째로 새
    // 객체로 갈아 끼웠으므로 옛 포인터는 이제 배열 밖의 낡은 객체를
    // 본다(예: 방금 병합해 남긴 _fieldConflicts를 화면이 못 본다).
    // 같은 날짜를 계속 보고 있었다면 새 객체로 다시 맞춘다.
    if (foodMap.course && !foodMap.course.tripId) {
      const rePointed = foodMap.courses.find((c) => !c.tripId && c.city === foodMap.course.city && c.date === foodMap.course.date);
      if (rePointed) foodMap.course = rePointed;
    }
    // 서버가 지금 실제로 확정한 값을 다음 기준선으로 남긴다(병합
    // 결과가 아니라) — places와 동일한 이유(9차 재검토 버그 재발 방지).
    A.resyncCoursesBaseline(mergedLegacy, courseBaselineOverrides);
    if (conflictByKey.size) { daToast('다른 기기와 코스 정보가 달라 자동으로 합쳐졌어요.'); daScheduleConflictRetry(); }
  }
  let tripsRemergedAny = false;
  if (tripsOk) {
    const conflicts = Array.isArray(tripsRes.json.conflicts) ? tripsRes.json.conflicts : [];
    const conflictByTripId = new Map(conflicts.filter((c) => c.tripId && c.serverTrip).map((c) => [c.tripId, c]));
    const tripBaselineOverrides = new Map();
    if (conflictByTripId.size) {
      const mineByTripId = new Map((foodMap.trips || []).map((t) => [t.tripId, t]));
      // 위 courses와 동일한 이유로, 여기서도 더 이상 "버전만 바꿔 통째로
      // 재제출"하지 않고 기준선 기반 3-way 재병합을 쓴다.
      foodMap.trips = tripsRes.json.trips.map((serverTrip) => {
        const conflict = conflictByTripId.get(serverTrip.tripId);
        if (!conflict) return serverTrip;
        const mine = mineByTripId.get(serverTrip.tripId);
        if (!mine) return serverTrip;
        tripsRemergedAny = true;
        const base = A.getTripBaseline(serverTrip.tripId);
        tripBaselineOverrides.set(serverTrip.tripId, conflict.serverTrip);
        return daRemergeGenericConflict(mine, base, conflict.serverTrip, ['tripId']);
      });
      daToast('다른 기기와 여행 정보가 달라 자동으로 합쳐졌어요.');
      daScheduleConflictRetry();
    } else {
      foodMap.trips = tripsRes.json.trips;
    }
    // 서버가 지금 실제로 확정한 값을 다음 기준선으로 남긴다 — courses와 동일.
    A.resyncTripsBaseline(foodMap.trips, tripBaselineOverrides);
  }
  if (visitsOk) foodMap.visits = visitsRes.json.visits;
  // 2026-09-11 재검토(11차) — 태그 레지스트리 동기화 응답 반영. 태그는
  // 여러 기기가 동시에 같은 태그를 서로 다르게 고치는 일이 드물고,
  // 지시도 trips/courses처럼 별도 충돌 해결 화면을 요구하지 않으므로
  // 여기서는 places/courses보다 단순하게 처리한다 — 충돌이 나면(아주
  // 드문 경우) 서버가 지금 갖고 있는 값을 그대로 받아들인다(다음
  // 화면에서 바로 보인다). 다만 "저장 중 새로 만든 태그"는 장소와
  // 같은 이유로 잃지 않는다 — 응답에도, 요청 스냅샷에도 없는 태그는
  // 이 요청이 나간 뒤 새로 생긴 것이 확실하므로 그대로 살려 둔다.
  const tagsOk = !!(tagsRes.ok && tagsRes.json && Array.isArray(tagsRes.json.tags));
  if (tagsOk) {
    const conflicts = Array.isArray(tagsRes.json.conflicts) ? tagsRes.json.conflicts : [];
    const conflictById = new Map(conflicts.filter((c) => c.tagId && c.serverTag).map((c) => [c.tagId, c.serverTag]));
    const merged = tagsRes.json.tags.map((serverTag) => conflictById.get(serverTag.id) || serverTag);
    const mergedIds = new Set(merged.map((tg) => tg.id));
    const addedDuringOrAfterFlight = (A.rawCustomTags || []).filter((tg) => tg && tg.id && !mergedIds.has(tg.id) && !tagRequestSnapshot.has(tg.id));
    foodMap.customTags = [...merged, ...addedDuringOrAfterFlight];
    // 반려된 삭제(기준 버전이 안 맞음)는 큐에서 빼지 않고 그대로 두면
    // 다음 push 때 다시 시도된다 — places의 "삭제 충돌"과 달리 되살릴
    // 필요는 없다(태그 삭제는 연결만 끊는 저위험 작업이라 자동
    // 재시도만으로 충분하다). 실제로 반영된(성공했거나, 서버가 이미
    // 몰라서 그냥 넘어간) 것만 큐에서 제거한다.
    const deleteConflictIds = new Set(conflicts.filter((c) => c.reason === 'stale-base-version-delete').map((c) => c.tagId));
    foodMap.deletedTagIds = (A.deletedTagIds || []).filter((d) => !pendingDeletedTags.some((pd) => pd.id === d.id) || deleteConflictIds.has(d.id));
    A.resyncCustomTagsRef(foodMap);
  }
  if (placesOk && coursesOk && tripsOk && !placesRemergedAny && !coursesRemergedAny && !tripsRemergedAny) {
    daSyncConflictRetryCount = 0; // 충돌 없이 조용히 끝난 push — 재시도 카운터 원복.
  }
  A.saveFoodMap(foodMap);
  // 2026-09-11 재검토(9차) — 재병합·삭제충돌 복구는 사용자가 아무
  // 조작도 안 했는데 백그라운드에서 foodMap을 바꾼다. 화면이 보는
  // spots/cities(모듈 전역, buildSpots 결과)를 여기서 갱신해 두지
  // 않으면 지금 열려 있는 화면(장소 상세의 _fieldConflicts 안내 등)이
  // 낡은 데이터를 계속 보여준다 — 저장소 왕복(A.loadFoodMap) 없이
  // 지금 이 foodMap으로 바로 다시 그린다(refreshFromStorage처럼).
  if (localViewNeedsRefresh) {
    built = A.buildSpots(foodMap);
    if (built.spots.length > 0) {
      usingSample = false; spots = built.spots; cities = built.cities;
      if (!cities.some((c) => c.name === city)) city = cities[0].name;
    }
  }
  // 2026-09-11 재검토(11차) — "HTTP 200과 동기화 완료는 다르다"는
  // 지적을 places 응답 실패뿐 아니라 "저장은 됐지만 어느 값을 쓸지
  // 아직 안 고른 미해결 필드 충돌"까지 반영한다. allOk는 이제
  // "네트워크·서버 응답이 전부 성공했다"만 뜻하고, 별도의
  // hasUnresolvedConflicts로 "그래도 사용자가 아직 정리할 게
  // 남았다"를 구분해 알린다(로그아웃 확인 등에서 사용).
  const hasUnresolvedConflicts =
    (foodMap.places || []).some((p) => p && p._fieldConflicts && Object.keys(p._fieldConflicts).length) ||
    (foodMap.courses || []).some((c) => c && c._fieldConflicts && Object.keys(c._fieldConflicts).length) ||
    (foodMap.trips || []).some((tr) => tr && tr._fieldConflicts && Object.keys(tr._fieldConflicts).length);
  const allOk = placesOk && coursesOk && tripsOk && visitsOk && tagsOk;
  return { placesOk, coursesOk, tripsOk, visitsOk, tagsOk, allOk, hasUnresolvedConflicts, fullySynced: allOk && !hasUnresolvedConflicts };
}
function daSyncPushSafe() {
  const token = A.sessionToken(foodMap);
  if (token) daSyncPush(token).catch(() => {});
}

/* 2026-09-11 재검토(11차) 4절 — AI 보조 분류 클라이언트 백그라운드
   큐. "가져오기 직후나 변경 후에만, 새로/아직 미분류인 항목만" 돌고,
   화면은 그동안 그대로 쓸 수 있어야 한다(await 안 하고 호출부에서
   그냥 fire-and-forget으로 부른다). 서버가 비활성/예산부족/오류를
   돌려줘도 조용히 규칙 기반 결과·수동 편집 상태를 그대로 둔다 — 이
   함수가 실패해도 화면 동작에는 전혀 영향이 없다. */
let _aiClassifyInFlight = false;
async function daRunAiClassifyQueueOnce() {
  if (_aiClassifyInFlight) return;
  const token = A.sessionToken(foodMap);
  if (!token) return; // 계정별 서버 캐시·비용 통제 전제 — 로그인 안 했으면 시도 안 함.
  const candidates = (foodMap.places || []).filter((p) => A.needsAiClassify(p));
  if (!candidates.length) return;
  const batch = candidates.slice(0, 20); // 서버 배치 상한을 넘겨 보내도 서버가 알아서 자르지만, 굳이 큰 요청을 만들지 않는다.
  const epochAtStart = sessionEpoch;
  const snapshot = batch.map((p) => ({ p, localId: p.id, fingerprint: A.aiClassifyInputFingerprint(p) }));
  const items = snapshot.map((s) => ({ localId: s.localId, name: s.p.name || '', address: s.p.address || '', confirmedTypes: s.p.confirmedTypes || [] }));
  _aiClassifyInFlight = true;
  try {
    const r = await A.api('/api/places/classify-batch', { method: 'POST', token, body: { items } });
    // 요청이 도는 사이 로그아웃/계정 전환이 있었으면 이 응답은 다른
    // 계정 상태에 적용될 위험이 있으므로 통째로 버린다.
    if (sessionEpoch !== epochAtStart) return;
    if (!r.ok || !r.json || r.json.ok === false) return; // 비활성/한도/오류 — 규칙 기반·수동 편집을 그대로 둔다(조용히 실패).
    const results = Array.isArray(r.json.results) ? r.json.results : [];
    let changed = false;
    for (const res of results) {
      const snap = snapshot.find((s) => s.localId === res.localId);
      if (!snap) continue;
      // 요청을 보낸 뒤 사용자가 이 장소를 고치거나 지웠으면(또는 그
      // 사이 이미 직접 확정했으면) 이 결과를 적용하지 않는다 —
      // "편집/삭제/계정전환 중이던 응답은 반영 금지" 요구사항.
      const stillExists = (foodMap.places || []).includes(snap.p);
      const stillSame = stillExists && A.aiClassifyInputFingerprint(snap.p) === snap.fingerprint;
      if (!stillSame) continue;
      if (A.applyAiClassifyResult(snap.p, res)) changed = true;
    }
    if (changed) {
      A.saveFoodMap(foodMap);
      if (!usingSample) render();
    }
  } catch (e) {
    // 네트워크 오류 등 — 조용히 실패. 규칙 기반 결과·수동 편집은 계속 쓸 수 있다.
  } finally {
    _aiClassifyInFlight = false;
  }
}
function daRunAiClassifyQueueSafe() { daRunAiClassifyQueueOnce().catch(() => {}); }
async function daSyncPullAndMerge(token) {
  const epochAtStart = sessionEpoch;
  const [placesRes, coursesRes] = await Promise.all([
    A.api('/api/places', { token }),
    A.api('/api/courses', { token }),
  ]);
  if (sessionEpoch !== epochAtStart) return; // 그 사이 로그아웃/재로그인 — 이 응답은 버린다.
  const serverPlaces = (placesRes.ok && placesRes.json && Array.isArray(placesRes.json.places)) ? placesRes.json.places : [];
  const serverCourses = (coursesRes.ok && coursesRes.json && Array.isArray(coursesRes.json.courses)) ? coursesRes.json.courses : [];

  foodMap.places = foodMap.places || [];
  const placeIds = new Set(foodMap.places.map((p) => p.id));
  serverPlaces.forEach((sp) => { if (sp && sp.id && !placeIds.has(sp.id)) { foodMap.places.push(sp); placeIds.add(sp.id); } });

  foodMap.courses = foodMap.courses || [];
  serverCourses.forEach((sc) => {
    if (!sc || !sc.city || !sc.date) return;
    const exists = foodMap.courses.some((c) => c.city === sc.city && c.date === sc.date);
    if (!exists) foodMap.courses.push(sc);
  });

  A.saveFoodMap(foodMap);
  // 병합 결과를 다시 서버에 올려 양쪽을 같은 상태로 맞춘다(예: 이
  // 기기의 손님 데이터가 이제 서버에도 반영돼야 다른 기기에서도 보인다).
  await daSyncPush(token);
  // 다른 기기에서 새로 들어온(아직 이 기기에서 분류를 시도한 적
  // 없는) 미분류 장소도 로그인 직후에 한 번 훑는다.
  daRunAiClassifyQueueSafe();
}

/* 로그아웃 — "로그아웃/계정 전환 때 다른 계정의 로컬 데이터가 섞이지
   않게 하라"는 지시대로, 로그아웃 시점에 이 기기의 개인화 데이터를
   지운다. 안전한 이유: 로그아웃 직전까지 daSyncPushSafe가 계속 최신
   상태를 서버에 올려 뒀으므로, 로컬을 지워도 이 계정으로 다시
   로그인하면 daSyncPullAndMerge가 그대로 되살린다 — 데이터가 사라지는
   게 아니라 "이 기기에서 로그아웃 중에는 안 보이는" 것뿐이다. */
async function daLogout() {
  const token = A.sessionToken(foodMap);
  if (token) {
    // 2026-09-10 재검토(7차) — "동기화 완료 보장 없이 로컬 데이터를
    // 지운다"는 지적 반영. 로그아웃 직전에 마지막으로 한 번 더 밀어
    // 넣어 보고, 그게 실패하면(오프라인 등) 조용히 밀어붙이지 않고
    // 사실대로 알린 뒤 사용자가 정말 그래도 로그아웃할지 직접 고르게
    // 한다 — 아직 서버에 못 올라간 이 기기의 최근 변경을 실수로 잃지
    // 않기 위해서다.
    const result = await daSyncPush(token).catch(() => ({ allOk: false, stale: false, hasUnresolvedConflicts: false }));
    if (!result.allOk && !result.stale) {
      const proceed = confirm('일부 변경사항이 아직 서버에 저장되지 못했어요(네트워크 상태를 확인해 주세요). 그래도 로그아웃하면 이 기기에 저장되지 않은 최근 변경사항을 잃을 수 있어요. 그래도 로그아웃할까요?');
      if (!proceed) return;
    } else if (result.allOk && result.hasUnresolvedConflicts) {
      // 2026-09-11 재검토(11차) — "HTTP 200과 동기화 완료는 다르다."
      // 저장 자체는 됐지만(allOk=true) 다른 기기와 값이 다른 필드를
      // 아직 사람이 고르지 않은 상태다 — 데이터는 안 잃지만(다음에
      // 로그인해도 같은 안내가 다시 뜬다), 조용히 넘어가지 않고
      // 알린다.
      const proceed = confirm('다른 기기와 값이 다른 항목이 아직 있어요(저장은 됐지만 어느 값을 쓸지 아직 안 골랐어요). 그래도 로그아웃할까요? (다시 로그인하면 같은 안내가 남아 있어요)');
      if (!proceed) return;
    }
  }
  // 지금부터 세대를 올려, 이 시점 이전에 걸려 있던 다른 비동기 응답이
  // 나중에 도착해도 다음 화면(로그아웃 후 손님 상태 또는 다른 계정
  // 로그인)에 반영되지 않게 막는다.
  sessionEpoch++;
  if (token) { await A.api('/api/auth/logout', { method: 'POST', token }).catch(() => {}); }
  delete foodMap.session;
  delete foodMap.places;
  delete foodMap.course;
  delete foodMap.courses;
  delete foodMap.trips;
  delete foodMap.customTags;
  delete foodMap.deletedTagIds;
  delete foodMap.visits;
  delete foodMap.currentTripByCity;
  delete foodMap.deletedPlaceIds;
  // 2026-09-11 재검토(11차) 5절 — 실제 GPS·직접 입력 위치는 세션
  // 메모리에만 있어 애초에 저장소에 안 남지만(로그아웃해도 자동으로
  // 안전), 같은 탭에서 로그아웃 없이 다른 계정으로 곧장 들어오는
  // 경로는 없다(로그아웃이 항상 먼저다) — 그래도 "이전 계정에서 켠
  // 위치가 다음 계정 화면에 그대로 남는" 사고를 원천 차단하기 위해
  // 로그아웃 시점에 명시적으로 비운다.
  _myGpsLocation = null;
  _myManualLocation = null;
  A.saveFoodMap(foodMap);
  // 2026-09-11 재검토(10차) — 기준선(baseline) 지속 저장을 도입하면서
  // 새로 생긴 책임: 이 계정의 마지막 동기화 기준선이 다음 계정으로
  // 새면 안 된다(특히 courses는 city+date 키라 서로 다른 계정이 같은
  // 도시·날짜 키를 가질 수 있어 위험하다). 로그아웃 때 반드시 먼저
  // 비운다.
  A.clearSyncBaselines();
  foodMap = A.loadFoodMap();
  route.clear(); selected.clear(); filter = '전체';
  usingSample = true; spots = SAMPLE_SPOTS; cities = SAMPLE_CITIES; city = cities[0].name;
  updateCity();
  sheet.close();
}

function refreshFromStorage() {
  foodMap = A.loadFoodMap();
  built = A.buildSpots(foodMap);
  if (built.spots.length > 0) {
    usingSample = false; spots = built.spots; cities = built.cities;
    if (!cities.some((c) => c.name === city)) city = cities[0].name;
  }
}

/* 카드 한 장. 승인 마크업 그대로 두고 세 곳만 실데이터에 맞게 바꿨다:
   1) 사용자 텍스트는 전부 A.esc() 를 거친다(원본은 무가공 삽입이었다)
   2) image 가 없으면 <img> 대신 빈 상태 칸(.photo-empty)을 그린다 — 샘플
      사진을 실제 매장 사진처럼 붙이지 않는다(1번 요구사항)
   3) 샘플일 때는 카드에 "샘플" 표시를 남긴다 — 실제 데이터와 섞여 보이지
      않게 한다 */
function photoHTML(p, cls) {
  if (p.image) return `<img class="${cls}" src="${A.esc(p.image)}" alt="${A.esc(p.category)} 분위기 참고용 사진" loading="lazy" decoding="async" width="320" height="320">`;
  const initial = A.esc((p.category || '?').slice(0, 1));
  return `<div class="${cls} photo-empty" role="img" aria-label="사진 없음">${initial}</div>`;
}
function render() {
  const q = $('#search').value.trim().toLowerCase();
  // 6-2절 — 세부 태그 칩은 상위분류(filter)까지만 반영된 목록을 보고
  // "지금 실제로 있는 태그"만 보여준다(버튼을 과하게 늘리지 않는다는
  // 원칙 — 존재하지도 않는 태그를 미리 늘어놓지 않는다).
  const tagFiltersEl = $('#tagFilters');
  if (tagFiltersEl) {
    const catBase = usingSample ? [] : spots.filter((p) => p.city === city && (filter === '전체' || p.category === filter));
    const availableTags = Array.from(new Set(catBase.flatMap((p) => Array.isArray(p.tags) ? p.tags : []))).sort();
    for (const t of Array.from(activeTags)) if (!availableTags.includes(t)) activeTags.delete(t);
    tagFiltersEl.hidden = !availableTags.length;
    if (availableTags.length) {
      tagFiltersEl.innerHTML = availableTags.map((t) => `<button data-tagfilter="${A.esc(t)}" class="${activeTags.has(t) ? 'active' : ''}" aria-pressed="${activeTags.has(t)}">${A.esc(t)}</button>`).join('');
    }
  }
  let list = spots.filter((p) => p.city === city && (filter === '전체' || p.category === filter)
    && (usingSample || visitFilter === '전체' || visitStatusFor(p.id) === visitFilter)
    && (activeTags.size === 0 || Array.from(activeTags).every((t) => Array.isArray(p.tags) && p.tags.includes(t)))
    && [p.name, p.area, p.category, p.memo].some((v) => String(v || '').toLowerCase().includes(q)));
  // 6-1절 — 정렬은 이미 필터링된 목록 위에서만 적용한다(도시·유형·검색
  // 조건은 그대로 유지). 2026-09-11 재검토(10차) 7절 — 거리순·코스
  // 출발점·내 주변 날씨가 전부 같은 기준을 쓰도록 daLocationBasis()로
  // 통합했다(우선순위: 승인된 테스트 위치 > 이번 세션에 실제로 허용받은
  // GPS > 평균 위치). 위치 권한도 유료 API 호출도 강제하지 않는다 —
  // 평균 위치는 정확히 "평균 위치"라고만 부르고 "지정 위치"라고
  // 부르지 않는다(사용자가 지정한 값이 아니므로).
  const basis = daLocationBasis();
  const cityRefPoint = basis ? { lat: basis.lat, lng: basis.lng } : null;
  list = A.sortSpots(list, { mode: sortMode, query: q, refPoint: cityRefPoint });
  const basisNote = $('#sortBasisNote');
  if (basisNote) {
    if (sortMode === 'distance') {
      basisNote.hidden = false;
      basisNote.textContent = !basis
        ? '아직 좌표가 확인된 장소가 없어 거리순 기준을 정할 수 없어요'
        : basis.source === 'test'
          ? `기준: ${basis.label} · 실제 GPS 아님 · 좌표 없는 곳은 맨 아래`
          : basis.source === 'gps'
            ? '기준: 내 위치(GPS) · 좌표 없는 곳은 맨 아래'
            : basis.source === 'manual'
              ? '기준: 직접 입력한 위치 · 좌표 없는 곳은 맨 아래'
              : '기준: 이 도시에 저장된 곳들의 평균 위치 · 좌표 없는 곳은 맨 아래';
    } else {
      basisNote.hidden = true;
    }
  }
  // 2026-09-11 재검토(11차) 5절 — 거리순을 고를 때만 "내 위치 기준"
  // 버튼을 보여준다(다른 정렬에서는 위치 얘기를 꺼낼 이유가 없다).
  // 테스트 위치가 이미 켜져 있으면 그게 최우선이라 버튼을 눌러도
  // 바뀌는 게 없으므로 숨긴다(혼란 방지).
  const useMyLocationBtn = $('#useMyLocationBtn');
  if (useMyLocationBtn) {
    const testLocActive = A.testModeAllowed() && !!A.getTestLocation();
    useMyLocationBtn.hidden = sortMode !== 'distance' || testLocActive;
    if (!useMyLocationBtn.hidden) useMyLocationBtn.textContent = (basis && basis.source === 'gps') ? '내 위치 다시 확인' : '내 위치 기준으로 보기';
  }
  $('#count').textContent = list.length;
  $('#clear').hidden = !q;
  $('#empty').hidden = !!list.length;
  if (!list.length) {
    $('#empty').innerHTML = usingSample
      ? '<h3>아직 모아둔 곳이 없어요</h3><p>다른 이름이나 유형으로 찾아보세요.</p><button class="primary" id="reset">전체 스팟 보기</button>'
      : '<h3>이 조건에 맞는 곳이 없어요</h3><p>다른 이름이나 유형으로 찾아보세요.</p><button class="primary" id="reset">전체 스팟 보기</button>';
    const r = $('#reset'); if (r) r.onclick = resetSearch;
  }
  $('#grid').innerHTML = list.map((p) => `<article class="spot ${selected.has(p.id) ? 'selected' : ''}"><button class="spot-open" data-detail="${p.id}" aria-label="${A.esc(p.name)} 상세 보기">${photoHTML(p, 'photo')}<div class="spot-info"><span class="category">${A.esc(p.category)}</span><h3>${A.esc(p.name)}</h3><p class="area">${A.esc(p.area) || '&nbsp;'}</p>${p.memo ? `<p class="memo">${A.esc(p.memo)}</p>` : ''}</div></button><button class="pick" data-pick="${p.id}" aria-label="${A.esc(p.name)} 선택" aria-pressed="${selected.has(p.id)}">${selected.has(p.id) ? '✓' : '＋'}</button></article>`).join('');
  const activeSelected = spots.filter((p) => p.city === city && selected.has(p.id)).length;
  $('#selectionbar').hidden = !activeSelected;
  $('#selectedCount').textContent = activeSelected;
  $('#selectMode').textContent = selecting ? '선택 마치기' : '장소 선택';
  /* "지역 확인 필요"를 보고 있으면 선택바 동작을 동선 담기 대신 도시
     지정으로 바꾼다 — 로드맵 ④: 여러 장소 선택 → 여행지 일괄 지정. */
  $('#addRoute').textContent = city === A.UNKNOWN_CITY ? '도시 지정하기 ↗' : '오늘 동선에 담기 ↗';
  $('.demo').textContent = usingSample ? '샘플 컬렉션' : (foodMap.places && foodMap.places.length ? '내 컬렉션' : '');
  $('.demo').hidden = !usingSample && !(foodMap.places && foodMap.places.length);
}
function resetSearch() { $('#search').value = ''; filter = '전체'; activeTags.clear(); document.querySelectorAll('[data-filter]').forEach((x) => { x.classList.toggle('active', x.dataset.filter === '전체'); x.setAttribute('aria-pressed', x.dataset.filter === '전체'); }); render(); }
function toggle(id) { selected.has(id) ? selected.delete(id) : selected.add(id); render(); }
function open(title, html) { currentScreenLabel = title; $('#sheetLabel').textContent = title; $('#sheetContent').innerHTML = html; if (!sheet.open) sheet.showModal(); }

/* 상세 시트. 바뀐 것:
   - "샘플" 문구는 usingSample 일 때만
   - 지도 링크는 실제 저장된 구글맵 링크(A.daLink 결과, p.url)로 간다.
     원본은 항상 "카테고리로 주변 찾기" 검색 링크였다 — 저장한 바로 그
     장소가 아니라 근처 아무 가게로 갈 수 있어 실데이터에는 못 쓴다. */
function detail(id) {
  const p = spots.find((x) => x.id === id); if (!p) return;
  const mapLabel = usingSample ? `Google Maps에서 주변 ${A.esc(p.category)} 찾기 ↗` : '이 장소를 Google Maps에서 보기 ↗';
  const mapHref = usingSample ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((p.area || '') + ' ' + p.category)}` : A.esc(p.url || '');
  const notes = [];
  let cityBlock = '';
  if (usingSample) notes.push('실제 매장이 아닌 디자인 예시입니다. 사진은 분위기 참고용이며 주소·전화번호는 실제 장소 연결 후 표시됩니다.');
  else {
    if (!p.image) notes.push('사진은 아직 연결되지 않았습니다. 주소·전화번호·영업시간은 다음 단계에서 연결합니다.');
    if (p.sourceLists && p.sourceLists.length > 1) notes.push('여러 목록(' + p.sourceLists.map(A.esc).join(' · ') + ')에 저장돼 있어 하나로 합쳤습니다.');
    if (!p.cityKnown) {
      /* 도시 지정 ≠ 좌표 확인. 지정해도 동선 계산에는 못 쓴다는 걸 바로 옆에 적는다. */
      cityBlock = `<div class="inline-note">도시가 아직 확인되지 않았습니다.${p.cityHint ? ` 좌표로 보면 <b>${A.esc(p.cityHint)}</b> 근처일 수 있어요(짐작일 뿐, 확정 아님).` : ''}<br>` +
        `<button class="text-button" data-city-single="${id}">이 장소 도시 지정하기</button></div>` +
        (p.hasCoords ? '' : '<small>좌표가 없어서 도시를 지정해도 최단 동선·거리 계산에는 쓸 수 없습니다. 실제 위치 확인은 별도로 필요합니다.</small>');
    }
    if (p.needsLookup) {
      /* 2026-09-09 코드 검토(2차) — 예전엔 "축약 링크"라고만 안내했는데,
         실제로 이 상태에 걸리는 경우는 여러 가지다(daLookupState 참고):
         축약 링크, 좌표 없이 식별자만 있는 장소 링크(FID·cid·place_id),
         URL조차 없는 경우. 상태별로 사실과 다른 안내를 하지 않는다
         (예: URL이 없는데 "링크를 열어 확인하라"고 하면 안 된다). 실제
         좌표 조회는 소비자에게 API 키를 넣게 하지 않는다는 원칙상
         서버 쪽에서 처리해야 할 몫으로 아직 남겨 둔다(작업 목록 참고). */
      const lookupMsg = {
        'short-link': '저장된 링크가 축약 링크라 정확한 위치를 URL만으로 확인할 수 없어요.',
        'place-id-no-coords': '저장된 링크에 이 장소를 가리키는 식별자는 있지만, 좌표가 URL 문자열에는 없어요.',
        'ambiguous-search': '저장된 링크가 특정 장소가 아니라 검색 링크라, 어떤 곳을 저장한 건지부터 확인이 필요해요.',
        'no-evidence': '저장된 링크가 없어서 위치를 확인할 근거가 아직 없어요.',
      }[p.lookupState] || '저장된 정보만으로는 정확한 위치를 확인할 수 없어요.';
      cityBlock += `<div class="inline-note">${lookupMsg}` +
        (p.url ? `<br><a class="text-button" href="${A.esc(p.url)}" target="_blank" rel="noopener noreferrer">Google 지도에서 직접 열어 확인하기 ↗</a>` : '') +
        `<br><button class="text-button" data-lookup-place="${id}" style="padding:6px 0">서버로 위치 후보 찾아보기 ↗</button></div>`;
    }
    if (p.fieldConflicts && Object.keys(p.fieldConflicts).length) {
      // 2026-09-11 재검토(9차) — 같은 필드를 두 기기가 다르게 고친
      // 진짜 충돌. 지금은 내 값을 지키고 있다고 밝히고, 원하면 다른
      // 기기 값으로 한 번에 바꿀 수 있게 한다(반복 확인창이 아니라
      // 상세 화면의 조용한 안내 + 버튼 하나).
      cityBlock += daFieldConflictBlockHTML(p.fieldConflicts, 'conflict-resolve', id);
    }
    if (p.dupCandidateIds && p.dupCandidateIds.length) {
      const others = p.dupCandidateIds.map((did) => spots.find((s) => s.id === did)).filter(Boolean);
      cityBlock += others.map((o) => `<div class="inline-note">이름이 같은 곳이 또 있어요: <b>${A.esc(o.name)}</b>(${A.esc(o.city)})<br>` +
        `<button class="text-button" data-dup-merge="${id}|${o.id}">같은 곳이에요 · 합치기</button> ` +
        `<button class="text-button" data-dup-dismiss="${id}|${o.id}">다른 곳이에요</button></div>`).join('');
    }
  }
  const catBlock = usingSample ? '' :
    ` <button class="text-button" data-cat-edit="${id}" style="padding:0;font-size:11px">${p.catConfirmed ? '유형 다시 고르기' : '유형이 맞나요? 수정'}</button>`;
  // 6-2절 — 상위분류(category)는 그대로 두고, 그 아래에 세부 다중 태그를
  // 작은 칩으로 따로 보여준다(불확실하면 자동으로 아무 것도 안 붙는다).
  const tagsBlock = usingSample ? '' :
    `<div class="tag-chips">${(p.tags || []).map((t) => `<span class="tag-chip">${A.esc(t)}</span>`).join('')}` +
    `<button class="text-button" data-tags-edit="${id}" style="padding:0;font-size:11px">${(p.tags && p.tags.length) ? '세부 태그 수정' : '세부 태그 추가'}</button></div>`;
  open(usingSample ? '샘플 장소' : '내 장소', `<div class="detail">${photoHTML(p, 'detail-photo')}<h2>${A.esc(p.name)}</h2><span class="category">${A.esc(p.category)}${!usingSample && !p.catConfirmed ? '(짐작)' : ''}</span>${catBlock}${!usingSample ? ` <span class="category">${A.esc(p.city)}${p.cityKnown && !p.cityConfirmed ? '(짐작)' : ''}</span>` : ''}${tagsBlock}<p>${A.esc(p.area) || '위치 정보 없음'}</p>${p.memo ? `<p>“${A.esc(p.memo)}”</p>` : ''}<button class="primary" data-detail-pick="${id}">${selected.has(id) ? '선택에서 빼기' : '오늘 갈 곳으로 선택'}</button>${mapHref ? `<a target="_blank" rel="noopener noreferrer" href="${mapHref}">${mapLabel}</a>` : ''}${visitBlockHTML(id)}${cityBlock}${notes.map((n) => `<small>${n}</small>`).join('')}</div>`);
}
/* 유형 지정 시트 — 확인된 유형(실제 데이터에 있던 분류)을 이름 기반 추정
   보다 우선하지만, 추정이 틀렸으면 사용자가 여기서 직접 고칠 수 있다.
   한 번 고르면 catConfirmed=true로 남아 재수입해도 안 덮인다
   (2026-09-09 코드 검토 — 후쿠오카 전용 상호명 목록에 기대지 않는
   범용 유형 목록을 그대로 쓴다). */
function catAssignSheet(id) {
  const p = spots.find((s) => s.id === id); if (!p) return;
  const cats = A.knownCats;
  open('유형 지정', `<div class="detail"><h2>이 장소는 어떤 유형인가요?</h2>` +
    `<p>${A.esc(p.name)}</p>` +
    `<div class="city-options">${cats.map((c) => `<button class="city-option" data-assign-cat="${A.esc(c)}"><span><b>${A.esc(c)}</b></span><span class="city-check">${p.category === c ? '✓' : '›'}</span></button>`).join('')}</div></div>`);
  $('#sheetContent').querySelectorAll('[data-assign-cat]').forEach((b) => {
    b.onclick = () => finishCatAssign(id, b.dataset.assignCat);
  });
}
function finishCatAssign(id, cat) {
  A.setCat(foodMap.places, id, cat);
  const saved = A.saveFoodMap(foodMap);
  if (!saved) {
    foodMap = A.loadFoodMap();
    alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.');
    return;
  }
  daSyncPushSafe();
  refreshFromStorage();
  updateCity();
  detail(id);
}
/* 6-2절 — 세부 다중 태그 지정 시트. 상위분류(catAssignSheet)는 하나만
   고르지만, 태그는 여러 개를 동시에 켤 수 있어 즉시 반영 대신 "저장"
   버튼으로 한 번에 확정한다. 한 번 저장하면 tagsConfirmed=true로 남아
   재수입·재동기화가 절대 안 덮는다(daSetTags/daMerge와 동일 규칙). */
function tagsEditSheet(id) {
  const p = spots.find((s) => s.id === id); if (!p) return;
  const current = new Set(p.tags || []);
  // 2026-09-11 재검토(10차) 4·5절 — "분류가 많으면 자주 쓰는 것과
  // 더 보기로 정리하고 전체 사전을 펼치지 마." 이 화면에 들어오자마자
  // 21개+사용자 태그 전부를 늘어놓지 않고, 이 사용자가 실제로 이미
  // 붙여 본 태그를 먼저 보여준 뒤 나머지는 "더 보기"로 접어 둔다.
  const freq = new Map();
  (foodMap.places || []).forEach((pl) => (pl.tags || []).forEach((t) => freq.set(t, (freq.get(t) || 0) + 1)));
  // 2026-09-11 재검토(11차) — "다른 기기에서 받은 알 수 없는 태그도
  // 편집 화면에서 빠뜨리지 마." A.knownTags(레지스트리)에는 없지만
  // 실제로 어느 장소엔가 이미 붙어 있는 라벨(예: 레지스트리 항목이
  // 아직 동기화되기 전에 장소만 먼저 동기화된 경우)도 놓치지 않고
  // 토글 칩으로 보여준다.
  const known = Array.from(new Set([...A.knownTags, ...freq.keys()]));
  const frequent = known.filter((t) => freq.has(t)).sort((a, b) => (freq.get(b) - freq.get(a)) || a.localeCompare(b));
  const rest = known.filter((t) => !freq.has(t));
  const chipHTML = (t) => `<button data-tag-toggle="${A.esc(t)}" class="${current.has(t) ? 'active' : ''}" aria-pressed="${current.has(t)}">${A.esc(t)}</button>`;
  // 태그 이름 바꾸기·삭제 — 커스텀 태그(사용자가 만든 것)만 삭제
  // 버튼을 보여준다(기본 태그는 이름만 바꿀 수 있고, 이 계정만의
  // 표시명으로 저장된다 — daRenameTag 참고).
  const manageEntries = A.tagEntries.slice().sort((a, b) => a.label.localeCompare(b.label));
  const manageOptionsHTML = manageEntries.map((t) => `<option value="${A.esc(t.label)}" data-source="${A.esc(t.source)}">${A.esc(t.label)}${t.source === 'user' ? ' (내가 만든 태그)' : ''}</option>`).join('');
  open('세부 태그', `<div class="detail"><h2>세부 태그를 골라 주세요</h2><p>${A.esc(p.name)}</p>` +
    `<p class="inline-note">여러 개를 함께 고를 수 있어요(예: 야키토리+이자카야). 자동 추정이 틀렸으면 직접 고치거나 새 태그를 만들 수 있어요.</p>` +
    (frequent.length ? `<p class="inline-note" style="margin-top:10px"><b>${A.esc(A.t('tags.frequent'))}</b></p>` : '') +
    `<div class="filters" id="tagEditChipsFrequent" style="flex-wrap:wrap;overflow:visible">${frequent.map(chipHTML).join('')}</div>` +
    (rest.length ? `<button id="tagsMoreBtn" style="margin-top:10px">${A.esc(A.t('tags.more'))}(${rest.length})</button>` : '') +
    `<div class="filters" id="tagEditChipsMore" hidden style="flex-wrap:wrap;overflow:visible;margin-top:10px">${rest.map(chipHTML).join('')}</div>` +
    `<div style="margin-top:14px;display:flex;gap:8px"><input id="tagsNewInput" placeholder="${A.esc(A.t('tags.newPlaceholder'))}" maxlength="20" style="flex:1"><button id="tagsNewBtn">${A.esc(A.t('tags.add'))}</button></div>` +
    `<button class="primary" id="tagsSaveBtn" style="margin-top:14px">저장</button>` +
    (manageEntries.length ? `<div class="inline-note" style="margin-top:16px"><b>태그 이름 바꾸기 · 삭제</b>` +
      `<select id="tagManageSelect" style="width:100%;margin-top:8px;padding:10px;border-radius:12px;border:1px solid #e5e6e1;font:inherit">${manageOptionsHTML}</select>` +
      `<div style="display:flex;gap:8px;margin-top:8px"><input id="tagRenameInput" placeholder="새 이름" maxlength="20" style="flex:1"><button id="tagRenameBtn">이름 바꾸기</button></div>` +
      `<button class="text-button" id="tagDeleteBtn" style="padding:6px 0;margin-top:4px" hidden>이 태그 삭제(연결된 곳에서만 빠지고, 장소는 안 지워져요)</button></div>` : '') +
    `</div>`);
  const wireChip = (b) => {
    b.onclick = () => {
      const t = b.dataset.tagToggle;
      if (current.has(t)) current.delete(t); else current.add(t);
      b.classList.toggle('active', current.has(t));
      b.setAttribute('aria-pressed', current.has(t));
    };
  };
  $('#tagEditChipsFrequent').querySelectorAll('[data-tag-toggle]').forEach(wireChip);
  $('#tagEditChipsMore').querySelectorAll('[data-tag-toggle]').forEach(wireChip);
  if ($('#tagsMoreBtn')) {
    $('#tagsMoreBtn').onclick = () => { $('#tagEditChipsMore').hidden = false; $('#tagsMoreBtn').hidden = true; };
  }
  $('#tagsNewBtn').onclick = () => {
    const label = A.normalizeTagLabel($('#tagsNewInput').value);
    if (!label) { alert('태그 이름을 확인해 주세요(1~20자, 빈 값 불가).'); return; }
    const r = A.createTag(label);
    if (!r.ok) { alert('태그를 만들지 못했어요.'); return; }
    current.add(r.tag.label);
    // 2026-09-11 재검토(11차) — 저장 실패도 확인하고 되돌린다(성공을
    // 가정하지 않는다). 실패하면 방금 메모리에 만든 태그도 없던 일로
    // 한다 — 화면엔 이미 추가됐는데 실제로는 저장 안 된 상태를 남기지
    // 않기 위해서다.
    const saved = A.saveFoodMap(foodMap);
    if (!saved) {
      foodMap = A.loadFoodMap();
      current.delete(r.tag.label);
      alert('태그를 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');
      return;
    }
    daSyncPushSafe(); // 장소에 아직 안 붙였어도(레지스트리만) 곧바로 다른 기기에 반영되게.
    const btn = document.createElement('button');
    btn.dataset.tagToggle = r.tag.label; btn.className = 'active'; btn.setAttribute('aria-pressed', 'true'); btn.textContent = r.tag.label;
    wireChip(btn);
    $('#tagEditChipsFrequent').appendChild(btn);
    $('#tagsNewInput').value = '';
    if ($('#tagManageSelect')) {
      const opt = document.createElement('option');
      opt.value = r.tag.label; opt.dataset.source = 'user'; opt.textContent = r.tag.label + ' (내가 만든 태그)';
      $('#tagManageSelect').appendChild(opt);
    }
  };
  $('#tagsSaveBtn').onclick = () => finishTagsEdit(id, Array.from(current));
  const manageSelect = $('#tagManageSelect');
  const deleteBtn = $('#tagDeleteBtn');
  const refreshDeleteVisibility = () => {
    if (!manageSelect || !deleteBtn) return;
    const opt = manageSelect.selectedOptions[0];
    deleteBtn.hidden = !opt || opt.dataset.source !== 'user';
  };
  if (manageSelect) {
    manageSelect.onchange = refreshDeleteVisibility;
    refreshDeleteVisibility();
    $('#tagRenameBtn').onclick = () => {
      const oldLabel = manageSelect.value;
      const newLabel = $('#tagRenameInput').value;
      const r = A.renameTag(oldLabel, newLabel, foodMap.places);
      if (!r.ok) {
        alert(r.reason === 'duplicate-label' ? '이미 있는 태그 이름이에요.' : '이름을 바꾸지 못했어요(1~20자, 빈 값 불가).');
        return;
      }
      const saved = A.saveFoodMap(foodMap);
      if (!saved) { foodMap = A.loadFoodMap(); alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.'); return; }
      daSyncPushSafe();
      refreshFromStorage();
      tagsEditSheet(id); // 바뀐 이름이 칩·목록에 바로 보이게 다시 그린다.
    };
    if (deleteBtn) {
      deleteBtn.onclick = () => {
        const label = manageSelect.value;
        const tag = A.findTagByLabel(label);
        if (!tag) return;
        const r = A.deleteCustomTag(tag.id, foodMap.places);
        if (!r.ok) { alert('태그를 삭제하지 못했어요.'); return; }
        const saved = A.saveFoodMap(foodMap);
        if (!saved) { foodMap = A.loadFoodMap(); alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.'); return; }
        daSyncPushSafe();
        refreshFromStorage();
        tagsEditSheet(id);
      };
    }
  }
}
function finishTagsEdit(id, tags) {
  A.setTags(foodMap.places, id, tags);
  const saved = A.saveFoodMap(foodMap);
  if (!saved) {
    foodMap = A.loadFoodMap();
    alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.');
    return;
  }
  daSyncPushSafe();
  refreshFromStorage();
  updateCity();
  detail(id);
}
/* 실제 위치 확인 — 저장된 식별자만으로는 좌표를 못 만든 장소를 서버의
   장소 조회 프록시(/api/places/lookup, server/adapters/place-lookup.mjs)
   로 이름 기반 후보 검색을 해본다(로드맵 ⑦ — 소비자에게 API 키를 요구
   하지 않는다는 원칙대로 클라이언트는 키를 전혀 안 들고 있다). 이름
   검색은 다른 곳을 잘못 짚을 수 있으므로 절대 자동으로 좌표를 덮어쓰지
   않는다 — 반드시 사람이 "맞아요"를 눌러야 반영된다("불확실한 후보
   확인"). 서버가 아직 테스트 어댑터(가짜 좌표)로 도는 상태여도 이
   화면·API 호출 코드 경로 자체는 실제 요청→응답→확인 흐름 그대로다 —
   실 Google Places 키가 연결되면 어댑터만 바뀌고 이 코드는 안 바뀐다. */
async function daLookupCandidateSheet(id) {
  const p = spots.find((x) => x.id === id); if (!p) return;
  /* 2026-09-10 재검토(3차): 장소 조회는 실제 API 비용이 드는 계정별
     한도 대상이라 로그인 없이는 호출할 수 없게 됐다(서버가 401을
     준다) — 화면에서도 로그인부터 하게 안내한다. */
  const token = A.sessionToken(foodMap);
  if (!token) { showLoginSheet(() => daLookupCandidateSheet(id)); return; }
  open('위치 확인', '<div class="detail"><h2>서버에서 후보를 찾는 중…</h2><p>잠시만요.</p></div>');
  const q = [p.name, p.area].filter(Boolean).join(' ').trim() || p.name;
  // area는 동명 장소 판별 힌트로만 쓰인다(2026-09-10 재검토 4차 — 서버가
  // Places API(New)로 여러 후보 중 이 지역과 실제로 맞는 걸 우선한다).
  const areaParam = p.area ? '&area=' + encodeURIComponent(p.area) : '';
  const r = await A.api('/api/places/lookup?q=' + encodeURIComponent(q) + areaParam + '&placeId=' + encodeURIComponent(id), { token });
  if (!r.ok || !r.json || r.json.ok === false || typeof r.json.lat !== 'number') {
    // 2026-09-10 재검토(5차) — "비용 한도 도달을 '못 찾았어요'로
    // 표시하지 말고 원인별로 정확히 안내하라"는 지시 반영. r.ok(HTTP
    // 상태 자체)가 false인 경우는 조회를 시도조차 못 한 상황(한도·예산·
    // 인증)이고, r.ok가 true인데 r.json.ok===false인 경우만 "실제로
    // 찾아봤지만 없었다"는 정직한 not-found다 — 이 둘을 같은 문구로
    //뭉개지 않는다.
    let title = '위치 확인'; let msg;
    const reason = r.json && r.json.reason;
    lastErrorCode = reason || 'lookup-not-found'; // 6-4절 — "불편함 보내기" 최소 진단정보(부분 커버).
    if (!r.ok && reason === 'unauthorized') {
      showLoginSheet(() => daLookupCandidateSheet(id)); return;
    } else if (!r.ok && (reason === 'account-daily-limit-reached')) {
      msg = '오늘 위치 확인을 너무 많이 시도했어요. 내일 다시 시도해 주세요.';
    } else if (!r.ok && reason === 'cost-budget-exceeded') {
      msg = '지금은 위치 확인 서비스 이용 한도에 도달해 잠시 이용할 수 없어요. 나중에 다시 시도해 주세요.';
    } else if (!r.ok && (reason === 'entitlement-place-lookup-limit-reached')) {
      // 2026-09-10 재검토(6차) — 개발 용어(엔타이틀먼트·SKU 등) 없이
      // "이번 이용권에 포함된 위치 확인 횟수를 다 썼다"는 사실만 정직하게.
      msg = '이번 이용권에 포함된 위치 확인 횟수를 모두 사용했어요. 계정 화면에서 남은 횟수를 확인할 수 있어요.';
    } else if (!r.ok && reason === 'entitlement-cost-cap-reached') {
      // 2026-09-10 재검토(7차) 3절 — "이번 이용권으로 처리 가능한 범위를
      // 다 썼다"(내 몫이 소진됨)와 "서비스 전체가 잠시 바쁘다"(운영상
      // 한도)를 구분해서 정확한 사유를 안내한다. 이 문구는 잔여 횟수는
      // 남아 있어도 원가 기준 안전상한에 걸린, 드문 경계 상황용이다.
      msg = '이번 이용권으로 처리할 수 있는 범위를 다 쓰신 것 같아요. 계정 화면에서 남은 횟수를 확인해 주시고, 그런데도 이 안내가 이상하면 문의해 주세요.';
    } else if (!r.ok && reason === 'service-daily-cap-reached') {
      msg = '지금 위치 확인 서비스 전체 이용량이 많아 잠시 제한돼요. 나중에 다시 시도해 주세요.';
    } else if (!r.ok) {
      msg = '지금 위치 확인을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
    } else {
      msg = `<b>${A.esc(p.name)}</b>에 대한 위치 후보를 서버에서 찾지 못했습니다. 구글 지도에서 직접 열어 확인해 주세요.`;
    }
    open(title, `<div class="detail"><h2>${!r.ok ? '지금은 확인할 수 없어요' : '후보를 찾지 못했어요'}</h2><p>${msg}</p><button class="primary" data-dismiss>돌아가기</button></div>`);
    return;
  }
  const cand = r.json;
  // ambiguous: 서버가 여러 후보 중 지역 힌트로 확실히 좁히지 못했다는
  // 뜻 — 자동 반영은 원래부터 안 하지만("맞아요"를 눌러야만 저장), 이
  // 문구로 한 번 더 분명히 확인을 요청한다.
  const ambiguousNote = cand.ambiguous ? ' 이 이름의 장소가 여러 곳 있을 수 있어요 —' : '';
  open('위치 확인', `<div class="detail"><h2>이 위치가 맞나요?</h2><p><b>${A.esc(cand.name || p.name)}</b>${cand.address ? `<br>${A.esc(cand.address)}` : ''}<br>위도 ${cand.lat.toFixed(5)}, 경도 ${cand.lng.toFixed(5)}</p>` +
    `<p class="inline-note">이름으로 찾은 후보일 뿐 확정된 위치가 아닙니다 —${ambiguousNote} 실제로 저장하신 곳이 맞는지 꼭 확인한 뒤에만 저장해 주세요.</p>` +
    `<button class="primary" data-lookup-confirm="${A.esc(id)}|${cand.lat}|${cand.lng}|${A.esc(cand.placeId || '')}|${A.esc((cand.types || []).join(','))}">맞아요 · 이 위치로 저장</button>` +
    `<button class="text-button" data-dismiss>아니에요 · 취소</button></div>`);
}
function finishLookupConfirm(id, lat, lng, placeId, types) {
  const p = foodMap.places.find((x) => x.id === id); if (!p) return;
  p.lat = lat; p.lng = lng;
  if (placeId && !p.placeId) p.placeId = placeId; // 이미 있던 강한 식별자는 절대 안 덮는다(daMerge 규칙과 일관).
  // 2026-09-11 재검토(10차) 5절 — 자동분류 우선순위: 사용자 확정값 >
  // "이미 확보한 신뢰 가능한 장소 유형"(방금 이 확인으로 얻은 공급자의
  // types) > 이름 기반 규칙. 사용자가 이미 직접 고른(catConfirmed/
  // tagsConfirmed=true) 값은 이 확인이 있어도 절대 덮지 않는다.
  if (Array.isArray(types) && types.length) A.applyConfirmedTypes(p, types);
  const saved = A.saveFoodMap(foodMap);
  if (!saved) {
    foodMap = A.loadFoodMap();
    alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.');
    return;
  }
  daSyncPushSafe();
  refreshFromStorage();
  updateCity();
  detail(id);
}
/* 도시 지정 시트 — 여러 곳을 한 번에(다중 선택 뒤 "도시 지정하기"), 또는
   장소 하나만(detail() 의 "이 장소 도시 지정하기"). 좌표를 만들어내지
   않는다 — 목록에서 골라 붙이는 것뿐이라 동선 계산 가능 여부(hasCoords)는
   전혀 안 바뀐다는 걸 여기서도 다시 알린다. */
function cityAssignSheet(ids) {
  if (!ids.length) return;
  const known = A.knownCities;
  const hints = ids.map((id) => spots.find((s) => s.id === id)).filter(Boolean).map((s) => s.cityHint).filter(Boolean);
  const suggested = hints.length ? hints[0] : '';
  open('도시 지정', `<div class="detail"><h2>${ids.length}곳을 어느 도시로 볼까요?</h2>` +
    `<p>목록에서 고르거나 직접 입력하세요. 도시 지정은 화면 정리용입니다 — 좌표가 없으면 최단 동선·거리 계산에는 여전히 쓸 수 없습니다.</p>` +
    (suggested ? `<div class="inline-note">좌표로 보면 <b>${A.esc(suggested)}</b> 근처일 수 있어요(짐작). 맞으면 아래에서 그대로 골라도 됩니다.</div>` : '') +
    `<div class="city-options">${known.map((c) => `<button class="city-option" data-assign-city="${A.esc(c)}"><span class="city-initial">${A.esc(c.slice(0, 1))}</span><span><b>${A.esc(c)}</b></span><span class="city-check">›</span></button>`).join('')}</div>` +
    `<input class="xinput" id="customCityIn" placeholder="목록에 없으면 직접 입력" style="margin-top:10px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit">` +
    `<button class="primary" id="customCityBtn" style="margin-top:10px">이 이름으로 지정</button></div>`);
  $('#sheetContent').querySelectorAll('[data-assign-city]').forEach((b) => {
    b.onclick = () => finishCityAssign(ids, b.dataset.assignCity);
  });
  $('#customCityBtn').onclick = () => {
    const v = $('#customCityIn').value.trim();
    if (v) finishCityAssign(ids, v);
  };
}
function finishCityAssign(ids, cityName) {
  A.assignCity(foodMap.places, ids, cityName);
  const saved = A.saveFoodMap(foodMap);
  if (!saved) {
    /* 저장 실패를 성공처럼 진행하지 않는다. 메모리도 저장소와 다시
       맞춰서, 실패한 변경이 다음 저장에 몰래 섞여 들어가지 않게 한다
       (2026-09-09 코드 검토 — handleRealFile과 동일 패턴). */
    foodMap = A.loadFoodMap();
    alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.');
    return;
  }
  selected.clear(); selecting = false;
  daSyncPushSafe();
  daRunAiClassifyQueueSafe();
  refreshFromStorage();
  city = cityName;
  updateCity();
  sheet.close();
}
/* ── 재방문 여행자 지원 — 여행(trip) 목록·전환 (2026-09-10 재검토 6차
   3절) ────────────────────────────────────────────────────────────────
   서버는 이미 여행을 계정×도시가 아니라 독립된 tripId로 관리한다
   (server/routes/trips.mjs) — 같은 도시로 다시 떠난 여행도 각각 따로
   저장·열람된다. foodMap.trips(동기화로 채워지는 로컬 캐시)와
   foodMap.currentTripByCity(도시별 "지금 보고 있는 여행")로 그 개념을
   화면에 연결한다. 여행이 하나뿐인(가장 흔한, 마이그레이션된 계정
   포함) 경우엔 daCoursesForCity 등 기존 화면 동작이 그대로 유지된다 —
   한 도시에 여행이 실제로 2개 이상일 때만 "지금 여행" 기준으로 좁힌다. */
function tripsForCity(cityName) {
  return (foodMap.trips || []).filter((t) => t.city === cityName).slice()
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
function currentTripForCity(cityName) {
  const list = tripsForCity(cityName);
  if (!list.length) return null;
  foodMap.currentTripByCity = foodMap.currentTripByCity || {};
  const tid = foodMap.currentTripByCity[cityName];
  const found = tid && list.find((t) => t.tripId === tid);
  if (found) return found;
  foodMap.currentTripByCity[cityName] = list[0].tripId;
  return list[0];
}
function tripLabel(t) {
  if (!t) return '';
  if (t.name) return t.name;
  const range = [t.startDate, t.endDate].filter(Boolean).join(' ~ ');
  return t.city + ' 여행' + (range ? ` (${range})` : '');
}
/* "지금 여행" 표시 + 바꾸기·새 여행 만들기 — 오늘 동선 화면과 저장된
   코스 화면 둘 다에서 재사용한다(코스가 이미 있어도 새 여행을 또
   만들 수 있어야 한다 — 지시 3-②). */
function tripBlockHTML(cityName) {
  if (usingSample) return '';
  const trips = tripsForCity(cityName);
  if (!trips.length) return '';
  const cur = currentTripForCity(cityName);
  // 2026-09-11 재검토(11차) — "코스·여행에도 실제 충돌 해결 화면을
  // 연결해. 장소에만 해결 버튼이 있는 상태로 완료 처리하지 마"라는
  // 지시. 여행 정보(이름·날짜·숙소)가 다른 기기와 달라진 채 남아
  // 있으면 이 도시의 어느 화면(오늘 동선·저장된 코스)에서도 보이는
  // 이 블록에 안내와 해결 버튼을 함께 보여준다.
  const conflictHTML = daFieldConflictBlockHTML(cur && cur._fieldConflicts, 'trip-conflict-resolve', cur ? cur.tripId : '');
  return `<div class="inline-note">여행: <b>${A.esc(tripLabel(cur))}</b>` +
    (trips.length > 1 ? ' <button class="text-button" data-trip-switch style="padding:0 8px">바꾸기</button>' : ' ') +
    '<button class="text-button" data-trip-new style="padding:0">새 여행 만들기</button></div>' + conflictHTML;
}
/* 이 도시에 여행이 아예 없으면(완전히 새로운 도시) 코스 생성 전에
   조용히 하나 만든다 — "여행 만들기"를 먼저 누르게 강제하면 기존
   단일 여행 사용자에게 없던 진입 장벽이 생긴다. 원하면 나중에
   tripPickerSheet에서 이름·날짜를 채운 "진짜" 새 여행을 또 만들 수 있다. */
async function ensureTripForCity(cityName) {
  const existing = currentTripForCity(cityName);
  if (existing) return existing;
  const token = A.sessionToken(foodMap);
  if (!token) return null;
  const r = await A.api('/api/trips', { method: 'POST', token, body: { city: cityName } });
  if (!r.ok || !r.json || !r.json.trip) return null;
  foodMap.trips = foodMap.trips || [];
  foodMap.trips.push(r.json.trip);
  foodMap.currentTripByCity = foodMap.currentTripByCity || {};
  foodMap.currentTripByCity[cityName] = r.json.trip.tripId;
  A.saveFoodMap(foodMap);
  return r.json.trip;
}
/* 여행 목록·전환 화면 — 같은 도시라도 서로 다른 여행이면 별도 카드로
   구분해 보여준다(지시 3-①). */
function tripPickerSheet(cityName) {
  const list = tripsForCity(cityName);
  const cur = currentTripForCity(cityName);
  open('여행 선택', `<div class="detail"><h2>${A.esc(cityName)} · 어느 여행인가요?</h2><p>같은 여행지라도 다녀온 시기가 다르면 서로 다른 여행으로 따로 저장돼요. 새 여행을 만들어도 과거 여행은 지워지지 않아요.</p>` +
    `<div class="city-options">${list.map((t) => `<button class="city-option ${cur && cur.tripId === t.tripId ? 'chosen' : ''}" data-trip-choose="${A.esc(t.tripId)}"><span><b>${A.esc(tripLabel(t))}</b>${t.lodging && t.lodging.name ? `<small>${A.esc(t.lodging.name)}</small>` : ''}</span><span class="city-check">${cur && cur.tripId === t.tripId ? '✓' : '›'}</span></button>`).join('')}</div>` +
    `<button class="primary" data-trip-new>새 여행 만들기</button><button class="text-button" data-dismiss>돌아가기</button></div>`);
}
/* 이 여행의 저장된 코스를 서버에서 받아 로컬에 반영한다 — 다른 기기가
   만든 여행으로 전환할 때도(로컬엔 아직 그 여행 코스가 없을 수 있다)
   날짜 탭이 비어 보이지 않게 한다. */
async function daSyncTripCourses(tripId) {
  const token = A.sessionToken(foodMap);
  if (!token) return;
  const r = await A.api('/api/trips/' + encodeURIComponent(tripId) + '/courses', { token });
  if (!r.ok || !r.json || !Array.isArray(r.json.courses)) return;
  foodMap.courses = foodMap.courses || [];
  r.json.courses.forEach((sc) => {
    const idx = foodMap.courses.findIndex((c) => c.tripId === tripId && c.date === sc.date);
    const entry = { ...sc, tripId };
    if (idx >= 0) foodMap.courses[idx] = entry; else foodMap.courses.push(entry);
  });
  A.saveFoodMap(foodMap);
}
function chooseTrip(cityName, tripId) {
  foodMap.currentTripByCity = foodMap.currentTripByCity || {};
  foodMap.currentTripByCity[cityName] = tripId;
  A.saveFoodMap(foodMap);
  route.clear(); // 다른 여행으로 바꾸면 "오늘 동선"은 그 여행 것으로 다시 고른다(다른 여행에 담긴 곳과 안 섞이게).
  daSyncTripCourses(tripId).then(() => { city = cityName; updateCity(); showRoute(); });
}
/* 새 여행 만들기 — 이름·날짜·숙소는 전부 선택 입력(비워도 여행은
   만들어진다). "여행지 선택"(도시 전환)과 뚜렷이 구분되도록, 새 여행을
   만들어도 과거 여행이 사라지지 않는다는 걸 여기서 분명히 알린다. */
function newTripFormSheet(cityName) {
  open('새 여행 만들기', `<div class="detail"><h2>${A.esc(cityName)}(으)로 새 여행을 만들까요?</h2><p>과거에 만든 여행은 사라지지 않고 그대로 남아요 — 이번 여행 기록만 새로 시작합니다.</p>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">여행 이름(선택)<input class="xinput" id="tripName" placeholder="예: 2번째 후쿠오카 여행" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">시작일(선택)<input class="xinput" id="tripStart" type="date" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">종료일(선택)<input class="xinput" id="tripEnd" type="date" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">숙소 이름(선택)<input class="xinput" id="tripLodging" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<button class="primary" id="tripCreateBtn" style="margin-top:10px">이 여행 만들기</button><p class="inline-note" id="tripMsg" hidden></p></div>`);
  const msg = (t2) => { const el = $('#tripMsg'); el.textContent = t2; el.hidden = false; };
  $('#tripCreateBtn').onclick = async () => {
    const token = A.sessionToken(foodMap);
    if (!token) { showLoginSheet(() => newTripFormSheet(cityName)); return; }
    const btn = $('#tripCreateBtn'); btn.disabled = true; btn.textContent = '만드는 중…';
    const name = $('#tripName').value.trim();
    const startDate = $('#tripStart').value || undefined;
    const endDate = $('#tripEnd').value || undefined;
    const lodgingName = $('#tripLodging').value.trim();
    const r = await A.api('/api/trips', { method: 'POST', token, body: { city: cityName, name: name || undefined, startDate, endDate, lodging: lodgingName ? { name: lodgingName } : undefined } });
    if (!r.ok || !r.json || !r.json.trip) { btn.disabled = false; btn.textContent = '이 여행 만들기'; msg('여행을 만들지 못했어요. 잠시 후 다시 시도해 주세요.'); return; }
    foodMap.trips = foodMap.trips || [];
    foodMap.trips.push(r.json.trip);
    foodMap.currentTripByCity = foodMap.currentTripByCity || {};
    foodMap.currentTripByCity[cityName] = r.json.trip.tripId;
    A.saveFoodMap(foodMap);
    route.clear();
    daSyncPushSafe();
    city = cityName;
    updateCity();
    showRoute();
  };
}
/* 다음 여행 코스 후보 이월(지시 3-④) — 새 화면을 따로 만들지 않고
   기존 "오늘 동선" 화면에 이월 후보 목록만 얹는다. 같은 도시의 다른
   여행에서 아직 방문하지 못한 곳(서버가 미방문 우선으로 정렬)을
   보여줄 뿐, 절대 자동으로 담지 않는다 — 사람이 "담기"를 눌러야 오늘
   동선(route)에 들어간다(사용자의 명시적 선택은 항상 그대로 존중되고,
   이 목록은 그저 참고용 제안일 뿐이라는 서버 쪽 설계와 같은 원칙). */
let daCarryList = null;
async function carryForwardSheet(cityName) {
  const cur = currentTripForCity(cityName);
  const others = tripsForCity(cityName).filter((t) => !cur || t.tripId !== cur.tripId);
  const fromTripId = others[0] && others[0].tripId;
  if (!fromTripId) return;
  const token = A.sessionToken(foodMap);
  if (!token) { showLoginSheet(() => carryForwardSheet(cityName)); return; }
  open('이어가기', '<div class="detail"><h2>지난 여행 기록을 살펴보는 중…</h2></div>');
  const r = await A.api('/api/trips/next-suggestions?fromTripId=' + encodeURIComponent(fromTripId), { token });
  if (!r.ok || !r.json || !Array.isArray(r.json.suggestions) || !r.json.suggestions.length) {
    open('이어가기', '<div class="detail"><h2>이어갈 만한 지난 기록이 없어요.</h2><p>지난 여행에서 담아 둔 곳을 이미 모두 방문했거나, 저장된 장소가 없어요.</p><button class="primary" data-dismiss>돌아가기</button></div>');
    return;
  }
  daCarryList = r.json.suggestions.filter((s) => s.place).slice(0, 30);
  open('이어가기', `<div class="detail"><h2>지난 여행에서 담아 둔 곳</h2><p>아직 안 가본 곳을 먼저 보여드려요. 다시 가고 싶은 곳도 함께 있어요.</p>` +
    daCarryList.map((s) => `<div class="route-row"><span>${s.wantRevisit ? '♥' : (s.visited ? '✓' : '·')}</span><div><b>${A.esc((s.place && s.place.name) || '')}</b><p>${s.visited ? (s.wantRevisit ? '방문함 · 다시 가고 싶어요' : '방문함') : '미방문'}</p></div><button data-carry-add="${A.esc(s.placeId)}" aria-label="${A.esc((s.place && s.place.name) || '')} 오늘 동선에 담기">＋</button></div>`).join('') +
    `<button class="primary" data-carry-add-all>전부 담기</button><button class="text-button" data-dismiss>돌아가기</button></div>`);
}
function carryAdd(placeId) { route.add(placeId); }
function carryAddAll() { (daCarryList || []).forEach((s) => route.add(s.placeId)); daCarryList = null; }

/* ── 재방문 여행자 지원 — 방문 기록(지시 3-③) ────────────────────────
   코스에 담는 것과 방문 표시는 서로 다른 버튼이다(자동 방문처리
   금지 — 서버 쪽도 course-generation.mjs가 visits.mjs를 아예 안
   부르는 방식으로 이걸 구조적으로 지킨다). */
function visitFor(placeId) {
  return (foodMap.visits || []).find((x) => x.placeId === placeId) || { placeId, visited: false, wantRevisit: false, visitedDates: [], notes: '' };
}
function visitBlockHTML(id) {
  if (usingSample) return '';
  const v = visitFor(id);
  const datesHTML = v.visitedDates.length
    ? `<p class="xsmall">방문한 날: ${v.visitedDates.map((d) => A.esc(d.date)).join(', ')}</p>`
    : '<p class="xsmall">아직 방문 기록이 없어요.</p>';
  return `<div class="inline-note">${datesHTML}` +
    `<button class="text-button" data-visit-mark="${id}" style="padding:6px 8px 6px 0">오늘 날짜로 방문 완료 표시</button>` +
    (v.visitedDates.length ? `<button class="text-button" data-visit-unmark="${id}" style="padding:6px 8px">마지막 방문 취소</button>` : '') +
    `<button class="text-button" data-visit-want="${id}" style="padding:6px 8px">${v.wantRevisit ? '다시 가고 싶음 ✓ (해제)' : '다시 가고 싶어요'}</button>` +
    `<label class="xsmall" style="display:block;margin-top:8px">메모<textarea id="visitNotes_${id}" class="xinput" style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:12px;border:1px solid #e5e6e1;font:inherit;margin-top:4px" rows="2">${A.esc(v.notes || '')}</textarea></label>` +
    `<button class="text-button" data-visit-notes="${id}" style="padding:6px 0">메모 저장</button></div>`;
}
async function visitAction(placeId, action, extra) {
  const token = A.sessionToken(foodMap);
  if (!token) { showLoginSheet(() => visitAction(placeId, action, extra)); return; }
  let body = {};
  if (action === 'mark') { const t = currentTripForCity(city); body = { tripId: t ? t.tripId : undefined }; }
  else if (action === 'want-revisit') body = { wantRevisit: !visitFor(placeId).wantRevisit };
  else if (action === 'notes') body = { notes: extra };
  const r = await A.api('/api/visits/' + encodeURIComponent(placeId) + '/' + action, { method: 'POST', token, body });
  if (r.ok && r.json && r.json.visit) {
    foodMap.visits = foodMap.visits || [];
    const idx = foodMap.visits.findIndex((x) => x.placeId === placeId);
    if (idx >= 0) foodMap.visits[idx] = r.json.visit; else foodMap.visits.push(r.json.visit);
    A.saveFoodMap(foodMap);
    // 6-4절 — 가입~피드백 퍼널의 "실사용" 단계 신호. 실제로 방문 완료
    // 표시를 한 순간만 기록한다(장소명 등은 안 실음).
    if (action === 'mark') daTrackSafe('place_visited', {});
  }
  daSyncPushSafe();
  // 방문 상태 필터·목록 정렬은 뒤에 있는 화면(#grid)이 근거로 삼는다 —
  // 시트를 닫기 전까진 그 화면이 안 보이지만, 지금 다시 그려 둬야
  // 닫는 순간 방문 상태 필터가 바로 나타나거나 갱신된다(2026-09-10
  // 재검토 6차 3-③ — finishCatAssign 등 기존 패턴과 동일하게 처리).
  updateCity();
  detail(placeId);
}
function visitStatusFor(id) {
  const v = visitFor(id);
  if (v.wantRevisit) return '다시가고싶음';
  return v.visited ? '방문함' : '미방문';
}

/* 실제 코스 생성(로드맵 ⑥). "오늘 동선"에 담아 둔 곳이 있으면 실제로
   방문 순서·이동시간을 만들 수 있게 하고, 이미 만들어 둔 코스가 있으면
   그걸 보여준다(새로고침해도 foodMap.course에 저장돼 있어 유지된다). */
function showRoute() {
  /* 2026-09-09 코드 검토(2차): 저장된 코스가 있어도 그게 "지금 보고 있는
     도시"의 코스가 아니면 그대로 보여주면 안 된다 — 도시를 바꿨는데 예전
     도시에서 짠 코스가 마치 지금 도시 코스처럼 뜨는 걸 막는다(과거엔
     course에 city를 저장하지 않아 구분할 방법이 아예 없었다). city가
     없는 예전 저장분(마이그레이션 이전)은 구분할 근거가 없어 그대로
     보여준다 — 새로 만들면 이번 수정으로 city가 붙는다. */
  /* 2026-09-10(멀티데이): foodMap.course는 "마지막으로 본 코스"일 뿐이라,
     도시를 바꿨다 돌아오면 다른 도시 걸 마지막으로 봤을 수 있다 — 이
     도시에 저장된 날짜 목록(daCoursesForCity)에서 직접 찾아야 도시를
     오가도 그 도시의 저장된 코스를 정확히 다시 보여줄 수 있다. */
  const cityCourses = daCoursesForCity(city);
  if (cityCourses.length) {
    const curTrip = usingSample ? null : currentTripForCity(city);
    if (!foodMap.course || foodMap.course.city !== city || (curTrip && foodMap.course.tripId && foodMap.course.tripId !== curTrip.tripId)) {
      foodMap.course = cityCourses[cityCourses.length - 1];
    }
    showSavedCourse();
    return;
  }
  const list = spots.filter((p) => p.city === city && route.has(p.id));
  // 2026-09-10 재검토(5차) — "배치 조회 서버 기능은 있지만 화면 연결이
  // 안 됐다"는 지적 반영. 오늘 동선에 담은 곳 중 위치가 아직 불확실한
  // 곳이 있으면, 장소마다 상세를 열어 하나씩 누르는 대신 여기서 한
  // 번에 확인할 수 있게 한다(실제 코스 후보로 좁혀진 상태에서만
  // 묶어서 조회 — 가져오기 직후 전체를 조회하는 게 아니다).
  const needLookupList = list.filter((p) => p.needsLookup);
  // 2026-09-10 재검토(6차) 3-①②④ — 여행 목록/전환, 새 여행 만들기,
  // 다음 여행 이월 후보를 전부 이 "오늘 동선" 화면 하나에 얹는다(첫
  // 화면 설정을 늘리지 않는다는 지시대로 새 화면을 만들지 않는다).
  const trips = usingSample ? [] : tripsForCity(city);
  const carryBlock = (!usingSample && !list.length && trips.length > 1) ? '<button class="text-button" data-carry-forward>지난 여행에서 담아 둔 곳 이어가기 ↗</button>' : '';
  // 2026-09-10 재검토(7차) 4절 — 착장 판단용 날씨 카드를 화면 맨 위에
  // 얹는다. 코스·동선 기능(메인 내용)을 먼저 그린 뒤 날씨는 비동기로
  // 채운다(loadWeatherCard는 await 안 함 — 늦어도 화면 사용에 지장 없음).
  open(city + ' · 오늘 동선', `${window.WeatherCard.skeletonHTML(city)}${window.StreetVideo.buttonHTML(city)}<div class="detail"><h2>오늘은 이곳으로.</h2>${tripBlockHTML(city)}<p>${list.length ? '담아 둔 ' + list.length + '곳을 확인하세요.' : '마음에 드는 장소를 먼저 골라보세요.'}</p>${carryBlock}${list.map((p, i) => `<div class="route-row"><span>${i + 1}</span>${photoHTML(p, '')}<div><b>${A.esc(p.name)}</b><p>${A.esc(p.area)}</p></div><button data-remove="${p.id}" aria-label="${A.esc(p.name)} 동선에서 빼기">×</button></div>`).join('')}${needLookupList.length ? `<button class="text-button" data-batch-lookup>위치 미확인 ${needLookupList.length}곳 한번에 확인하기 ↗</button>` : ''}${list.length ? '<button class="primary" data-build-course>코스 만들기 ↗</button>' : ''}<button class="text-button" data-dismiss>스팟 더 고르기</button></div>`);
  window.WeatherCard.loadWeatherCard(A, city, spots);
}

/* 일괄 위치 확인 — /api/places/lookup-batch를 실제로 화면에 연결한다
   (2026-09-10 재검토 5차: "배치 서버 구현과 사용자가 편하게 쓰는 화면
   구현을 구분하라" — 이 함수가 그 화면 쪽이다). 단일 조회
   (daLookupCandidateSheet)와 같은 원칙을 그대로 따른다: 절대 자동으로
   좌표를 확정하지 않고, 후보마다 사람이 직접 "맞아요"를 눌러야
   반영된다 — 여러 곳을 한 번에 "물어보기"만 묶었을 뿐, "확정"은 여전히
   한 곳씩 사람이 한다. */
let daBatchQueue = null;
async function daBatchLookupFlow() {
  const token = A.sessionToken(foodMap);
  if (!token) { showLoginSheet(() => daBatchLookupFlow()); return; }
  const list = spots.filter((p) => p.city === city && route.has(p.id) && p.needsLookup);
  if (!list.length) return;
  open('위치 확인', `<div class="detail"><h2>${list.length}곳의 후보를 한번에 찾는 중…</h2><p>잠시만요.</p></div>`);
  const items = list.map((p) => ({ id: p.id, query: [p.name, p.area].filter(Boolean).join(' ').trim() || p.name, expectedArea: p.area || undefined }));
  const r = await A.api('/api/places/lookup-batch', { method: 'POST', token, body: { items } });
  if (!r.ok || !r.json || r.json.ok === false) {
    const reason = r.json && r.json.reason;
    let msg = '지금 위치를 한번에 확인하지 못했어요. 잠시 후 다시 시도해 주세요.';
    if (reason === 'account-daily-limit-reached') msg = '오늘 위치 확인을 너무 많이 시도했어요. 내일 다시 시도해 주세요.';
    else if (reason === 'entitlement-place-lookup-limit-reached') msg = '이번 이용권에 포함된 위치 확인 횟수를 모두 사용했어요. 계정 화면에서 남은 횟수를 확인할 수 있어요.';
    else if (reason === 'cost-budget-exceeded' || reason === 'service-daily-cap-reached') msg = '지금은 위치 확인 서비스 이용 한도에 도달해 잠시 이용할 수 없어요. 나중에 다시 시도해 주세요.';
    open('위치 확인', `<div class="detail"><h2>지금은 확인할 수 없어요</h2><p>${msg}</p><button class="primary" data-dismiss>돌아가기</button></div>`);
    return;
  }
  const results = r.json.results || [];
  const foundQueue = results.filter((x) => x.ok && x.result && x.result.ok && typeof x.result.lat === 'number');
  const notFoundCount = results.length - foundQueue.length;
  daBatchQueue = { items: foundQueue, idx: 0, notFoundCount, truncated: r.json.truncated, skippedCount: (r.json.skipped || []).length };
  daShowBatchQueueStep();
}
function daShowBatchQueueStep() {
  if (!daBatchQueue) return;
  const { items, idx, notFoundCount, truncated, skippedCount } = daBatchQueue;
  if (idx >= items.length) {
    let note = `${items.length}곳 확인을 마쳤어요.`;
    if (notFoundCount) note += ` ${notFoundCount}곳은 후보를 찾지 못했어요.`;
    if (truncated) note += ` 한 번에 담을 수 있는 개수를 넘어 ${skippedCount}곳은 이번에 확인하지 못했어요 — 동선을 좁혀 다시 시도해 주세요.`;
    open('위치 확인', `<div class="detail"><h2>확인이 끝났어요</h2><p>${A.esc(note)}</p><button class="primary" data-dismiss>돌아가기</button></div>`);
    daBatchQueue = null;
    return;
  }
  const item = items[idx];
  const p = foodMap.places.find((x) => x.id === item.id);
  const cand = item.result;
  const ambiguousNote = cand.ambiguous ? ' 이 이름의 장소가 여러 곳 있을 수 있어요 —' : '';
  open(`위치 확인 (${idx + 1}/${items.length})`, `<div class="detail"><h2>이 위치가 맞나요?</h2><p><b>${A.esc(cand.name || (p && p.name) || '')}</b>${cand.address ? `<br>${A.esc(cand.address)}` : ''}<br>위도 ${cand.lat.toFixed(5)}, 경도 ${cand.lng.toFixed(5)}</p>` +
    `<p class="inline-note">이름으로 찾은 후보일 뿐 확정된 위치가 아닙니다 —${ambiguousNote} 실제로 저장하신 곳이 맞는지 꼭 확인한 뒤에만 저장해 주세요.</p>` +
    `<button class="primary" data-batch-confirm="${A.esc(item.id)}|${cand.lat}|${cand.lng}|${A.esc(cand.placeId || '')}|${A.esc((cand.types || []).join(','))}">맞아요 · 이 위치로 저장</button>` +
    `<button class="text-button" data-batch-skip>건너뛰기</button></div>`);
}
/* ── 짧은 구매 흐름(로드맵 ⑨) ────────────────────────────────────────
   샘플 체험(로그인 없음) → 가져오기 → 로그인 → 개인화 코스 1회 무료 →
   (더 필요할 때만) 이용권 제시 → 결제 → 원래 코스로 복귀.
   2026-09-10 재검토(3차): 개인화 코스 생성은 서버가 인증→이용권/체험
   확인→생성→저장까지 전부 집행한다(course-generation.mjs) — "이미
   코스를 만들어 봤는지"로 로컬에서 미리 짐작해 게이트를 여닫던 예전
   방식은 없앴다. 열람(저장된 코스 다시 보기·날짜 탭 전환)은 게이트를
   아예 안 탄다는 점은 그대로다("만료 후에도 기존 장소와 코스 열람
   유지"). */

/* ── 여러 날짜 일정(로드맵 ⑫ — 유료: "여러 날짜 일정 정리") ──────────
   2026-09-10 확정 사업 방향: 무료는 "개인화 코스 생성 성공 1회"까지고,
   그 이후의 "추가 코스 생성·조건 변경 후 재계산·여러 날짜 일정 정리"는
   전부 유료다. 예전엔 도시당 코스를 딱 하나(foodMap.course)만 저장할
   수 있어서 여러 날짜를 아예 나눠 담을 수 없었다 — foodMap.courses
   배열로 도시+날짜별 코스를 각각 저장하게 넓혔다.

   foodMap.course는 그대로 "지금 보고 있는 코스"를 가리키는 포인터로
   남겨 둔다(기존 코드·테스트가 전부 foodMap.course를 직접 본다 —
   여기서 새로 뭘 지어내는 대신 foodMap.courses에도 같이 반영만
   추가한다). 실제 생성·저장은 언제나 daGateThenBuildCourseSheet를
   거치므로(추가 날짜든, 기존 날짜 재계산이든) "1회 무료, 그 다음은
   유료"라는 규칙이 두 경우 모두에 자동으로 적용된다 — 별도로 나눠
   구현할 필요가 없다. */
function daUpsertCourse(entry) {
  foodMap.courses = foodMap.courses || [];
  const idx = foodMap.courses.findIndex((c) => c.city === entry.city && c.date === entry.date && c.tripId === entry.tripId);
  if (idx >= 0) foodMap.courses[idx] = entry; else foodMap.courses.push(entry);
  foodMap.course = entry;
}
/* 예전 데이터(foodMap.courses가 아직 없던 시절 저장분)와도 호환되도록,
   courses 배열이 비어 있어도 foodMap.course가 이 도시 것이면 최소
   1개짜리 목록으로 봐준다 — 별도 마이그레이션 스크립트 없이도 기존
   저장 데이터가 갑자기 "날짜가 하나도 없는" 것처럼 보이지 않는다.
   2026-09-10 재검토(6차) 3-① — 이 도시에 여행이 실제로 2개 이상일
   때만 "지금 보고 있는 여행" 기준으로 좁힌다(여행이 하나뿐이면 예전과
   완전히 같은 동작 — tripId가 애초에 전부 같거나 없어서 필터링 효과가
   없다). */
function daCoursesForCity(cityName) {
  let list = (foodMap.courses || []).filter((c) => c.city === cityName);
  const trips = tripsForCity(cityName);
  const cur = trips.length > 1 ? currentTripForCity(cityName) : null;
  if (cur) list = list.filter((c) => c.tripId === cur.tripId);
  // 여행이 하나뿐일 때만 예전 저장분(foodMap.course, tripId 개념이 아직
  // 없던 시절) 호환용 대체 목록을 쓴다 — 여행이 실제로 2개 이상이면
  // "지금 여행" 필터링 결과가 곧 정답이라, 다른 여행의 마지막 코스
  // 포인터(foodMap.course)가 여기 몰래 되살아나면 안 된다(3-① 핵심).
  if (!cur && !list.length && foodMap.course && foodMap.course.city === cityName && Array.isArray(foodMap.course.stops) && foodMap.course.stops.length) {
    list = [foodMap.course];
  }
  return list.slice().sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0));
}
function daNextDay(cityName) {
  const days = daCoursesForCity(cityName);
  const base = (days.length && days[days.length - 1].date) || A.destNow(cityName).ymd;
  const dt = new Date(base + 'T00:00:00');
  dt.setDate(dt.getDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/* "코스 만들기"를 실제로 누르기 전에 통과해야 하는 문.
   2026-09-10 재검토(3차) — "샘플은 로그인 없이, 실제 개인화 무료
   코스는 간편 로그인 후 제공하라": 예전엔 로그인 전에도 첫 코스를
   그냥 만들 수 있었다(브라우저에서 직접 계산하고 서버엔 나중에만
   알렸다). 이제 개인화 코스 생성 자체가 서버 라우트(POST
   /api/course/generate)로 옮겨갔고, 그 라우트는 인증을 요구한다 —
   그래서 샘플이 아닌 이상 로그인부터 확인한다.

   무료체험/이용권 여부는 여기서 미리 서버에 물어보지 않는다 —
   그 판정은 실제 생성 시도 때 서버가 단 한 곳(course-generation.mjs)
   에서만 내린다(로컬에서 미리 짐작한 상태가 서버 판정과 어긋나는
   경쟁 상황을 없앤다). 실제 생성 요청이 402(결제 필요)로 돌아오면
   그때 runCourseGeneration이 이용권 화면을 띄운다. */
async function daGateThenBuildCourseSheet(opts) {
  if (usingSample) { buildCourseSheet(opts); return; }
  const token = A.sessionToken(foodMap);
  if (!token) { showLoginSheet(() => daGateThenBuildCourseSheet(opts)); return; }
  buildCourseSheet(opts);
}

/* 로그인 — 이메일 + 매직 코드(비밀번호 없음). 성공하면 onSuccess를
   이어서 부른다(원래 하려던 동작을 로그인 때문에 처음부터 다시
   누르게 하지 않는다). */
function showLoginSheet(onSuccess) {
  open('로그인', `<div class="detail"><h2>이메일로 계속하기</h2><p>비밀번호 없이, 이메일로 받은 코드로 로그인해요.</p>` +
    `<input class="xinput" id="loginEmail" type="email" placeholder="이메일 주소" style="width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit">` +
    `<button class="primary" id="loginSendBtn" style="margin-top:10px">코드 받기</button>` +
    `<p class="inline-note" id="loginMsg" hidden></p></div>`);
  const msg = (t2) => { const el = $('#loginMsg'); el.textContent = t2; el.hidden = false; };
  $('#loginSendBtn').onclick = async () => {
    const email = $('#loginEmail').value.trim();
    if (!email) { msg('이메일을 입력해 주세요.'); return; }
    const r = await A.api('/api/auth/request-code', { method: 'POST', body: { email } });
    if (!r.ok) { msg('코드를 보내지 못했어요. 이메일 주소를 확인해 주세요.'); return; }
    showLoginCodeSheet(email, onSuccess);
  };
}
function showLoginCodeSheet(email, onSuccess) {
  // 6-4절 — 초대 코드는 평소엔 아무 의미가 없다(서버가 요구하지 않는
  // 한 그냥 무시된다). 서버가 실제로 소규모 베타 모집을 켰을 때만
  // (config.requireInviteCodeForSignup) 신규 가입에서 필요해지고, 그때
  // 서버가 정확한 사유(invite-code-required 등)를 돌려주면 이 입력칸을
  // 강조해서 다시 시도하게 안내한다.
  open('코드 확인', `<div class="detail"><h2>이메일로 받은 코드를 입력하세요</h2><p>${A.esc(email)}로 6자리 코드를 보냈어요.</p>` +
    `<input class="xinput" id="loginCode" inputmode="numeric" placeholder="6자리 코드" style="width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit">` +
    `<input class="xinput" id="loginInviteCode" placeholder="초대 코드(안내받은 경우에만)" style="margin-top:8px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit">` +
    `<button class="primary" id="loginVerifyBtn" style="margin-top:10px">확인</button>` +
    `<p class="inline-note" id="loginMsg" hidden></p></div>`);
  const msg = (t2) => { const el = $('#loginMsg'); el.textContent = t2; el.hidden = false; };
  $('#loginVerifyBtn').onclick = async () => {
    const code = $('#loginCode').value.trim();
    const inviteCode = $('#loginInviteCode').value.trim();
    const btn = $('#loginVerifyBtn');
    btn.disabled = true; btn.textContent = '확인 중…';
    const r = await A.api('/api/auth/verify-code', { method: 'POST', body: { email, code, inviteCode: inviteCode || undefined } });
    if (!r.ok || !r.json || !r.json.token) {
      btn.disabled = false; btn.textContent = '확인';
      const reasonMsg = {
        locked: '시도 횟수를 너무 많이 넘겨 잠시 후 다시 시도해 주세요.',
        'invite-code-required': '지금은 초대 코드가 있어야 새로 가입할 수 있어요. 안내받은 코드를 위 칸에 입력해 주세요.',
        'invite-code-invalid': '초대 코드가 올바르지 않아요. 다시 확인해 주세요.',
        'invite-code-expired': '이 초대 코드는 기간이 지났어요. 새 코드를 요청해 주세요.',
        'invite-code-exhausted': '이 초대 코드는 이미 정원이 다 찼어요. 새 코드를 요청해 주세요.',
        'recruitment-cap-reached': '지금은 신청 가능한 인원이 다 찼어요. 나중에 다시 시도해 주세요.',
        'recruitment-paused': '지금은 잠시 신규 가입을 받지 않고 있어요. 나중에 다시 시도해 주세요.',
      }[r.json && r.json.reason];
      msg(reasonMsg || '코드가 맞지 않거나 만료됐어요. 다시 시도해 주세요.');
      return;
    }
    // 2026-09-10 재검토(7차) — 로그인마다 세대(epoch)를 올려, 이전
    // 계정(또는 로그인 전 손님 상태)에서 걸려 있던 늦은 응답이 지금
    // 막 로그인한 계정 화면에 섞이지 않게 막는다(daSyncPush/
    // daSyncPullAndMerge의 세대 확인 참고).
    sessionEpoch++;
    foodMap.session = { token: r.json.token, email };
    A.saveFoodMap(foodMap);
    if (r.json.isNew) daTrackSafe('signup_completed', {});
    /* 2026-09-10 재검토(3차): 개인화 코스 생성 자체가 이제 로그인
       뒤에만 가능해졌으므로(daGateThenBuildCourseSheet 참고), "로그인
       전에 만든 코스의 무료체험을 서버에 뒤늦게 알리는" 예전 문제는
       더 이상 생기지 않는다 — 대신 이 기기에 있던 손님 데이터(장소·
       코스)를 계정과 동기화한다(비회원 데이터 보존 + 다른 기기 데이터
       병합). */
    await daSyncPullAndMerge(r.json.token);
    // 2026-09-11 재검토(10차) 7절 — 이 계정이 서버 승인 테스트 계정인지
    // 로그인 때마다 다시 물어본다(예전처럼 URL 파라미터로 브라우저에
    // 영구히 남지 않는다 — 관리자가 나중에 권한을 빼면 다음 로그인부터
    // 바로 반영된다).
    A.refreshTestAccess(r.json.token);
    refreshFromStorage();
    updateCity();
    onSuccess();
  };
}
/* 이용권 제시 — 금액·기간·자동결제 여부를 분명히 보여준다.
 *
 * 2026-09-10 재검토(3차) — 실제 토스페이먼츠 연동 코드를 추가했다.
 * **이 세션은 결제창 SDK가 실제로 뜨는지 검증하지 못한다** — 실
 * 클라이언트 키가 없고, 이 샌드박스는 js.tosspayments.com 같은 외부
 * 스크립트 도메인도 정책상 막혀 있을 가능성이 높다(공식 문서 접속
 * 자체가 막혔던 것과 같은 제약). 그래서 실제 결제창 코드(SDK 로드 →
 * 위젯 렌더 → requestPayment로 결제창 이동)는 작성해 뒀지만 ④(실제
 * 키로 확인 필요)로 분류한다 — RELEASE_STATUS.md 참고.
 *
 * `/api/payment/config`가 결제 서비스를 real로 보고하면(실제 토스
 * 클라이언트 키가 서버에 설정된 경우) 이 실제 흐름을 쓰고, 그렇지
 * 않으면(지금 이 샌드박스처럼 키가 없는 개발/테스트 환경) 예전과 같은
 * 개발용 시뮬레이션으로 자동 대체한다 — 두 경로 다 실제 서버의
 * handleWebhook/confirmPayment 코드를 그대로 탄다(클라이언트가 "결제
 * 했다"고 스스로 선언하지 않는다는 원칙은 두 경로 모두 지킨다). */
function showPaywallSheet(price, opts) {
  const p = price || { amountKrw: 9900, periodDays: 30, autoRenew: false, includedPlaceLookups: 50, includedCourseGenerations: 30 };
  // 2026-09-10 재검토(6차) — "구매 화면에 가격·기간·자동갱신 여부·포함
  // 사용량을 간단히 표시하라"는 지시. API/SKU 같은 개발 용어 없이,
  // 사람이 바로 이해할 수 있는 말로만 적는다.
  const usageNote = (p.includedPlaceLookups && p.includedCourseGenerations)
    ? `<br>포함 사용량: 새로운 장소 위치 확인 최대 ${p.includedPlaceLookups}곳, 코스 생성·재계산 최대 ${p.includedCourseGenerations}회`
    : '';
  open('이용권', `<div class="detail"><h2>더 만들려면 이용권이 필요해요</h2>` +
    `<p>무료 체험(코스 1회)은 이미 쓰셨어요. 계속 이용하시려면 아래 이용권을 확인해 주세요.</p>` +
    `<div class="inline-note"><b>${p.amountKrw.toLocaleString()}원</b> / ${p.periodDays}일<br>자동결제: ${p.autoRenew ? '켜짐(직접 해지 전까지 자동으로 갱신)' : '꺼짐(자동으로 다시 결제되지 않음)'}${usageNote}</div>` +
    `<div id="tossPaymentMethods"></div>` +
    `<button class="primary" id="payBtn" style="margin-top:10px">결제하기</button>` +
    `<button class="text-button" data-dismiss>다음에 할게요</button></div>`);
  $('#payBtn').onclick = async () => {
    const btn = $('#payBtn');
    btn.disabled = true; btn.textContent = '처리 중…';
    daTrackSafe('payment_started', { amount_krw: p.amountKrw, period_days: p.periodDays });
    const token = A.sessionToken(foodMap);
    const cfg = await A.api('/api/payment/config');
    try {
      if (cfg.ok && cfg.json && cfg.json.clientKey) {
        await daRunRealTossPayment(token, cfg.json, opts);
      } else {
        await daRunDevSimulatedPayment(token, opts);
      }
    } finally {
      btn.disabled = false; btn.textContent = '결제하기';
    }
  };
}
/* 개발/테스트 결제 — 서버가 스스로 서명한 가짜 웹훅을 실제
   handleWebhook()에 흘려보낸다(server/routes/dev.mjs). production에는
   이 엔드포인트 자체가 없다(server/index.mjs). */
async function daRunDevSimulatedPayment(token, opts) {
  const r = await A.api('/api/dev/simulate-payment', { method: 'POST', token, body: { outcome: 'success' } });
  if (!r.ok) { daTrackSafe('payment_result', { result: 'failure' }); alert('결제를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'); return; }
  daTrackSafe('payment_result', { result: 'success' });
  // 결제 성공 뒤에는 원래 하려던 동작(코스 새로 만들기 또는 새 날짜
  // 추가)으로 그대로 이어간다 — opts를 잃어버리면 날짜가 원래 의도와
  // 다르게(예: 재계산하려던 날짜가 아니라 오늘 날짜로) 만들어진다.
  buildCourseSheet(opts);
}
function daLoadTossSdk() {
  return new Promise((resolve, reject) => {
    if (window.TossPayments) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://js.tosspayments.com/v2/standard';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('toss-sdk-load-failed'));
    document.head.appendChild(s);
  });
}
/* 실제 토스페이먼츠 결제위젯 — 서버가 먼저 만들어 둔 주문(금액·
   orderId가 서버 authoritative)으로 결제창을 연다. 결제위젯은 성공/
   실패 시 successUrl/failUrl로 페이지 전체를 이동시키므로(SPA 안에서
   끝나지 않는다), 지금 하려던 작업(opts)을 로컬에 남겨 뒀다가 페이지가
   다시 뜰 때(daResumeAfterTossRedirect) 그대로 이어간다. */
async function daRunRealTossPayment(token, paymentConfig, opts) {
  const orderRes = await A.api('/api/payment/order', { method: 'POST', token });
  if (!orderRes.ok || !orderRes.json || !orderRes.json.orderId) {
    daTrackSafe('payment_result', { result: 'failure' });
    alert('결제를 준비하지 못했어요. 잠시 후 다시 시도해 주세요.');
    return;
  }
  try {
    await daLoadTossSdk();
    try { localStorage.setItem('cs1_pendingCourseOpts', JSON.stringify(opts || {})); } catch (e) { /* 저장 실패해도 결제 자체는 진행 */ }
    const tossPayments = window.TossPayments(paymentConfig.clientKey);
    const widgets = tossPayments.widgets({ customerKey: token });
    await widgets.setAmount({ currency: 'KRW', value: orderRes.json.amount });
    await widgets.renderPaymentMethods({ selector: '#tossPaymentMethods' });
    await widgets.requestPayment({
      orderId: orderRes.json.orderId,
      orderName: orderRes.json.orderName,
      successUrl: window.location.origin + window.location.pathname + '?tossResult=success',
      failUrl: window.location.origin + window.location.pathname + '?tossResult=fail',
    });
    // requestPayment가 성공하면 브라우저가 successUrl로 이동하므로 이
    // 아래 코드는 보통 실행되지 않는다 — 이동 자체가 실패했을 때만 여기 온다.
  } catch (e) {
    daTrackSafe('payment_result', { result: 'failure' });
    alert('결제창을 여는 데 실패했어요. 잠시 후 다시 시도해 주세요.');
  }
}
/* 토스 결제창에서 되돌아온 뒤(successUrl/failUrl) 페이지가 다시 뜰 때
   실행된다 — 쿼리스트링에 실제 응답이 있으면 서버에 승인 확인을
   요청하고, 하려던 작업을 이어간다. **이 리다이렉트 왕복 전체는 실제
   토스 클라이언트 키·실제 결제창 없이는 이 세션에서 검증할 수 없다**
   (RELEASE_STATUS.md에 ④로 남겨 뒀다). */
async function daResumeAfterTossRedirect() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('tossResult');
  if (!result) return;
  history.replaceState(null, '', window.location.pathname);
  let opts = {};
  try { opts = JSON.parse(localStorage.getItem('cs1_pendingCourseOpts') || '{}'); } catch (e) { /* 무시 */ }
  try { localStorage.removeItem('cs1_pendingCourseOpts'); } catch (e) { /* 무시 */ }
  const token = A.sessionToken(foodMap);
  if (!token) return;
  if (result === 'fail') { daTrackSafe('payment_result', { result: 'failure' }); return; }
  const paymentKey = params.get('paymentKey'), orderId = params.get('orderId'), amount = params.get('amount');
  if (!paymentKey || !orderId || !amount) { daTrackSafe('payment_result', { result: 'failure' }); return; }
  const r = await A.api('/api/payment/confirm', { method: 'POST', token, body: { paymentKey, orderId, amount: Number(amount) } });
  daTrackSafe('payment_result', { result: r.ok ? 'success' : 'failure' });
  if (r.ok) buildCourseSheet(opts);
}

/* 출발지·가용 시간을 물어보는 시트. 출발지는 API 키 없이 되는 두 가지만
   준다 — 현재 위치(브라우저 GPS) 또는 담아 둔 곳 중 하나.
   2026-09-09 코드 검토(2차): route(오늘 동선)에는 다른 도시에서 담아 둔
   id가 도시를 바꾼 뒤에도 남아 있을 수 있다 — 지금 보고 있는 도시로
   한 번 더 걸러야 다른 도시 장소가 코스에 섞여 들어가지 않는다. */
function buildCourseSheet(opts) {
  opts = opts || {};
  const list = spots.filter((p) => p.city === city && route.has(p.id));
  const defaultDate = opts.date || A.destNow(city).ymd;
  const dateNote = opts.isNewDay ? '<p class="inline-note">새 날짜의 코스를 만듭니다. 필요하면 날짜를 바꿔도 돼요.</p>' : '';
  open('출발지 정하기', `<div class="detail"><h2>어디서 출발할까요?</h2>` +
    `<p>${list.length}곳을 실제 방문 순서·이동시간으로 만듭니다.</p>` +
    dateNote +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">날짜<input class="xinput" id="courseDate" type="date" value="${A.esc(defaultDate)}" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<div class="city-options"><button class="city-option" data-start-gps><span><b>현재 위치에서 출발</b><small>브라우저 위치 권한이 필요해요</small></span><span class="city-check">›</span></button>` +
    list.map((p) => `<button class="city-option" data-start-pick="${p.id}"><span><b>${A.esc(p.name)}</b><small>${p.hasCoords ? '이 장소에서 출발' : '좌표가 없어 출발지로 못 씀'}</small></span><span class="city-check">${p.hasCoords ? '›' : '—'}</span></button>`).join('') +
    `</div><label class="xsmall" style="display:block;margin-top:6px">쓸 수 있는 시간(분, 선택)<input class="xinput" id="courseMinutes" type="number" min="30" step="10" placeholder="예: 240" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label></div>`);
  const dateVal = () => { const el = $('#courseDate'); return (el && el.value) || defaultDate; };
  /* 2026-09-10 재검토(3차): 응답을 기다리는 동안 버튼을 비활성화한다
     (느린 네트워크에서 여러 번 눌러 중복 요청이 나가는 걸 막는다 —
     서버도 멱등하게 처리하지만 화면 반응성 자체를 개선한다). */
  const disableStartButtons = () => { $('#sheetContent').querySelectorAll('[data-start-pick],[data-start-gps]').forEach((b) => { b.disabled = true; }); };
  $('#sheetContent').querySelectorAll('[data-start-pick]').forEach((b) => {
    b.onclick = () => {
      const p = spots.find((s) => s.id === b.dataset.startPick); if (!p || !p.hasCoords) return;
      disableStartButtons();
      runCourseGeneration({ lat: p.lat, lng: p.lng }, p.id, dateVal(), opts);
    };
  });
  const gpsBtn = $('[data-start-gps]');
  if (gpsBtn) gpsBtn.onclick = () => {
    // 2026-09-11 재검토(10차) 7절 — "한국에서 하카타 테스트 위치를
    // 선택했으면 코스 출발 좌표도 하카타여야 한다." 예전엔 이 버튼이
    // 테스트 위치와 무관하게 항상 실제 브라우저 GPS를 불렀다 — 서버
    // 승인 테스트 계정이 테스트 위치를 켜 둔 경우, 이 버튼도 daLocationBasis
    // 와 같은 기준(테스트 위치 우선)을 따라야 다른 화면들과 일관된다.
    const testLoc = A.testModeAllowed() ? A.getTestLocation() : null;
    if (testLoc) {
      disableStartButtons();
      runCourseGeneration({ lat: testLoc.lat, lng: testLoc.lng }, null, dateVal(), opts);
      return;
    }
    if (!navigator.geolocation) { alert('이 브라우저는 위치 기능을 지원하지 않아요. 목록에서 출발지를 골라 주세요.'); return; }
    disableStartButtons();
    gpsBtn.textContent = '위치 확인 중…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        _myGpsLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; // 거리순 등 다른 화면도 같은 값을 쓸 수 있게 세션에 남긴다.
        runCourseGeneration(_myGpsLocation, null, dateVal(), opts);
      },
      () => { alert('현재 위치를 가져오지 못했어요. 목록에서 출발지를 골라 주세요.'); buildCourseSheet(opts); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };
}
/* 샘플(체험) 코스 생성 — 로그인·서버 없이 예전처럼 클라이언트에서
   직접 계산한다(가짜 데이터라 실제 비용·계정 개념이 없다). 결과를
   foodMap.course/courses에는 저장하지 않는다 — 샘플 도시명이 실제
   사용자 도시명과 우연히 같을 수 있어(예: '후쿠오카') 실데이터 코스와
   섞이면 안 된다. */
async function runSampleCourseGeneration(origin, list, startMinutes, budgetMinutes) {
  open('코스 만드는 중', '<div class="detail"><h2>샘플 코스를 계산하고 있어요…</h2></div>');
  const result = await window.CourseGen.generate(origin, list, { startMinutes, budgetMinutes });
  if (!result.ok) {
    open('코스를 만들 수 없어요', '<div class="detail"><h2>좌표가 있는 곳이 없어요.</h2><p>샘플 데이터에 문제가 있어요.</p><button class="primary" data-dismiss>돌아가기</button></div>');
    return;
  }
  showSampleCourseResult(result, list);
}
/* 샘플 코스 결과 — foodMap.course/courses에는 절대 안 남긴다(실데이터
   코스와 섞이면 안 된다). 표시만 하고 저장하지 않으므로 날짜 탭·
   "새로 만들기"도 없다 — 체험용 1회성 화면이다. */
function showSampleCourseResult(result, list) {
  const totalKm = (result.totalMeters / 1000).toFixed(1);
  const hours = Math.floor(result.walkTotal / 60), mins = result.walkTotal % 60;
  const stopViews = result.stops.map((s, i) => {
    const p = list.find((x) => x.id === s.id); if (!p) return '';
    return `<div class="route-row"><span>${i + 1}</span>${photoHTML(p, '')}<div><b>${A.esc(p.name)}</b><p>${window.CourseGen.clockLabel(s.at)} 도착 · 도보 ${s.walk}분 이동</p></div></div>`;
  }).join('');
  open('샘플 코스', `<div class="detail"><p class="inline-note">샘플 데이터로 만든 예시 코스입니다.</p><h2>${result.stops.length}곳 · 도보 이동 ${hours ? hours + '시간 ' : ''}${mins}분</h2>` +
    `<p>${result.routedReal ? '실제 도보 경로 기준으로 계산했습니다.' : '실제 경로 연결에 실패해 직선거리 기준으로 추정했습니다.'} 총 이동 거리 약 ${totalKm}km</p>` +
    stopViews +
    `<button class="primary" data-dismiss>확인</button></div>`);
}
/* 실제(개인화) 코스 생성 — 2026-09-10 재검토(3차): 서버가 인증→이용권/
   체험 확인→생성→저장→성공 확정까지 전부 집행한다(server/routes/
   course-generation.mjs). 브라우저는 좌표를 서버로 보내고 결과를
   받을 뿐, "체험을 썼다"는 판단을 스스로 내리거나 서버에 나중에
   알리지 않는다 — 그 자체가 우회 가능한 구멍이었다. */
async function runRealCourseGeneration(origin, startPlaceId, list, city2, date, startMinutes, budgetMinutes, opts) {
  const token = A.sessionToken(foodMap);
  if (!token) { showLoginSheet(() => daGateThenBuildCourseSheet(opts)); return; }
  open('코스 만드는 중', '<div class="detail"><h2>실제 이동시간을 계산하고 있어요…</h2><p>도보 경로를 먼저 확인합니다. 네트워크 상태에 따라 몇 초 걸릴 수 있어요.</p></div>');
  // 2026-09-10 재검토(6차) 3-④ — "생성 요청은 현재 tripId를 실어 보내고
  // 그 결과를 그 여행 아래 저장해야 한다." 이 도시에 여행이 아직
  // 없으면(완전히 새로운 도시) 조용히 하나 만들어 둔다(ensureTripForCity).
  const trip = await ensureTripForCity(city2);
  const placesPayload = list.map((p) => ({ id: p.id, name: p.name, lat: A.hasCoords(p) ? p.lat : undefined, lng: A.hasCoords(p) ? p.lng : undefined }));
  // 한 번의 사용자 시도당 하나의 idempotencyKey — 네트워크 재시도로
  // 서버에 똑같은 요청이 두 번 들어와도(예: 응답 유실 뒤 사용자가 다시
  // 누름) 서버가 실제 작업을 다시 안 하고 저장된 결과를 그대로 준다.
  const idempotencyKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('gen-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const r = await A.api('/api/course/generate', {
    method: 'POST', token,
    body: { idempotencyKey, city: city2, date, origin, startMinutes, budgetMinutes, places: placesPayload, tripId: trip ? trip.tripId : undefined },
  });
  if (r.status === 402) {
    daTrackSafe('paywall_viewed', { trigger: (opts && opts.isNewDay) ? 'new_day' : 'second_course' });
    showPaywallSheet(r.json && r.json.price, opts);
    return;
  }
  if (r.status === 429) {
    open('잠시 후 다시 시도해 주세요', '<div class="detail"><h2>요청이 너무 잦아요.</h2><p>잠시 뒤에 다시 시도해 주세요.</p><button class="primary" data-dismiss>돌아가기</button></div>');
    return;
  }
  if (r.status === 403 && r.json && r.json.reason === 'entitlement-course-limit-reached') {
    // 2026-09-10 재검토(6차) — 이번 이용권에 포함된 코스 생성 횟수를
    // 다 쓴 상태. 추가 결제 상품이 없으므로 "더 사라"고 유도하지 않고,
    // 사실만 정직하게 안내한다(개발 용어 없이).
    open('이번 이용권 한도', '<div class="detail"><h2>이번 이용권에 포함된 코스 생성 횟수를 모두 사용했어요.</h2><p>계정 화면에서 남은 횟수와 이용권 기간을 확인할 수 있어요.</p><button class="primary" data-dismiss>돌아가기</button></div>');
    return;
  }
  if (!r.ok || !r.json || !r.json.course) {
    open('코스를 만들 수 없어요', `<div class="detail"><h2>${r.json && r.json.reason === 'no-coords' ? '좌표가 있는 곳이 없어요.' : '코스를 만들지 못했어요.'}</h2><p>${r.json && r.json.reason === 'no-coords' ? '담아 둔 곳 모두 좌표가 없어 이동시간을 계산할 수 없습니다. 장소 상세에서 위치를 먼저 확인해 주세요.' : '잠시 후 다시 시도해 주세요.'}</p><button class="primary" data-dismiss>돌아가기</button></div>`);
    return;
  }
  r.json.course.tripId = trip ? trip.tripId : undefined;
  daUpsertCourse(r.json.course);
  const saved = A.saveFoodMap(foodMap);
  if (!saved) {
    // 서버에는 이미 저장됐지만(다음 로그인/새로고침 시 다시 받아온다),
    // 이 기기의 로컬 저장에 실패했다고 성공을 감추지 않는다 — 그래도
    // 서버 저장은 이미 끝났으니 완전한 실패는 아니라고 정직하게 안내한다.
    foodMap = A.loadFoodMap();
    alert('코스는 서버에 저장됐지만 이 기기에는 저장하지 못했어요. 새로고침해서 다시 불러와 주세요.');
  }
  daTrackSafe('course_generated', { routed_real: !!r.json.course.routedReal, stop_count: r.json.course.stops.length });
  daSyncPushSafe();
  showSavedCourse();
}
async function runCourseGeneration(origin, startPlaceId, dateStr, opts) {
  const minutesInput = $('#courseMinutes');
  const budgetMinutes = minutesInput && minutesInput.value ? +minutesInput.value : null;
  /* 2026-09-09 코드 검토(2차): route에 다른 도시 id가 남아 있을 수 있어
     여기서도 지금 도시로 한 번 더 거른다(buildCourseSheet만 걸러서는
     이 함수가 다른 경로로 직접 불릴 가능성까지 막지 못한다). */
  const list = spots.filter((p) => p.city === city && route.has(p.id) && p.id !== startPlaceId);
  /* 시작 시각은 "오전 9시" 고정이 아니라 여행지 현지의 지금 시각이다. */
  const destNow = A.destNow(city);
  const startMinutes = destNow.hour * 60 + destNow.minute;
  const date = dateStr || destNow.ymd;
  if (usingSample) { await runSampleCourseGeneration(origin, list, startMinutes, budgetMinutes); return; }
  await runRealCourseGeneration(origin, startPlaceId, list, city, date, startMinutes, budgetMinutes, opts);
}
/* 저장된 코스를 보여준다 — 새로고침해도 foodMap.course에 남아 있어
   그대로 다시 보인다. 실제 경로인지 추정인지 구분해서 보여주고(2026-
   09-09 코드 검토 — 직선거리를 실제 최단 동선처럼 보여주지 말 것),
   좌표가 없어 빠진 곳은 목록으로 따로 보여준다(조용히 안 뺌). 대중교통·
   택시·자전거는 자체 계산 없이 구글 지도로 바로 연결한다("연결된
   범위만 제공"). */
/* 날짜 탭 — 이 도시에 저장된 날짜별 코스를 오가며 볼 수 있게 한다.
   탭을 눌러 다른 날짜를 보는 건 언제나 무료다(이미 만들어 둔 걸 다시
   보는 것뿐이라 서버에 묻지 않는다 — "만료 후에도 기존 장소와 코스
   열람 유지"와 같은 원칙: 열람은 항상 열려 있다). "+ 날짜 추가"만
   daGateThenBuildCourseSheet를 거친다(추가 코스 생성 = 유료). 승인
   디자인의 기존 필터 pill 스타일(.filters/[data-filter])을 그대로
   재사용한다 — 이 화면만을 위한 새 컴포넌트를 만들지 않는다. */
function dayTabsHTML(c) {
  const days = daCoursesForCity(city);
  if (!days.length) return '';
  const todayYmd = A.destNow(city).ymd;
  return `<div class="filters" role="group" aria-label="날짜 선택">${
    days.map((d) => `<button data-day="${A.esc(d.date || '')}" class="${d.date === c.date ? 'active' : ''}" aria-pressed="${d.date === c.date}">${A.esc(d.date || '날짜 미상')}${d.date === todayYmd ? ' · 오늘' : ''}</button>`).join('')
  }<button data-day-new>+ 날짜 추가</button></div>`;
}
function showSavedCourse() {
  const c = foodMap.course;
  const stopViews = c.stops.map((s, i) => {
    const p = foodMap.places.find((x) => x.id === s.id);
    if (!p) return '';
    const prevId = i === 0 ? null : c.stops[i - 1].id;
    const prevP = prevId ? foodMap.places.find((x) => x.id === prevId) : null;
    const links = prevP && A.hasCoords(prevP) && A.hasCoords(p)
      ? `<div class="course-modes"><a href="${A.esc(window.CourseGen.directionsLink(prevP, p, 'transit'))}" target="_blank" rel="noopener noreferrer">🚃 대중교통</a><a href="${A.esc(window.CourseGen.directionsLink(prevP, p, 'driving'))}" target="_blank" rel="noopener noreferrer">🚕 택시·자동차</a></div>`
      : '';
    return `<div class="route-row"><span>${i + 1}</span>${photoHTML(p, '')}<div><b>${A.esc(p.name)}</b><p>${window.CourseGen.clockLabel(s.at)} 도착 · 도보 ${s.walk}분 이동${links}</p></div></div>`;
  }).join('');
  /* 2026-09-09 코드 검토(2차): "좌표가 없어서 빠짐"과 "가용 시간 안에
     못 들어가서 빠짐"은 사용자가 할 수 있는 다음 행동이 다르다(위치
     확인 vs 시간을 늘리거나 곳 수를 줄이기) — 하나로 뭉뚱그리지 않는다. */
  const reasons = c.excludedReasons || {};
  const excluded = (c.excludedIds || []).map((id) => foodMap.places.find((p) => p.id === id)).filter(Boolean);
  const noCoordsList = excluded.filter((p) => reasons[p.id] !== 'time-budget');
  const timeList = excluded.filter((p) => reasons[p.id] === 'time-budget');
  const totalKm = (c.totalMeters / 1000).toFixed(1);
  const hours = Math.floor(c.walkTotal / 60), mins = c.walkTotal % 60;
  const surveyTrip = currentTripForCity(city);
  // 2026-09-11 재검토(11차) — 코스 필드 충돌 안내. trip에 딸린 코스는
  // 날짜별 upsert만 하고 아직 필드 병합을 안 하므로(daRemergeGenericConflict
  // 미적용) 여기서는 레거시(tripId 없음) 코스만 해당된다 — 없으면
  // c._fieldConflicts 자체가 애초에 안 생긴다.
  const courseConflictHTML = daFieldConflictBlockHTML(c._fieldConflicts, 'course-conflict-resolve', `${c.city}::${c.date}`);
  open('오늘의 코스', `${window.WeatherCard.skeletonHTML(city)}${window.StreetVideo.buttonHTML(city)}<div class="detail">${dayTabsHTML(c)}${tripBlockHTML(city)}${courseConflictHTML}<h2>${c.stops.length}곳 · 도보 이동 ${hours ? hours + '시간 ' : ''}${mins}분</h2>` +
    `<p>${c.routedReal ? '실제 도보 경로 기준으로 계산했습니다.' : '실제 경로 연결에 실패해 직선거리 기준으로 추정했습니다(실제와 다를 수 있어요).'} 총 이동 거리 약 ${totalKm}km · 마지막 장소 도착 예정 ${window.CourseGen.clockLabel(c.endAt - (c.stops[c.stops.length - 1] ? c.stops[c.stops.length - 1].dwell : 0))}</p>` +
    stopViews +
    (noCoordsList.length ? `<div class="inline-note">좌표가 없어 이번 코스 계산에서 빠진 곳 ${noCoordsList.length}곳: ${noCoordsList.map((p) => A.esc(p.name)).join(', ')}. 위치를 확인하면 다음 코스에 포함할 수 있어요.</div>` : '') +
    (timeList.length ? `<div class="inline-note">가용 시간 안에 다 들르지 못해 빠진 곳 ${timeList.length}곳: ${timeList.map((p) => A.esc(p.name)).join(', ')}. 쓸 수 있는 시간을 늘리거나 곳 수를 줄이면 포함할 수 있어요.</div>` : '') +
    `<button class="text-button" data-course-new>새로 만들기</button><button class="primary" data-dismiss>확인</button>${window.Affiliates.placeholderHTML('affiliateSection')}${courseSurveyHTML(surveyTrip && surveyTrip.tripId)}</div>`);
  window.WeatherCard.loadWeatherCard(A, city, spots, c.date);
  // 2026-09-11 재검토(9차) — 최소 제휴 준비. 이 도시에 승인된 실제
  // 제휴가 없으면(지금은 전부 없음) 섹션이 그대로 숨겨진 채로 남는다.
  window.Affiliates.bindAffiliateClicks('affiliateSection');
  window.Affiliates.loadAffiliateSection(A, city, 'affiliateSection');
}
/* 2026-09-10 재검토(6차) — "계정 화면에서 잔여 횟수를 확인할 수 있게
   하라"는 지시. API/SKU 같은 개발 용어 없이, 이번 이용권(무료체험 또는
   유료)에 남은 위치 확인·코스 생성 횟수만 사람 말로 보여준다. */
async function profile() {
  const realCount = foodMap.places ? foodMap.places.length : 0;
  const loggedInEmail = foodMap.session && foodMap.session.email;
  const token = A.sessionToken(foodMap);
  let usageHTML = '';
  if (token) {
    // 2026-09-11 재검토(10차) 7절 — 이 화면을 열 때마다 서버의 최신
    // 테스트 계정 승인 상태를 다시 확인한다(관리자가 방금 권한을
    // 뺏었어도 즉시 반영되게).
    await A.refreshTestAccess(token);
    renderTestLocationBanner(); // 승인이 방금 거둬졌을 수도 있으니 상단 배너도 즉시 최신 상태로 맞춘다.
    const r = await A.api('/api/account/usage', { token });
    if (r.ok && r.json) {
      const u = r.json;
      const kindLabel = u.kind === 'paid' ? '유료 이용권' : '무료 체험';
      const expiresNote = u.expiresAt ? ` · ${new Date(u.expiresAt).toLocaleDateString('ko-KR')}까지` : '';
      usageHTML = `<div class="inline-note"><b>${A.esc(kindLabel)}${expiresNote}</b><br>` +
        `남은 위치 확인: ${u.placeLookups.remaining}곳(전체 ${u.placeLookups.limit}곳 중)<br>` +
        `남은 코스 생성: ${u.courseGenerations.remaining}회(전체 ${u.courseGenerations.limit}회 중)</div>`;
    }
  }
  // 2026-09-11 재검토(10차) 7절 — 테스트 위치(서버가 승인한 테스트
  // 계정 전용). 예전엔 ?testmode=1 URL 하나로 이 브라우저에 영구히
  // 풀렸다(운영용 접근 제한이 아니라는 지적) — 이제는 A.testModeAllowed()
  // 가 로그인마다 서버에 실제로 물어본 결과만 반영한다(위
  // daRefreshTestAccess 참고, 관리자만 /api/admin/test-access로 켤 수
  // 있음). 실제 GPS를 흉내 내지 않고, 앱 로직(거리순 정렬·코스
  // 출발점 등 daLocationBasis 사용처 전부)이 참고하는 기준점만 사람이
  // 명시적으로 바꿔치기한다 — 이걸로 실제 현지 GPS·로밍을 검증했다고
  // 주장 못 함.
  const testLoc = A.testModeAllowed() ? A.getTestLocation() : null;
  const testLocationHTML = A.testModeAllowed() ?
    `<div class="inline-note"><b>테스트 위치(서버 승인 테스트 계정 전용)</b><br>실제 GPS를 흉내 내지 않습니다 — 거리순 정렬·코스 출발점 등 앱 로직이 참고하는 기준점만 바뀝니다.<br>지금: ${testLoc ? A.esc(testLoc.label) : '사용 안 함(실제 저장 데이터 기준)'}</div>` +
    `<div class="city-options">${A.testLocationPresets.map((tp) => `<button class="city-option" data-test-loc-preset="${A.esc(tp.id)}"><span><b>${A.esc(tp.label)}</b></span><span class="city-check">${testLoc && testLoc.label === tp.label ? '✓' : '›'}</span></button>`).join('')}</div>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">직접 좌표 입력<input class="xinput" id="testLocLat" placeholder="위도(예: 33.5904)" style="margin:6px 0;width:100%;box-sizing:border-box;padding:10px 14px;border-radius:16px;border:1px solid #e5e6e1;font:inherit"><input class="xinput" id="testLocLng" placeholder="경도(예: 130.4207)" style="margin:6px 0;width:100%;box-sizing:border-box;padding:10px 14px;border-radius:16px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<button class="text-button" id="testLocCustomBtn" style="padding:6px 0">이 좌표로 적용</button>` +
    (testLoc ? `<button class="text-button" id="testLocClearBtn" style="padding:6px 0">테스트 위치 끄기</button>` : '')
    : '';
  open('내 프로필', `<div class="profile"><div class="avatar">Y</div><h2>나의 여행 기록</h2><p>가고 싶은 곳을 하나씩 모으는 중</p><div class="stats"><div><b>${realCount}</b><span>저장한 스팟</span></div><div><b>${cities.length}</b><span>도시</span></div><div><b>${route.size}</b><span>오늘 갈 곳</span></div></div><p>${A.esc(city)} · ${usingSample ? '샘플 컬렉션' : '내 데이터'}</p>${loggedInEmail ? `<p class="inline-note">${A.esc(loggedInEmail)}로 로그인됨</p>` : ''}${usageHTML}<button class="primary" data-dismiss>내 스팟으로 돌아가기</button>${usingSample ? '<p>샘플 프로필입니다.</p>' : ''}<button class="text-button" data-feedback-open>불편함 보내기</button>${loggedInEmail ? '<button class="text-button" data-logout>로그아웃</button>' : ''}${testLocationHTML}</div>`);
  if (A.testModeAllowed()) {
    $('#sheetContent').querySelectorAll('[data-test-loc-preset]').forEach((b) => {
      b.onclick = () => {
        const preset = A.testLocationPresets.find((tp) => tp.id === b.dataset.testLocPreset);
        if (!preset) return;
        A.setTestLocation(preset);
        renderTestLocationBanner();
        render();
        profile();
      };
    });
    const customBtn = $('#testLocCustomBtn');
    if (customBtn) customBtn.onclick = () => {
      const lat = parseFloat($('#testLocLat').value);
      const lng = parseFloat($('#testLocLng').value);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) { alert('위도·경도를 숫자로 입력해 주세요.'); return; }
      A.setTestLocation({ lat, lng, label: `직접 입력(${lat.toFixed(4)}, ${lng.toFixed(4)})` });
      renderTestLocationBanner();
      render();
      profile();
    };
    const clearBtn = $('#testLocClearBtn');
    if (clearBtn) clearBtn.onclick = () => { A.clearTestLocation(); renderTestLocationBanner(); render(); profile(); };
  }
}
/* 6-3절 — 화면 어디서든 보이는 "테스트 위치 사용 중" 표시. 실제
   위치처럼 보이지 않도록 항상 "실제 위치 아님"을 같이 밝힌다. */
function renderTestLocationBanner() {
  const el = $('#testLocationBanner'); if (!el) return;
  // 2026-09-11 재검토(10차) 7절 — testModeAllowed()도 함께 확인한다.
  // 서버가 이 계정의 테스트 접근을 나중에 거둬 가도(관리자가
  // /api/admin/test-access로 끔) localStorage에 남은 test_location_v1
  // 값만 보고 "테스트 위치 사용 중"이라고 계속 표시하면 실제로는
  // 이제 평균 위치/GPS로 되돌아간 상태를 거짓으로 안내하는 셈이다.
  const loc = A.testModeAllowed() ? A.getTestLocation() : null;
  el.hidden = !loc;
  if (loc) $('#testLocationBannerText').textContent = `🧪 테스트 위치 사용 중: ${loc.label} · 실제 위치 아님(수동 지정)`;
}
/* 6-4절 — "불편함 보내기". 로그인 없이도 보낼 수 있다(아직 로그인
   못 한 상태에서 겪은 문제도 알려야 한다). 화면 스크린샷 첨부는 이번
   라운드에서 지원하지 않는다 — 개인정보(저장한 장소가 화면에 그대로
   보임)·초기 운영비용을 고려한 의도적 최소 범위이며, 그 사실을
   화면에서 숨기지 않고 그대로 알린다. */
function feedbackSheet() {
  const typeLabels = { import: '가져오기', 'location-route': '위치·동선', usage: '이용 방법', payment: '결제', other: '기타' };
  open('불편함 보내기', `<div class="detail"><h2>어떤 게 불편했나요?</h2>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">유형<select id="fbType" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit">${Object.entries(typeLabels).map(([k, v]) => `<option value="${A.esc(k)}">${A.esc(v)}</option>`).join('')}</select></label>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">한 줄로 설명해 주세요<textarea id="fbDesc" maxlength="300" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:16px;border:1px solid #e5e6e1;font:inherit" rows="3"></textarea></label>` +
    `<label class="xsmall" style="display:block;margin:10px 0 6px">답변받을 연락처(선택)<input class="xinput" id="fbContact" placeholder="이메일 등(선택)" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<p class="inline-note">화면 스크린샷 첨부는 아직 지원하지 않아요(개인정보·운영비용을 고려해 최소한으로 시작합니다). 대신 앱 버전·현재 화면·기기 종류 정도의 최소 정보만 함께 보내져요 — 저장한 장소 목록이나 정확한 위치, 결제 정보는 절대 같이 보내지 않아요.</p>` +
    `<button class="primary" id="fbSendBtn" style="margin-top:8px">보내기</button>` +
    `<p class="inline-note" id="fbMsg" hidden></p></div>`);
  const msg = (t2) => { const el = $('#fbMsg'); el.textContent = t2; el.hidden = false; };
  $('#fbSendBtn').onclick = async () => {
    const type = $('#fbType').value;
    const description = $('#fbDesc').value.trim();
    if (!description) { msg('한 줄이라도 설명을 입력해 주세요.'); return; }
    const contact = $('#fbContact').value.trim();
    const btn = $('#fbSendBtn'); btn.disabled = true; btn.textContent = '보내는 중…';
    const token = A.sessionToken(foodMap);
    const diagnostic = { appBuild: APP_BUILD, screen: currentScreenLabel, deviceType: daDeviceTypeBucket(), errorCode: lastErrorCode || undefined };
    const r = await A.api('/api/feedback', { method: 'POST', token: token || undefined, body: { type, description, contact: contact || undefined, diagnostic } });
    if (!r.ok || !r.json || !r.json.ok) {
      btn.disabled = false; btn.textContent = '보내기';
      const reasonMsg = {
        'account-daily-limit-reached': '오늘은 이미 여러 번 보내셨어요. 내일 다시 보내주세요.',
        'ip-daily-limit-reached': '오늘은 이미 여러 번 보내셨어요. 내일 다시 보내주세요.',
        'description-too-long': '설명이 너무 길어요. 조금 줄여서 다시 시도해 주세요.',
      }[r.json && r.json.reason];
      msg(reasonMsg || '보내지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    daTrackSafe('feedback_submitted', { type });
    open('불편함 보내기', '<div class="detail"><h2>보내주셔서 감사해요.</h2><p>확인 후 반영하겠습니다.</p><button class="primary" data-dismiss>돌아가기</button></div>');
  };
}
/* 6-4절 — 코스가 실제로 만들어진 직후 뜨는 짧은(닫을 수 있는) 설문.
   코스 사용을 막지 않는다 — 카드 형태로 얹혀 있을 뿐, 안 눌러도 코스
   화면은 그대로 다 쓸 수 있다. 같은 코스에는 한 번만 보여준다. */
function courseSurveyHTML(tripId) {
  if (usingSample || !tripId) return '';
  foodMap.surveyShownForTrips = foodMap.surveyShownForTrips || [];
  if (foodMap.surveyShownForTrips.includes(tripId)) return '';
  return `<div class="inline-note" id="courseSurveyCard" data-survey-trip="${A.esc(tripId)}"><b>실제로 이 코스로 여행하셨나요?</b><br>` +
    `<button class="text-button" data-survey-answer="yes" style="padding:6px 10px 6px 0">네, 다녀왔어요</button>` +
    `<button class="text-button" data-survey-answer="no" style="padding:6px 10px">아직요/못 갔어요</button>` +
    `<label class="xsmall" style="display:block;margin-top:6px">가장 큰 불편이 있었다면(선택)<input class="xinput" id="courseSurveyBlocker" style="margin-top:4px;width:100%;box-sizing:border-box;padding:8px 12px;border-radius:14px;border:1px solid #e5e6e1;font:inherit"></label>` +
    `<button class="text-button" id="courseSurveySkip" style="padding:6px 0">나중에</button></div>`;
}
async function submitCourseSurvey(tripId, actuallyTraveled) {
  // 카드를 지우기 전에 입력값부터 읽는다 — 순서를 바꾸면 el.remove()가
  // #courseSurveyBlocker까지 같이 지워 항상 빈 값으로 전송되는 버그가
  // 생긴다(실제로 재현해 확인한 뒤 고쳤다).
  const blockerEl = $('#courseSurveyBlocker');
  const biggestBlocker = blockerEl ? blockerEl.value.trim() : '';
  foodMap.surveyShownForTrips = foodMap.surveyShownForTrips || [];
  if (!foodMap.surveyShownForTrips.includes(tripId)) foodMap.surveyShownForTrips.push(tripId);
  A.saveFoodMap(foodMap);
  const el = $('#courseSurveyCard');
  if (el) el.remove();
  const token = A.sessionToken(foodMap);
  if (!token) return; // 로그인 안 한 상태(샘플 등)에서는 조용히 건너뜀 — 코스 사용을 막지 않는다.
  await A.api('/api/feedback/survey', { method: 'POST', token, body: { tripId, actuallyTraveled, biggestBlocker: biggestBlocker || undefined } });
  daTrackSafe('survey_submitted', { actually_traveled: !!actuallyTraveled });
}
function updateCity() {
  $('#cityName').textContent = city;
  const c = cities.find((x) => x.name === city);
  $('#albumCity').textContent = c ? (c.label || c.name).toUpperCase() : '';
  $('.filters').innerHTML = ['전체', ...new Set(spots.filter((p) => p.city === city).map((p) => p.category))]
    .map((c2) => `<button data-filter="${A.esc(c2)}" class="${c2 === filter ? 'active' : ''}" aria-pressed="${c2 === filter}">${A.esc(c2)}</button>`).join('');
  // 2026-09-10 재검토(6차) 3-③ — 방문 상태 필터. 방문·다시가고싶음
  // 기록이 하나도 없으면 아예 안 보여준다(첫 화면에 안 쓰는 설정을
  // 미리 늘어놓지 않는다 — 실제로 기록이 생겼을 때만 나타난다).
  const vf = $('#visitFilters');
  if (vf) {
    const hasVisitData = !usingSample && (foodMap.visits || []).some((v) => v.visited || v.wantRevisit);
    vf.hidden = !hasVisitData;
    if (hasVisitData) {
      vf.innerHTML = ['전체', '미방문', '방문함', '다시가고싶음']
        .map((f) => `<button data-vfilter="${A.esc(f)}" class="${f === visitFilter ? 'active' : ''}" aria-pressed="${f === visitFilter}">${A.esc(f)}</button>`).join('');
    } else {
      visitFilter = '전체';
    }
  }
  render();
}
function chooseCity(name) { city = name; filter = '전체'; activeTags.clear(); selecting = false; $('#search').value = ''; updateCity(); sheet.close(); }
function cityPicker() {
  /* 2026-09-09부터: 여행지 선택은 "저장 장소를 걸러 보여주는 필터"일 뿐이다.
     도시를 바꿔도 다른 도시에 담아 둔 장소는 지워지지 않는다 — 전부 그대로
     보관돼 있고, 언제든 다시 골라 볼 수 있다. */
  open('여행지 선택', `<div class="detail"><h2>어디를 보여드릴까요?</h2><p>담아 둔 장소를 도시별로 걸러 보여줍니다. 다른 도시로 바꿔도 지금 장소는 지워지지 않아요.</p><div class="city-options">${cities.map((c) => `<button class="city-option ${city === c.name ? 'chosen' : ''}" data-city="${A.esc(c.name)}"><span class="city-initial">${A.esc(c.name.slice(0, 1))}</span><span><b>${A.esc(c.name)}</b><small>저장한 스팟 ${c.count}곳</small></span><span class="city-check">${city === c.name ? '✓' : '›'}</span></button>`).join('')}</div>${usingSample ? '<p class="inline-note">지금은 샘플입니다. 파일을 가져오면 실제 저장한 도시가 여기 나타나요.</p>' : ''}<button class="primary" data-import>장소 더 가져오기</button></div>`);
}

/* ── 실제 가져오기 ──────────────────────────────────────────────────────
   05_IMPORT_ONBOARDING_SPEC.md 5/5 그대로: "실제 ZIP 파서 연결과 검증
   완료 뒤에만 이 버튼을 실제 업로드로 활성화." ZIP 자체는 아직 못 푼다 —
   여기서는 Takeout 폴더 안에서 직접 꺼낸 .csv/.json 파일만 실제로 읽는다.
   그래서 버튼 문구도 "ZIP 선택"이 아니라 "CSV/JSON 파일 선택"으로 뒀다. */
let importMsg = '';
function add() {
  /* 06_UPDATES_AND_EXPORT_CORRECTION.md 정정: 일반 저장 목록은 'Saved',
     별표로 저장했거나 구분이 불명확하면 'Saved' + '지도(내 장소)'를 함께
     내보내야 한다. 'Saved'만 안내하면 별표 장소를 놓친다. */
  open('내 장소 가져오기', `<div class="detail import-flow"><span class="flow-tag">실제 가져오기</span><h2>저장한 곳,<br>그대로 모아볼까요?</h2><p>구글맵에서 받은 <b>Takeout ZIP을 그대로</b> 선택하거나, CSV·JSON 파일로 시작해요. ZIP은 압축을 미리 풀 필요 없이 안에서 저장 목록을 자동으로 찾습니다.</p><div class="file-surface"><span class="file-symbol">↓</span><b>내보낸 파일 가져오기</b><span>ZIP · CSV · JSON</span></div><input type="file" id="realFileIn" accept=".zip,application/zip,application/x-zip-compressed,.csv,text/csv,.json,application/json" style="display:none"><button class="primary" id="realFileBtn">받은 ZIP·CSV·JSON 선택</button>${importMsg ? `<p class="inline-note">${importMsg}</p>` : ''}<button class="text-button" id="sampleBtn">샘플로 먼저 둘러보기</button><details class="import-help"><summary>구글맵에서 파일은 어떻게 받나요?</summary><ol><li>Google Takeout을 열어요.</li><li>일반 저장 목록은 <b>‘저장됨(Saved)’</b>을 선택하세요. 별표로 저장한 장소도 챙기려면(또는 어느 쪽인지 잘 모르겠으면) <b>‘지도(내 장소)’</b>도 함께 선택하세요.</li><li>받은 zip 파일을 <b>그대로</b> 이 화면에서 선택하세요 — 압축을 손으로 풀 필요 없이, 안에 있는 목록별 csv와 별표 장소 json을 자동으로 찾아 한 번에 가져옵니다(같은 곳은 자동으로 안 겹칩니다). 리뷰 파일은 장소가 아니라서 자동으로 뺍니다.</li></ol><a href="https://takeout.google.com/" target="_blank" rel="noopener noreferrer">Google Takeout 열기 ↗</a><p>계정에 따라 내보내기 준비 시간이 걸릴 수 있어요.</p></details></div>`);
  $('#realFileBtn').onclick = () => $('#realFileIn').click();
  $('#realFileIn').onchange = handleRealFile;
  $('#sampleBtn').onclick = () => { usingSample = true; spots = SAMPLE_SPOTS; cities = SAMPLE_CITIES; city = cities[0].name; updateCity(); sheet.close(); };
}
/* 병합 로직은 private/personal.html 의 fmMerge 를 그대로 옮긴 A.merge() 를
   쓴다 — 여기서 다시 만들지 않는다(중복 판정이 갈리는 사고를 막는다).
   검증된 식별자만 자동으로 합치고, 이름만 같은 건 후보로 남긴다. */
async function handleRealFile(e) {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  e.target.value = '';
  foodMap.places = foodMap.places || [];

  if (window.ZipImport && window.ZipImport.isZipFile(f)) { await handleZipFile(f); return; }

  const isCsv = /\.csv$/i.test(f.name);
  daTrackSafe('import_start', { source_kind: isCsv ? 'csv' : 'json' });
  let parsed = [];
  try {
    const txt = await f.text();
    if (isCsv) parsed = A.parseCsv(txt);
    else if (/\.json$/i.test(f.name)) parsed = A.parseJson(JSON.parse(txt));
    else { importMsg = '이 형식은 아직 읽지 못해요. ZIP·CSV·JSON 파일을 선택해 주세요.'; daTrackSafe('import_result', { result: 'failure' }); add(); return; }
  } catch (err) {
    importMsg = '파일을 읽지 못했어요. 구글에서 받은 저장 목록 CSV/JSON이 맞는지 확인해 주세요.';
    daTrackSafe('import_result', { result: 'failure' }); add(); return;
  }
  if (!parsed.length) { importMsg = '이 파일에서 저장된 장소를 찾지 못했어요.'; daTrackSafe('import_result', { result: 'failure' }); add(); return; }
  const label = f.name.replace(/\.(csv|json)$/i, '');
  // 6-1절 — 파일 하나를 고르는 단일 가져오기는 그 자체로 하나의 "가져오기 묶음".
  const importBatchId = 'ib' + Date.now() + Math.floor(Math.random() * 9999);
  finishImport([{ label, z: A.merge(parsed, label, foodMap.places, importBatchId) }], []);
}
/* Takeout ZIP 직접 가져오기(로드맵 ②) — 압축을 미리 풀 필요가 없다.
   zip-import.js의 daParseZip이 안전장치(크기·개수·시간 제한)를 갖고
   파일명으로 대상만 골라 압축을 푼다. 일부 파일이 실패해도 성공한
   파일은 반영한다 — 하나가 깨졌다고 전체를 버리지 않는다. */
async function handleZipFile(f) {
  importMsg = '';
  daTrackSafe('import_start', { source_kind: 'zip' });
  open('내 장소 가져오기', '<div class="detail import-flow"><h2>ZIP을 열어 보는 중…</h2><p>파일 안에서 저장 목록을 찾고 있어요. 파일이 크면 시간이 걸릴 수 있어요.</p></div>');
  const result = await window.ZipImport.parseZip(f);
  if (!result.ok) {
    const msgs = {
      'zip-too-large': '이 ZIP 파일이 너무 커요(300MB 넘음). 서비스별로 나눠서 다시 받아 보세요.',
      timeout: 'ZIP을 여는 데 너무 오래 걸려서 멈췄어요. 파일이 손상됐거나 너무 클 수 있어요.',
      corrupt: 'ZIP 파일을 열지 못했어요. 손상됐거나 지원하지 않는 형식일 수 있어요.',
      'no-target-files': '이 ZIP 안에서 저장 목록(csv)이나 저장한 장소(json)를 찾지 못했어요. Google Takeout에서 받은 파일이 맞는지 확인해 주세요.',
      'no-zip-support': '이 브라우저에서는 ZIP을 직접 열 수 없어요. 압축을 풀어 CSV·JSON 파일로 다시 선택해 주세요.',
      empty: '빈 파일이에요.',
      'read-failed': '파일을 읽지 못했어요.',
    };
    importMsg = msgs[result.reason] || '이 ZIP 파일을 처리하지 못했어요.';
    daTrackSafe('import_result', { result: 'failure' });
    add();
    return;
  }
  const perFile = [];
  // 6-1절 — ZIP 하나 안의 여러 파일은 "이번에 함께 들어온" 한 묶음이므로
  // 배치 id를 공유한다("이번에 추가된 N곳" 표시의 근거가 된다).
  const importBatchId = 'ib' + Date.now() + Math.floor(Math.random() * 9999);
  result.files.forEach((entry) => {
    const shortName = entry.name.split('/').pop();
    let parsed = [];
    try {
      parsed = entry.kind === 'csv' ? A.parseCsv(entry.text) : A.parseJson(JSON.parse(entry.text));
    } catch (err) {
      perFile.push({ label: shortName, error: '이 파일을 읽지 못했어요(형식이 깨졌을 수 있어요)' });
      return;
    }
    if (!parsed.length) { perFile.push({ label: shortName, error: '이 파일에서 저장된 장소를 찾지 못했어요' }); return; }
    perFile.push({ label: shortName, z: A.merge(parsed, shortName.replace(/\.(csv|json)$/i, ''), foodMap.places, importBatchId) });
  });
  if (!perFile.some((x) => x.z)) {
    importMsg = 'ZIP 안의 파일들에서 저장된 장소를 찾지 못했어요. ' + (result.skipped.length ? '일부 파일은 제외됐습니다 — 아래에서 이유를 확인하세요.' : '');
    daTrackSafe('import_result', { result: 'failure' });
    add();
    return;
  }
  finishImport(perFile, result.skipped);
}
function finishImport(perFile, skipped) {
  const saved = A.saveFoodMap(foodMap);
  if (!saved) {
    /* 저장 실패를 성공처럼 진행하지 않는다. 메모리 상태도 저장소와 다시
       맞춘다 — 반쯤 반영된 채로 남기지 않는다. */
    foodMap = A.loadFoodMap();
    importMsg = '저장에 실패해서 방금 가져온 내용이 반영되지 않았습니다. 이 브라우저의 저장 공간이 가득 찼거나 시크릿 모드일 수 있어요. 저장 공간을 확인한 뒤 다시 시도해 주세요.';
    daTrackSafe('import_result', { result: 'failure' });
    add();
    return;
  }
  usingSample = false;
  daSyncPushSafe();
  refreshFromStorage();
  /* 지금 보고 있는 도시가 사라졌으면 물론 바꾸고, "지역 확인 필요"를 보던
     중이었는데 이번에 실제 도시가 새로 확인됐으면 그쪽을 먼저 보여준다 —
     아는 도시가 생겼는데 계속 "확인 필요" 화면에 머무를 이유가 없다. */
  const known = cities.find((c) => c.name !== A.UNKNOWN_CITY);
  if (!cities.some((c) => c.name === city) || (city === A.UNKNOWN_CITY && known)) city = (known || cities[0]).name;
  filter = '전체';
  updateCity(); // 배경 화면(grid·count·filters·album)도 같이 갱신 — 안 부르면 결과 시트를 닫아도 화면이 그대로 샘플로 남는다
  const importedCount = perFile.reduce((s, f) => s + (f.z ? f.z.added + f.z.updated : 0), 0);
  daTrackSafe('import_result', { result: 'success', imported_count: importedCount });
  importDone(perFile, skipped);
}
/* 파일별 결과·제외 이유를 구분해서 보여준다(로드맵 ② 요청사항) — ZIP 하나에
   여러 파일이 들어 있을 때 무엇이 성공하고 무엇이 왜 빠졌는지 알아야
   한다. 단일 CSV/JSON 가져오기도 같은 화면을 재사용한다(파일 1개짜리
   목록으로 취급). */
function importDone(perFile, skipped) {
  perFile = perFile || []; skipped = skipped || [];
  const total = (foodMap.places || []).length;
  const unknown = spots.filter((p) => !p.cityKnown).length;
  const added = perFile.reduce((s, f) => s + (f.z ? f.z.added : 0), 0);
  const updated = perFile.reduce((s, f) => s + (f.z ? f.z.updated : 0), 0);
  const dupCandidates = perFile.reduce((s, f) => s + (f.z ? f.z.dupCandidates : 0), 0);
  const ok = perFile.filter((f) => f.z);
  const failed = perFile.filter((f) => f.error);
  const skipReasonLabel = {
    'entry-too-large': '용량이 너무 커서 제외', 'too-many-entries': '한 번에 처리할 수 있는 개수를 넘어 제외', 'review-file': '리뷰 파일이라 제외(장소 아님)',
    /* 2026-09-09 코드 검토(2차) — zip-import.js 경로 필터·전체 용량 상한·
       실제 타임아웃 중단에서 새로 생긴 제외 사유. */
    'not-places-path': '저장한 장소 폴더(Saved·지도) 밖에 있어 제외(다른 서비스 파일로 판단)',
    'total-size-exceeded': '전체 압축 해제 용량 한도를 넘어 제외',
    timeout: '처리 시간 제한을 넘어 이후 항목 압축 해제를 시작하지 않음',
  };
  const fileList = (perFile.length > 1 || failed.length || skipped.length)
    ? `<div class="import-filelist">${
        ok.map((f) => `<div class="import-file ok">✓ ${A.esc(f.label)} — 새로 추가 ${f.z.added} · 자동 갱신 ${f.z.updated}</div>`).join('') +
        failed.map((f) => `<div class="import-file bad">✕ ${A.esc(f.label)} — ${A.esc(f.error)}</div>`).join('') +
        skipped.map((s) => `<div class="import-file skip">– ${A.esc(s.name.split('/').pop())} — ${A.esc(skipReasonLabel[s.reason] || s.reason)}</div>`).join('')
      }</div>`
    : '';
  open('가져오기 결과', `<div class="detail import-flow"><span class="flow-tag">실제 결과</span><h2>${added + updated}곳을 확인했어요.</h2><p>도시별로 모아뒀어요.</p><div class="import-summary"><span><b>${added}</b>새로 추가</span><span><b>${updated}</b>자동 갱신</span><span><b>${total}</b>전체</span></div>${dupCandidates ? `<p class="inline-note">그중 ${dupCandidates}곳은 이름이 같은 기존 장소가 있었어요. 자동으로 합치지 않았습니다 — 장소 상세에서 같은 곳인지 확인해 주세요.</p>` : ''}${fileList}${cities.map((c) => `<button class="city-option" data-city="${A.esc(c.name)}"><span class="city-initial">${A.esc(c.name.slice(0, 1))}</span><span><b>${A.esc(c.name)}</b><small>${c.count}곳</small></span><span class="city-check">↗</span></button>`).join('')}<small>실제 파일 분석 결과입니다.${unknown ? ' 그중 ' + unknown + '곳은 도시를 확인 못 해 "지역 확인 필요"로 넣어 뒀어요 — 여러 개 선택해서 한 번에 지정할 수 있어요.' : ''}</small></div>`);
}
/* 2026-09-11 재검토(11차) 5절 — 예전엔 "GPS 연결 전인 화면"이라고
   스스로 밝히는 자리표시자였다(위치를 수집하지도, 거리순으로
   정렬하지도 않음). 이제 이 버튼을 누르면 실제로 daRequestMyLocation
   (거리순 옆 버튼과 완전히 같은 함수 — 앱 시작이 아니라 이 버튼을
   누른 지금 이 순간에만 위치 권한을 요청한다)을 부르고, 메인 화면을
   거리순으로 전환해 보여준다. */
function nearby() {
  sortMode = 'distance';
  if ($('#sortSelect')) $('#sortSelect').value = 'distance';
  render();
  daRequestMyLocation();
}

$('#search').addEventListener('input', render);
$('#clear').onclick = () => { $('#search').value = ''; render(); $('#search').focus(); };
if ($('#sortSelect')) {
  $('#sortSelect').value = sortMode;
  $('#sortSelect').addEventListener('change', (e) => { sortMode = e.target.value; render(); });
}
if ($('#useMyLocationBtn')) $('#useMyLocationBtn').onclick = daRequestMyLocation;
$('.filters').onclick = (e) => { const b = e.target.closest('[data-filter]'); if (!b) return; filter = b.dataset.filter; document.querySelectorAll('[data-filter]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b); }); render(); };
if ($('#tagFilters')) {
  // 6-2절 — 태그 칩은 단일 선택(filter)과 달리 여러 개를 동시에 켤 수
  // 있다(예: 야키토리+이자카야를 함께 만족하는 곳만 보기).
  $('#tagFilters').onclick = (e) => {
    const b = e.target.closest('[data-tagfilter]'); if (!b) return;
    const tag = b.dataset.tagfilter;
    if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
    render();
  };
}
if ($('#visitFilters')) {
  $('#visitFilters').onclick = (e) => {
    const b = e.target.closest('[data-vfilter]'); if (!b) return;
    visitFilter = b.dataset.vfilter;
    $('#visitFilters').querySelectorAll('[data-vfilter]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b); });
    render();
  };
}
$('#grid').onclick = (e) => { const pick = e.target.closest('[data-pick]'); if (pick) return toggle(pick.dataset.pick); const b = e.target.closest('[data-detail]'); if (b) selecting ? toggle(b.dataset.detail) : detail(b.dataset.detail); };
$('#selectMode').onclick = () => { selecting = !selecting; render(); };
$('#close').onclick = () => sheet.close();
sheet.onclick = (e) => { if (e.target === sheet) sheet.close(); };
$('#sheetContent').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.city) return chooseCity(b.dataset.city);
  if (b.hasAttribute('data-import')) return add();
  if (b.hasAttribute('data-city-picker')) return cityPicker();
  if (b.hasAttribute('data-dismiss')) sheet.close();
  if (b.dataset.detailPick) { toggle(b.dataset.detailPick); detail(b.dataset.detailPick); }
  if (b.dataset.remove) { route.delete(b.dataset.remove); showRoute(); }
  if (b.dataset.citySingle) return cityAssignSheet([b.dataset.citySingle]);
  if (b.dataset.catEdit) return catAssignSheet(b.dataset.catEdit);
  if (b.dataset.tagsEdit) return tagsEditSheet(b.dataset.tagsEdit);
  if (b.dataset.lookupPlace) return daLookupCandidateSheet(b.dataset.lookupPlace);
  if (b.dataset.lookupConfirm) {
    const [pid, lat, lng, placeId, typesStr] = b.dataset.lookupConfirm.split('|');
    return finishLookupConfirm(pid, +lat, +lng, placeId, typesStr ? typesStr.split(',').filter(Boolean) : []);
  }
  if (b.hasAttribute('data-batch-lookup')) return daBatchLookupFlow();
  if (b.dataset.batchConfirm) {
    const [pid, lat, lng, placeId, typesStr] = b.dataset.batchConfirm.split('|');
    finishLookupConfirm(pid, +lat, +lng, placeId, typesStr ? typesStr.split(',').filter(Boolean) : []);
    if (daBatchQueue) { daBatchQueue.idx += 1; daShowBatchQueueStep(); }
    return;
  }
  if (b.hasAttribute('data-batch-skip')) {
    if (daBatchQueue) { daBatchQueue.idx += 1; daShowBatchQueueStep(); }
    return;
  }
  if (b.dataset.dupMerge) { const [x, y] = b.dataset.dupMerge.split('|'); return resolveDup(x, y, 'merge'); }
  if (b.dataset.dupDismiss) { const [x, y] = b.dataset.dupDismiss.split('|'); return resolveDup(x, y, 'dismiss'); }
  if (b.dataset.conflictResolve) { const [pid, key] = b.dataset.conflictResolve.split('|'); return resolveFieldConflict(pid, key); }
  if (b.dataset.courseConflictResolve) { const [cd, key] = b.dataset.courseConflictResolve.split('|'); const [cCity, cDate] = cd.split('::'); return resolveCourseFieldConflict(cCity, cDate, key); }
  if (b.dataset.tripConflictResolve) { const [tid, key] = b.dataset.tripConflictResolve.split('|'); return resolveTripFieldConflict(tid, key); }
  /* 2026-09-10 재검토(3차): 샘플은 로그인 없이 곧바로 buildCourseSheet로
     간다. 실제 데이터는 daGateThenBuildCourseSheet가 로그인부터
     확인한다 — 무료체험/이용권 여부는 실제 생성 시도 때 서버가
     판정한다(runCourseGeneration이 402 응답을 이용권 화면으로 잇는다). */
  if (b.hasAttribute('data-build-course')) return daGateThenBuildCourseSheet();
  /* 예전엔 여기서 기존 코스를 먼저 지우고 저장했다 — 그 상태에서
     출발지 화면을 취소하거나 코스 생성이 실패하면 이전 코스가 사라진
     채로 남았다. 이제 기존 코스는 그대로 두고 게이트를 거쳐 출발지
     화면으로만 넘어간다 — 실제로 새 코스가 완성돼 저장에 성공했을
     때만(runCourseGeneration) 교체된다. "새로 만들기"는 지금 보고
     있는 그 날짜를 다시 계산하는 것이다 — 날짜를 안 넘기면 오늘
     날짜로 새로 만들어져 같은 날짜가 두 개로 갈라진다. */
  if (b.hasAttribute('data-course-new')) return daGateThenBuildCourseSheet({ date: foodMap.course && foodMap.course.date });
  /* 날짜 탭 전환 — 이미 만들어 둔 걸 다시 보여줄 뿐이라 게이트를 아예
     안 거친다(서버에 묻지 않는다, 항상 무료). */
  if (b.dataset.day) {
    const found = daCoursesForCity(city).find((c2) => c2.date === b.dataset.day);
    if (found) { foodMap.course = found; showSavedCourse(); }
    return;
  }
  /* "+ 날짜 추가" — 진짜 새 날짜라 daGateThenBuildCourseSheet가 "추가
     코스 생성"으로 다룬다(무료 체험 이후엔 유료). 이미 있는 날짜
     다음날로 기본값을 잡아 준다(여행 계획이 보통 이어지는 방향이라). */
  if (b.hasAttribute('data-day-new')) return daGateThenBuildCourseSheet({ date: daNextDay(city), isNewDay: true });
  if (b.hasAttribute('data-logout')) return daLogout();
  /* 2026-09-10 재검토(6차) 3절 — 여행 목록/전환·새 여행·이월 후보·
     방문 기록 버튼. 전부 이 중앙 위임 핸들러에 얹는다(파일 전체가
     이미 이 패턴을 쓴다 — 여기서만 새 컴포넌트를 안 만든다). */
  if (b.hasAttribute('data-trip-switch')) return tripPickerSheet(city);
  if (b.hasAttribute('data-trip-new')) return newTripFormSheet(city);
  if (b.dataset.tripChoose) return chooseTrip(city, b.dataset.tripChoose);
  if (b.hasAttribute('data-carry-forward')) return carryForwardSheet(city);
  if (b.dataset.carryAdd) { carryAdd(b.dataset.carryAdd); showRoute(); return; }
  if (b.hasAttribute('data-carry-add-all')) { carryAddAll(); showRoute(); return; }
  if (b.dataset.visitMark) return visitAction(b.dataset.visitMark, 'mark');
  if (b.dataset.visitUnmark) return visitAction(b.dataset.visitUnmark, 'unmark');
  if (b.dataset.visitWant) return visitAction(b.dataset.visitWant, 'want-revisit');
  if (b.dataset.visitNotes) {
    const notesId = b.dataset.visitNotes;
    const el = document.getElementById('visitNotes_' + notesId);
    return visitAction(notesId, 'notes', el ? el.value : '');
  }
  // 2026-09-10 재검토(8차) 4절 — 현지 거리·옷차림 영상. 클릭했을 때만
  // 공식 플레이어를 실제로 불러온다(street-video.js의 openPanel 참고 —
  // 그 전까지 이 버튼은 그냥 정적 텍스트일 뿐 iframe도 스크립트도 없다).
  if (b.dataset.streetVideoOpen) return window.StreetVideo.openPanel(b.dataset.streetVideoOpen);
  if (b.hasAttribute('data-street-video-close')) return window.StreetVideo.closePanel();
  // 6-4절 — "불편함 보내기" + 코스 생성 직후 짧은 설문.
  if (b.hasAttribute('data-feedback-open')) return feedbackSheet();
  if (b.dataset.surveyAnswer) {
    const card = b.closest('[data-survey-trip]');
    const tripId = card && card.dataset.surveyTrip;
    if (tripId) submitCourseSurvey(tripId, b.dataset.surveyAnswer === 'yes');
    return;
  }
  if (b.hasAttribute('data-survey-skip') || b.id === 'courseSurveySkip') {
    const card = document.getElementById('courseSurveyCard');
    if (card) card.remove();
    return;
  }
};
/* 2026-09-11 재검토(9차) — 진짜 필드 충돌(daRemergePlaceConflict가
   남긴 _fieldConflicts)을 사용자가 한 번에 해결한다. "다른 기기 값"을
   선택하면 그 값을 적용하고 충돌 표시를 지운다(내 값은 지금까지
   그대로 쓰였으니 "내 값 유지"는 이미 적용된 상태라 별도 버튼이
   필요 없다 — 아무것도 안 누르면 자동으로 내 값이 유지된다). */
function resolveFieldConflict(placeId, key) {
  const p = (foodMap.places || []).find((x) => x.id === placeId);
  if (!p || !p._fieldConflicts || !p._fieldConflicts[key]) return;
  // 2026-09-11 재검토(11차) — theirs 값이 undefined면 "다른 기기가 이
  // 필드를 지웠다"는 뜻이다. p[key]=undefined로 그냥 대입하면 키는
  // 남아 있는데 값만 undefined인 어중간한 상태가 되고, JSON.stringify
  // (localStorage 저장·서버 전송)에서만 조용히 사라져 다음 비교
  // 때 혼란을 줄 수 있다 — 명시적으로 delete한다.
  if (p._fieldConflicts[key].theirs === undefined) delete p[key];
  else p[key] = p._fieldConflicts[key].theirs;
  delete p._fieldConflicts[key];
  if (!Object.keys(p._fieldConflicts).length) delete p._fieldConflicts;
  const saved = A.saveFoodMap(foodMap);
  if (!saved) { foodMap = A.loadFoodMap(); alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.'); return; }
  daSyncPushSafe();
  refreshFromStorage();
  detail(placeId);
}
/* 2026-09-11 재검토(11차) — 코스(날짜 단위) 필드 충돌 해결. 레거시
   코스(tripId 없음)는 city+date로 찾는다 — trip 코스는 아직 필드
   충돌을 만들 방법이 없다(날짜별 upsert만 하고 필드 병합을 안 함).
   foodMap.course는 foodMap.courses 안의 같은 객체를 가리키는
   포인터이므로 별도로 안 고쳐도 되지만, 동기화가 배열을 통째로
   새 객체로 갈아 끼우는 경우를 대비해 포인터도 다시 맞춘다. */
function resolveCourseFieldConflict(cityName, date, key) {
  const c = (foodMap.courses || []).find((x) => !x.tripId && x.city === cityName && x.date === date);
  if (!c || !c._fieldConflicts || !c._fieldConflicts[key]) return;
  if (c._fieldConflicts[key].theirs === undefined) delete c[key];
  else c[key] = c._fieldConflicts[key].theirs;
  delete c._fieldConflicts[key];
  if (!Object.keys(c._fieldConflicts).length) delete c._fieldConflicts;
  if (foodMap.course && !foodMap.course.tripId && foodMap.course.city === cityName && foodMap.course.date === date) foodMap.course = c;
  const saved = A.saveFoodMap(foodMap);
  if (!saved) { foodMap = A.loadFoodMap(); alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.'); return; }
  daSyncPushSafe();
  showSavedCourse();
}
/* 여행(trip) 필드 충돌 해결 — 이름·날짜·숙소처럼 여행 정보 자체가
   두 기기에서 다르게 저장된 경우. */
function resolveTripFieldConflict(tripId, key) {
  const trip = (foodMap.trips || []).find((x) => x.tripId === tripId);
  if (!trip || !trip._fieldConflicts || !trip._fieldConflicts[key]) return;
  if (trip._fieldConflicts[key].theirs === undefined) delete trip[key];
  else trip[key] = trip._fieldConflicts[key].theirs;
  delete trip._fieldConflicts[key];
  if (!Object.keys(trip._fieldConflicts).length) delete trip._fieldConflicts;
  const saved = A.saveFoodMap(foodMap);
  if (!saved) { foodMap = A.loadFoodMap(); alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.'); return; }
  daSyncPushSafe();
  render();
}
function resolveDup(aId, bId, action) {
  const result = A.resolveDup(foodMap.places, aId, bId, action);
  if (!result) return;
  /* 2026-09-09 코드 검토(2차): 저장된 코스(foodMap.course.stops·
     excludedIds)에도 삭제되는 쪽 id가 남아 있을 수 있다 — 여긴
     places 배열이 아니라 foodMap에 직접 딸린 데이터라서 A.resolveDup가
     손대지 않는다. 여기서 옮겨 두지 않으면 합친 뒤 "저장된 코스"를
     다시 열었을 때 이미 없어진 장소를 가리키는 조용한 참조 오류가
     남는다. saveFoodMap을 부르기 전에 옮겨야 이번 저장에 같이 반영된다. */
  if (result.survivorId && result.mergedId) {
    const from = result.mergedId, to = result.survivorId;
    /* 2026-09-10(멀티데이): 이제 코스가 여러 개(foodMap.courses, 날짜별로)
       있을 수 있다 — 합쳐진 장소가 그중 아무 날짜에나 들어 있을 수 있으니
       전부 훑어야 한다. foodMap.course는 courses 배열 안의 항목과 같은
       참조일 때가 많지만(daUpsertCourse가 그렇게 만든다), 저장 전 예전
       데이터처럼 배열이 비어 있고 course만 있는 경우도 있어 Set으로 모아
       중복 없이 둘 다 처리한다. */
    const targets = new Set([...(foodMap.courses || []), foodMap.course].filter(Boolean));
    targets.forEach((crs) => {
      if (Array.isArray(crs.stops)) crs.stops.forEach((s) => { if (s.id === from) s.id = to; });
      if (Array.isArray(crs.excludedIds)) crs.excludedIds = crs.excludedIds.map((id) => (id === from ? to : id));
      if (crs.excludedReasons && crs.excludedReasons[from] !== undefined) {
        crs.excludedReasons[to] = crs.excludedReasons[from];
        delete crs.excludedReasons[from];
      }
    });
  }
  /* 2026-09-10 재검토(7차) — 중복 병합으로 사라지는 쪽(mergedId)은
     서버 쪽 레코드에도 명시적으로 "지워졌다"고 알려야 한다. 그냥
     배열에서 빠진 채로 다음에 전체를 올리면, 이 사실을 아직 모르는
     오래된 기기가 나중에 그 id를 다시 들고 나타났을 때 "이 기기가
     이 장소를 아직 모른다"와 구분이 안 돼 되살아날 수 있다
     (server/routes/account-data.mjs의 syncPlaces 참고 — 무덤 표시는
     명시적으로 알려온 id만 지운다).
     2026-09-10 재검토(8차) — 삭제도 기준 버전 대조를 받는다(그 사이
     다른 기기가 이 장소를 실제로 고쳤으면 조용히 지우지 않기 위해).
     A.resolveDup가 배열에서 빼기 직전에 잡아 둔 mergedVersion을
     그대로 기준 버전으로 싣는다. */
  if (result.mergedId) {
    foodMap.deletedPlaceIds = foodMap.deletedPlaceIds || [];
    if (!foodMap.deletedPlaceIds.some((d) => d.id === result.mergedId)) {
      // 2026-09-11 재검토(9차) — survivorId를 함께 실어 둔다. 이 삭제가
      // 서버에서 "기준 버전이 안 맞다"고 반려되면(다른 기기가 그 사이
      // 이 장소를 실제로 고쳤다는 뜻) daSyncPush가 자동으로 재삭제하지
      // 않고, 되살린 최신 내용을 이 survivor와 다시 중복 후보로 이어야
      // 하는데 그때는 이미 원래 merge 호출 문맥을 알 수 없다 — 그래서
      // 지금 이 자리에서 미리 남겨 둔다.
      foodMap.deletedPlaceIds.push({ id: result.mergedId, baseVersion: result.mergedVersion || 0, survivorId: result.survivorId || null });
    }
  }
  const saved = A.saveFoodMap(foodMap);
  if (!saved) {
    /* 저장 실패 시 원상태로 복구 — 방금 합치거나 끊은 변경이 메모리에만
       남아 다음 저장에 몰래 섞이지 않게 한다(2026-09-09 코드 검토). */
    foodMap = A.loadFoodMap();
    alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.');
    return;
  }
  /* "오늘 갈 곳"(selected)·"오늘 동선"(route)에 방금 삭제된 쪽 id가
     들어 있었으면 살아남는 쪽으로 옮긴다 — 안 옮기면 화면에서 조용히
     빠진다(2026-09-09 코드 검토 — 일정 참조 이전). */
  if (result.survivorId && result.mergedId) {
    if (route.has(result.mergedId)) { route.delete(result.mergedId); route.add(result.survivorId); }
    if (selected.has(result.mergedId)) { selected.delete(result.mergedId); selected.add(result.survivorId); }
  }
  daSyncPushSafe();
  refreshFromStorage();
  updateCity();
  const stillThere = spots.find((s) => s.id === aId);
  if (stillThere) detail(aId); else sheet.close();
}
/* 2026-09-11 재검토(11차) 3절 — "장소 다중 선택에서 일괄 태그 추가·
   제거를 제공해." 이미 있는 다중 선택(#selectionbar)을 그대로 쓰고
   별도 대형 관리 화면은 만들지 않는다 — 태그 하나를 고른 뒤 붙이기/
   떼기 버튼만 누르면 된다. */
function bulkTagEditSheet(ids) {
  if (!ids.length) return;
  const known = A.tagEntries.slice().sort((a, b) => a.label.localeCompare(b.label));
  let pickedTag = null;
  open('태그 일괄 편집', `<div class="detail"><h2>${ids.length}곳에 태그 일괄 적용</h2>` +
    `<p class="inline-note">태그를 하나 고른 뒤, 고른 ${ids.length}곳 전부에 한 번에 붙이거나 뗄 수 있어요.</p>` +
    `<div class="filters" id="bulkTagChips" style="flex-wrap:wrap;overflow:visible">${known.map((t) => `<button data-bulk-tag="${A.esc(t.label)}">${A.esc(t.label)}</button>`).join('')}</div>` +
    `<div style="display:flex;gap:8px;margin-top:14px"><input id="bulkTagNewInput" placeholder="새 태그 이름" maxlength="20" style="flex:1"><button id="bulkTagNewBtn">추가</button></div>` +
    `<div style="display:flex;gap:8px;margin-top:14px"><button class="primary" id="bulkTagAddBtn" style="flex:1">고른 태그 붙이기</button><button id="bulkTagRemoveBtn" style="flex:1">고른 태그 떼기</button></div>` +
    `<button class="text-button" data-dismiss style="margin-top:10px">닫기</button></div>`);
  const pickChip = (b) => {
    $('#bulkTagChips').querySelectorAll('[data-bulk-tag]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    pickedTag = b.dataset.bulkTag;
  };
  $('#bulkTagChips').querySelectorAll('[data-bulk-tag]').forEach((b) => { b.onclick = () => pickChip(b); });
  $('#bulkTagNewBtn').onclick = () => {
    const label = A.normalizeTagLabel($('#bulkTagNewInput').value);
    if (!label) { alert('태그 이름을 확인해 주세요(1~20자, 빈 값 불가).'); return; }
    const r = A.createTag(label);
    if (!r.ok) { alert('태그를 만들지 못했어요.'); return; }
    const saved = A.saveFoodMap(foodMap);
    if (!saved) { foodMap = A.loadFoodMap(); alert('태그를 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.'); return; }
    daSyncPushSafe();
    const btn = document.createElement('button');
    btn.dataset.bulkTag = r.tag.label; btn.textContent = r.tag.label;
    btn.onclick = () => pickChip(btn);
    $('#bulkTagChips').appendChild(btn);
    pickChip(btn);
    $('#bulkTagNewInput').value = '';
  };
  const applyBulk = (add) => {
    if (!pickedTag) { alert('먼저 태그를 골라 주세요.'); return; }
    const changed = A.bulkSetTag(foodMap.places, ids, pickedTag, add);
    const saved = A.saveFoodMap(foodMap);
    if (!saved) { foodMap = A.loadFoodMap(); alert('저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.'); return; }
    daSyncPushSafe();
    refreshFromStorage();
    updateCity();
    selected.clear(); selecting = false; render();
    daToast(`${changed}곳에 "${pickedTag}" 태그를 ${add ? '붙였어요' : '뗐어요'}.`);
    sheet.close();
  };
  $('#bulkTagAddBtn').onclick = () => applyBulk(true);
  $('#bulkTagRemoveBtn').onclick = () => applyBulk(false);
}
$('#addRoute').onclick = () => {
  const ids = spots.filter((p) => p.city === city && selected.has(p.id)).map((p) => p.id);
  if (city === A.UNKNOWN_CITY) return cityAssignSheet(ids);
  ids.forEach((id) => { route.add(id); selected.delete(id); });
  selecting = false; render(); showRoute();
};
$('#bulkTagEdit').onclick = () => {
  const ids = spots.filter((p) => p.city === city && selected.has(p.id)).map((p) => p.id);
  bulkTagEditSheet(ids);
};
$('#route').onclick = showRoute;
document.querySelectorAll('[data-profile]').forEach((b) => { b.onclick = profile; });
document.querySelectorAll('[data-add]').forEach((b) => { b.onclick = add; });
$('#browse').onclick = () => $('.section-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
$('#home').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
$('#collection').onclick = () => $('.album').scrollIntoView({ behavior: 'smooth', block: 'center' });
$('#cityPicker').onclick = cityPicker;
$('#nearby').onclick = nearby;
if ($('#testLocationBannerClear')) {
  $('#testLocationBannerClear').onclick = () => { A.clearTestLocation(); renderTestLocationBanner(); render(); };
}

updateCity();
renderTestLocationBanner();
daResumeAfterTossRedirect();
