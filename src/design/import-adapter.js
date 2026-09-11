'use strict';
/**
 * 기능 통합 어댑터 — 승인 디자인(spots.js)에 실제 데이터를 연결하는 다리.
 *
 * 02_DESIGN_CONTRACT.md: "spots.js: 샘플 데이터와 UI 이벤트. 실데이터 어댑터로 대체"
 * 03_INTEGRATION_AND_ACCEPTANCE.md 1절: "현재 구조가 여전히 같은지 확인 후
 * 생성 파일만 단독 편집하는 실수를 피한다" — 그래서 파싱·저장·병합·도시 추측
 * 로직을 private/personal.html 에서 새로 만들지 않고 그대로 옮겼다(아래 각
 * 함수 위에 원본 위치를 적어 뒀다). private/personal.html 이 바뀌면 이 파일도
 * 같이 맞춰야 한다.
 *
 * 2026-09-09 제품 방향 확정: 장소 보관함(여러 도시)과 여행 일정(활성 하나)은
 * 다른 것이다. 이 파일은 "보관함" 쪽만 다룬다 — 일정 편집 연결은 다음 단계.
 * 자세한 근거·실측 수치는 docs/DESIGN_INTEGRATION_REPORT.md 참고.
 */

/* private/personal.html: const SALE_MODE / const PFX 와 같은 접두어를 써야
   같은 foodmap_v1 저장 데이터를 읽고 쓴다. 하드코딩 상수 대신 index.html의
   <meta name="sale-mode"> 를 읽는다 — 이 화면이 나중에 판매용(src/index.html)
   자리를 대체할 때 이 파일을 안 고치고 그 메타 태그 하나만 바꾸면 되게
   하기 위해서다(출시 전 체크리스트: docs/DESIGN_INTEGRATION_REPORT.md). */
const SALE_MODE = (document.querySelector('meta[name="sale-mode"]') || {}).content === 'true';
const PFX = SALE_MODE ? 'cs1_' : 'cp1_';

function daLoad(k, f) {
  try { const r = localStorage.getItem(PFX + k); return r ? JSON.parse(r) : f; }
  catch (e) { return f; }
}
function daSave(k, v) {
  try { localStorage.setItem(PFX + k, JSON.stringify(v)); return true; }
  catch (e) { return false; }
}

/* 2026-09-11 재검토(9차) 6-3절 — "한국에 있으면서 현지 위치인 것처럼
   테스트"하는 앱 안 기능. OS의 실제 GPS를 흉내 내거나 가로채지 않는다
   (navigator.geolocation을 건드리지 않음) — 그냥 앱 로직이 참고하는
   "위치"를 사람이 명시적으로 지정한 값으로 바꿔치기할 뿐이다. 그래서
   이 기능만으로 실제 로밍·도보·현지 GPS 조건을 검증했다고 절대 주장할
   수 없다(문서에도 그대로 남긴다).
   허용 대상: 지금은 이 저장소에 "승인된 테스트 계정/스테이징" 화이트
   리스트 메커니즘이 없어서, 최소 구현으로 URL에 ?testmode=1을 한 번
   붙이면 이 브라우저에 계속 풀리는 방식을 쓴다. 실제로 특정 계정만
   허용하려면 서버 쪽에 계정 화이트리스트(예: accounts.test_access
   플래그)와 그걸 확인하는 API가 새로 필요하다 — 지금은 없다. */
/* 2026-09-11 재검토(10차) 7절 — ChatGPT 지적: "?testmode=1만으로 개발자
   권한이 생기는 구조는 운영용 접근 제한이 아니다. 스테이징 또는
   서버가 허용한 테스트 계정에 제한해." 예전엔 URL 파라미터 한 번이면
   이 브라우저에 영구히 풀렸다(localStorage 플래그) — 관리자가 나중에
   권한을 뺏어도 클라이언트가 그 사실을 모르면 계속 열려 있었다.
   이제는 클라이언트가 스스로 권한을 주장하지 않는다: 서버가 실제로
   이 "계정"을 승인했는지(관리자만 켤 수 있음, /api/admin/test-access)
   로그인된 세션으로 매번 물어보고, 그 응답만 신뢰한다. ?testmode=1은
   더 이상 그 자체로 아무것도 풀지 않는다 — 로그인된 계정이 실제로
   서버 승인을 받았어야만 의미가 있다. */
let _testAccessGranted = false;
function daTestModeAllowed() { return _testAccessGranted; }
async function daRefreshTestAccess(token) {
  if (!token) { _testAccessGranted = false; return false; }
  try {
    const r = await daApi('/api/account/test-access', { token });
    _testAccessGranted = !!(r.ok && r.json && r.json.testAccess);
  } catch (e) { _testAccessGranted = false; }
  return _testAccessGranted;
}
const TEST_LOCATION_PRESETS = [
  { id: 'hakata', label: '하카타역(테스트)', lat: 33.5904, lng: 130.4207 },
  { id: 'tenjin', label: '텐진(테스트)', lat: 33.5911, lng: 130.3987 },
];
function daGetTestLocation() { return daLoad('test_location_v1', null); }
function daSetTestLocation(loc) {
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number' || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return false;
  return daSave('test_location_v1', { lat: loc.lat, lng: loc.lng, label: String(loc.label || '테스트 위치') });
}
function daClearTestLocation() { try { localStorage.removeItem(PFX + 'test_location_v1'); return true; } catch (e) { return false; } }

/* 2026-09-10 재검토(7차) — 장소마다 version을 매겨 서버 동기화가 버전
   비교로 충돌(오래된 기기가 최신 수정을 덮어쓰는 것)을 감지할 수 있게
   한다(account-data.mjs의 syncPlaces 참고).
   2026-09-10 재검토(8차) — ChatGPT가 재현한 결함: 이 파일이 "내용이
   바뀌면 버전을 로컬에서 스스로 올린다"고 했던 게 문제의 근원이었다.
   서버는 클라이언트가 보내는 version을 "이 수정이 근거로 삼은 서버
   버전"(기준 버전)으로 취급하고 정확히 같을 때만 수락하는데, 클라
   이언트가 자기 마음대로 버전을 미리 올려 보내면 그 값은 더 이상
   "내가 실제로 읽은 서버 버전"이 아니게 된다 — 원본(버전 1)에서 시작한
   두 기기가 각자 편집 후 똑같이 "버전 2"를 계산해 보내면, 서버 입장
   에서는 둘 다 "내가 버전 2를 봤다"고 우기는 것과 구분이 안 된다.
   그래서 이제 이 파일은 **절대 version을 스스로 올리지 않는다** —
   version은 오직 서버가 응답으로 알려준 값을 그대로 받아들일 때만
   바뀐다(trips/visits가 원래부터 이렇게 동작한다 — 로컬에서 새
   버전을 계산하는 코드가 없다). 대신 이 파일은 "마지막으로 서버와
   맞춘 시점의 내용"을 스냅샷으로 남겨 두고, 그 스냅샷과 지금 로컬
   내용을 비교해 "이 기기가 로컬에서 실제로 무엇을 고쳤는지"를
   3-way 재병합(daRemergePlaceConflict, spots.js)이 알아낼 수 있게
   해 준다 — 버전 발급이 아니라 "충돌 시 무엇이 내 변경인지 판별"
   용도로 역할이 바뀐 것이다. */
let _placesVersionSnapshot = null; // Map<id, JSON 문자열(version/updatedAt 제외)> — 마지막으로 서버와 맞춘 내용
function _placeContentKey(p) {
  const { version, updatedAt, ...rest } = p;
  return JSON.stringify(rest);
}
/* 세션 시작 시(로드) 또는 저장 시 불린다. 이번 세션에서 처음 보는
   (버전 필드가 아예 없는) 장소만 0으로 초기화한다 — 0은 "이 로컬
   id를 서버가 아직 모른다"는 뜻이라, syncPlaces가 baseVersion과
   무관하게 새 레코드로 받아들인다. 이미 버전이 있는 장소(서버에서
   받아온 것 등)는 절대 건드리지 않는다. */
function _stampPlaceVersions(places) {
  if (!Array.isArray(places)) return;
  const now = new Date().toISOString();
  for (const p of places) {
    if (!p || !p.id) continue;
    if (p.version === undefined) p.version = 0;
    if (p.updatedAt === undefined) p.updatedAt = now;
  }
}
/* 서버와 실제로 내용이 맞춰진 직후(로그인 직후 풀, 푸시가 성공적으로
   반영된 항목들) 불러 기준선을 다시 잡는다 — 다음 충돌이 났을 때
   "그때 이후로 내가 실제로 뭘 고쳤는지"를 정확히 비교할 수 있게.
   2026-09-11 재검토(9차) — ChatGPT가 지적한 버그: 충돌 재병합 직후
   이 함수를 부를 때 places 배열에는 "서버가 실제로 확정한 값"이
   아니라 "재병합으로 내가 고른 값(merged)"이 섞여 있다. 그 merged를
   그대로 기준선으로 삼으면, 다음 충돌 판정 때 "내가 방금 지킨 값"과
   "기준"이 똑같아져 실제로 내가 고친 필드를 "안 건드림"으로 오인해
   서버 값으로 조용히 되돌려 버릴 수 있다. overrides(id→서버가 지금
   실제로 확정한 내용)를 주면, 그 id는 places 배열의 값 대신
   overrides 쪽을 기준선으로 쓴다 — 병합 대기 중인 로컬 픽이 아니라
   "서버가 진짜로 갖고 있는 값"이 항상 기준이 되게 한다. */
function _resetPlacesSnapshot(places, overrides) {
  const next = new Map();
  for (const p of (places || [])) {
    if (!p || !p.id) continue;
    const src = (overrides && overrides.has(p.id)) ? overrides.get(p.id) : p;
    next.set(p.id, _placeContentKey(src));
  }
  _placesVersionSnapshot = next;
  _persistBaselines();
}
/* 충돌 재병합(daRemergePlaceConflict, spots.js)이 "이 장소가 마지막
   으로 서버와 맞춰졌을 때 어떤 내용이었는지"를 읽을 수 있게 해 준다.
   스냅샷에 없으면(이번 기기가 이 장소를 처음 다루는 경우 등) null —
   호출부가 그 경우 서버 값을 그대로 받아들이는 안전한 기본 동작으로
   대체한다. */
function _getPlaceBaseline(id) {
  if (!_placesVersionSnapshot || !_placesVersionSnapshot.has(id)) return null;
  try { return JSON.parse(_placesVersionSnapshot.get(id)); } catch (e) { return null; }
}
/* 2026-09-11 재검토(10차) — ChatGPT 재현: courses/trips 충돌 시 "버전만
   바꿔 로컬 객체 전체를 재제출"해 서버가 독립적으로 고친 필드까지
   통째로 덮어썼다(예: {city,date,note:'base'} v1 → A가 note='SERVER-
   NEW' 저장 v2 → B가 v1 기준으로 note='LOCAL-NEW' 저장 시도 → 재시도
   성공 순간 SERVER-NEW가 완전히 사라짐). places처럼 "마지막으로 서버와
   맞춘 시점의 내용"을 기준선으로 남겨 둬야 daRemergeGenericConflict가
   "이 필드를 내가 실제로 고쳤는지" 판별할 수 있다 — 기준선이 없으면
   모든 다른 필드를 "내가 고쳤을 수도"로 봐야 해서(안전 쪽으로 치우침)
   실제로는 손대지 않은 필드까지 로컬 값이 서버의 진짜 변경을 덮어쓸
   위험이 남는다. places와 동일한 패턴을 courses(city+date 키)·
   trips(tripId 키)에도 그대로 적용한다. */
let _coursesVersionSnapshot = null; // Map<'city__date', JSON 문자열(version/updatedAt 제외)>
function _courseKey(c) { return `${c.city}__${c.date}`; }
function _courseContentKey(c) {
  const { version, updatedAt, ...rest } = c;
  return JSON.stringify(rest);
}
function _resetCoursesSnapshot(courses, overrides) {
  const next = new Map();
  for (const c of (courses || [])) {
    if (!c || !c.city || !c.date || c.tripId) continue; // trip에 딸린 코스는 trips 쪽 스냅샷이 담당.
    const key = _courseKey(c);
    const src = (overrides && overrides.has(key)) ? overrides.get(key) : c;
    next.set(key, _courseContentKey(src));
  }
  _coursesVersionSnapshot = next;
  _persistBaselines();
}
function _getCourseBaseline(city, date) {
  const key = `${city}__${date}`;
  if (!_coursesVersionSnapshot || !_coursesVersionSnapshot.has(key)) return null;
  try { return JSON.parse(_coursesVersionSnapshot.get(key)); } catch (e) { return null; }
}
let _tripsVersionSnapshot = null; // Map<tripId, JSON 문자열(version/updatedAt/courses 제외)>
function _tripContentKey(t) {
  const { version, updatedAt, courses, ...rest } = t; // courses는 daSyncPush가 별도로 붙이는 파생 필드 — 본문 비교에서 제외.
  return JSON.stringify(rest);
}
function _resetTripsSnapshot(trips, overrides) {
  const next = new Map();
  for (const t of (trips || [])) {
    if (!t || !t.tripId) continue;
    const src = (overrides && overrides.has(t.tripId)) ? overrides.get(t.tripId) : t;
    next.set(t.tripId, _tripContentKey(src));
  }
  _tripsVersionSnapshot = next;
  _persistBaselines();
}
function _getTripBaseline(tripId) {
  if (!_tripsVersionSnapshot || !_tripsVersionSnapshot.has(tripId)) return null;
  try { return JSON.parse(_tripsVersionSnapshot.get(tripId)); } catch (e) { return null; }
}
/* 2026-09-11 재검토(12차) — ChatGPT가 실제로 재현한 결함: 태그 저장
   요청이 나간 뒤 응답이 오기 전에 같은 태그를 로컬에서 또 고치면,
   응답 처리가 "요청 시점 이후 로컬이 더 바뀌었는지"를 전혀 안 보고
   서버가 돌려준(=요청 시점 값) 내용으로 무조건 덮어써 방금 한 수정을
   잃어버렸다 — places/courses/trips에는 있던 기준선(baseline) 추적이
   태그에는 아예 없었다. 같은 패턴을 태그에도 그대로 적용한다. */
let _tagsVersionSnapshot = null; // Map<tagId, JSON 문자열(version 제외)>
function _tagContentKey(tg) {
  const { version, ...rest } = tg;
  return JSON.stringify(rest);
}
function _resetTagsSnapshot(tags, overrides) {
  const next = new Map();
  for (const t of (tags || [])) {
    if (!t || !t.id) continue;
    const src = (overrides && overrides.has(t.id)) ? overrides.get(t.id) : t;
    next.set(t.id, _tagContentKey(src));
  }
  _tagsVersionSnapshot = next;
  _persistBaselines();
}
function _getTagBaseline(id) {
  if (!_tagsVersionSnapshot || !_tagsVersionSnapshot.has(id)) return null;
  try { return JSON.parse(_tagsVersionSnapshot.get(id)); } catch (e) { return null; }
}
/* 2026-09-11 재검토(10차) — ChatGPT가 점검하라고 지시한 세 번째 항목:
   "기준 스냅샷의 재시작 보존"을 실제로 재현해 확인한 결과, 이것도 진짜
   결함이었다(합성 재현: 오프라인/재시작 전 고친 값이 다른 기기의 늦은
   수정으로 조용히 사라짐). 원인 — _placesVersionSnapshot 등은 메모리
   에만 있고 앱 새로고침/재시작 때 사라지는데, loadFoodMap이 그 자리를
   "지금 로컬 스토리지에 있는 내용"으로 다시 채웠다. 그런데 그 내용이
   아직 서버에 못 올라간 미동기화 수정이면, 그 수정 자체가 "기준"이
   돼 버려 다음 충돌 때 "안 건드림"으로 오인해 조용히 서버 값(다른
   기기의 것)으로 되돌려진다. 기준선을 별도 localStorage 키에 "마지막
   으로 서버와 실제로 맞춘 시점의 내용"으로 지속시켜, 재시작해도
   "지금 로컬에 뭐가 있는지"가 아니라 "마지막 동기화가 뭐였는지"를
   구분할 수 있게 한다. 계정 전환 시 이 값이 새 계정으로 새는 걸
   막기 위해 로그아웃 때 반드시 clearSyncBaselines로 함께 지운다
   (courses는 city+date 키라 계정이 달라도 같은 도시·날짜 키가 겹칠
   수 있어 특히 중요). */
const BASELINE_STORAGE_KEY = 'sync_baseline_v1';
function _persistBaselines() {
  const places = {}, courses = {}, trips = {}, tags = {};
  if (_placesVersionSnapshot) for (const [k, v] of _placesVersionSnapshot) places[k] = v;
  if (_coursesVersionSnapshot) for (const [k, v] of _coursesVersionSnapshot) courses[k] = v;
  if (_tripsVersionSnapshot) for (const [k, v] of _tripsVersionSnapshot) trips[k] = v;
  if (_tagsVersionSnapshot) for (const [k, v] of _tagsVersionSnapshot) tags[k] = v;
  daSave(BASELINE_STORAGE_KEY, { places, courses, trips, tags });
}
function _restoreBaselinesFromStorage() {
  const persisted = daLoad(BASELINE_STORAGE_KEY, null);
  _placesVersionSnapshot = new Map(Object.entries((persisted && persisted.places) || {}));
  _coursesVersionSnapshot = new Map(Object.entries((persisted && persisted.courses) || {}));
  _tripsVersionSnapshot = new Map(Object.entries((persisted && persisted.trips) || {}));
  _tagsVersionSnapshot = new Map(Object.entries((persisted && persisted.tags) || {}));
}
function _clearSyncBaselines() {
  _placesVersionSnapshot = new Map();
  _coursesVersionSnapshot = new Map();
  _tripsVersionSnapshot = new Map();
  _tagsVersionSnapshot = new Map();
  try { localStorage.removeItem(PFX + BASELINE_STORAGE_KEY); } catch (e) { /* 무시 */ }
}
/* 2026-09-09 코드 검토 반영 — sale-mode 메타 태그를 바꾸는 것만으로는
   cp1_ 데이터가 cs1_로 옮겨지지 않는다(그냥 다른 storage 칸을 보기
   시작할 뿐이다). 이 화면이 실제 판매용 자리를 대체하는 순간 사용자
   storage가 갈라지는 문제를 여기서 미리 해결해 둔다.
   - cp1_로 시작하는 모든 키(foodmap_v1 뿐 아니라 이 앱이 쓰는 모든 개인용
     키)를 대응하는 cs1_ 키로 복사한다. 이미 cs1_ 쪽에 값이 있는 키는
     안 건드린다(사용자가 판매용에서 이미 쌓은 데이터를 안 덮는다).
   - 원본 cp1_ 키는 절대 지우지 않는다 — 실패해도 원본이 남아 있어야
     복구할 수 있다.
   - 이전에 실패하면(예: 저장 공간 가득 참) 이번에 새로 쓴 cs1_ 키만
     되돌리고 "다음에 다시 시도"할 수 있게 완료 표시를 안 남긴다.
   - 한 번 끝나면 cs1_migrated_v1 표시를 남겨 매번 전체 키를 다시
     스캔하지 않게 한다. */
function daMigrateStorage() {
  if (!SALE_MODE) return { migrated: false, reason: 'not-sale-mode' };
  try {
    if (localStorage.getItem('cs1_migrated_v1')) return { migrated: false, reason: 'already-done' };
    const keysToMigrate = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('cp1_') === 0 && localStorage.getItem('cs1_' + k.slice(4)) === null) keysToMigrate.push(k);
    }
    if (!keysToMigrate.length) {
      try { localStorage.setItem('cs1_migrated_v1', '1'); } catch (e) { /* 표시 실패는 무시 — 다음에 다시 스캔만 하면 됨 */ }
      return { migrated: false, reason: 'nothing-to-migrate' };
    }
    const written = [];
    try {
      keysToMigrate.forEach((k) => {
        const newKey = 'cs1_' + k.slice(4);
        localStorage.setItem(newKey, localStorage.getItem(k));
        written.push(newKey);
      });
      localStorage.setItem('cs1_migrated_v1', '1');
      return { migrated: true, keys: keysToMigrate };
    } catch (e) {
      written.forEach((k) => { try { localStorage.removeItem(k); } catch (e2) { /* 되돌리기 자체가 실패해도 cp1_ 원본은 그대로다 */ } });
      return { migrated: false, reason: 'write-failed', error: String(e && e.message || e) };
    }
  } catch (e) {
    return { migrated: false, reason: 'error', error: String(e && e.message || e) };
  }
}
daMigrateStorage();

/* private/personal.html: const esc= — 그대로 옮김. */
const daEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* private/personal.html: function fm2Coord — 그대로 옮김 */
function fm2Coord(v, max) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}

/* private/personal.html: function fmCoordFromUrl — 그대로 옮김. */
function daCoordFromUrl(u) {
  const t = String(u || '');
  if (!t) return null;
  let m = t.match(/!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) m = t.match(/[@](-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) m = t.match(/(?:[?&](?:q|ll|sll|center|daddr|destination|query)|query)=(-?\d{1,3}(?:\.\d+)?)(?:,|%2C)(-?\d{1,3}(?:\.\d+)?)/i);
  if (!m) return null;
  const lat = fm2Coord(m[1], 90), lng = fm2Coord(m[2], 180);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return null;
  return { lat, lng };
}

/* private/personal.html: function fmCsvRows — 그대로 옮김 */
function daCsvRows(txt) {
  const rows = []; const row = []; let cur = ''; let q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (c === '"') { if (q && txt[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { row.push(cur); cur = ''; }
    else if ((c === '\n' || c === '\r') && !q) {
      if (c === '\r' && txt[i + 1] === '\n') i++;
      row.push(cur);
      if (row.some((x) => x.trim())) rows.push(row.splice(0)); else row.length = 0;
      cur = '';
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/* private/personal.html: function fmCsv — 그대로 옮김. 한글·영문 헤더 둘 다 받는다. */
function daCsv(txt) {
  const rows = daCsvRows(txt);
  if (rows.length < 2) return [];
  const h = rows[0].map((x) => x.trim().toLowerCase().replace(/^﻿/, ''));
  return rows.slice(1).map((r) => {
    const o = {}; h.forEach((k, i) => { o[k] = r[i] || ''; });
    return {
      name: o.title || o.name || o['business name'] || o['제목'] || o['이름'] || o['장소'] || '',
      url: o.url || o['google maps url'] || o.google_maps_url || o['링크'] || '',
      note: o.note || o.comments || o.description || o['메모'] || o['설명'] || o['댓글'] || '',
      address: o.address || o['주소'] || '',
      lat: +(o.latitude || o.lat || o['위도']) || null,
      lng: +(o.longitude || o.lng || o['경도']) || null,
      // 2026-09-11 재검토(9차) 6-1절 — 원본 파일에 실제 저장 날짜 열이
      // 있으면(일부 내보내기 형식만 해당) 최대한 살려 둔다. 없으면
      // undefined로 남고, 지어내지 않는다("원본에 저장 날짜가 없으면
      // 지어내지 않는다").
      originalSavedAt: o['saved date'] || o['date saved'] || o['저장일'] || o['저장 날짜'] || o.date || undefined,
    };
  }).filter((x) => x.name).map((x) => {
    if (x.lat === null || x.lng === null) {
      const c = daCoordFromUrl(x.url);
      if (c) { x.lat = c.lat; x.lng = c.lng; x.latFrom = 'url'; }
    }
    return x;
  });
}

/* private/personal.html: fmObj / fmJson (라이브 재정의판) — 그대로 옮김. */
function daObj(o) {
  if (!o || typeof o !== 'object') return null;
  const p = o.properties || o;
  const raw = p.Location || p.location || o.Location || {};
  const loc = Array.isArray(raw) ? (raw[0] || {}) : raw;
  const geo = loc['Geo Coordinates'] || loc.geoCoordinates || p.geoCoordinates || {};
  const co = o.geometry && Array.isArray(o.geometry.coordinates) ? o.geometry.coordinates : [];
  const name = p.name || p.Name || p.title || p.Title || p['Business Name'] || loc['Business Name'] || loc.name || '';
  if (!name) return null;
  const out = {
    name: String(name),
    note: String(p.note || p.Note || p.comments || p.Comments || p.description || p.Description || ''),
    address: String(p.address || p.Address || loc.address || ''),
    url: String(p.google_maps_url || p['Google Maps URL'] || p.googleMapsUrl || p.URL || p.url || loc['Google Maps URL'] || ''),
    lat: +(p.lat || geo.Latitude || geo.latitude || p.latitude || co[1]) || null,
    lng: +(p.lng || geo.Longitude || geo.longitude || p.longitude || co[0]) || null,
    cat: p.cat || '',
    // 2026-09-11 재검토(9차) 6-1절 — Google Takeout의 "저장한 장소"
    // GeoJSON은 feature.properties.date에 실제 저장 시각을 담아 줄 때가
    // 있다(형식마다 다름 — 없으면 undefined로 남긴다, 지어내지 않음).
    originalSavedAt: p.date || o.date || undefined,
  };
  if (out.lat === null || out.lng === null) {
    const c = daCoordFromUrl(out.url);
    if (c) { out.lat = c.lat; out.lng = c.lng; out.latFrom = 'url'; }
  }
  return out;
}
function daJson(j) {
  const direct = j && (j.places || j.spots);
  if (Array.isArray(direct)) return direct.map(daObj).filter(Boolean);
  const out = []; const seen = new Set();
  function walk(x) {
    if (!x || typeof x !== 'object') return;
    const v = daObj(x);
    if (v) {
      const k = v.url || (v.name + '|' + v.lat + '|' + v.lng);
      if (!seen.has(k)) { seen.add(k); out.push(v); return; }
    }
    if (Array.isArray(x)) x.forEach(walk);
    else Object.keys(x).forEach((k) => { if (typeof x[k] === 'object') walk(x[k]); });
  }
  walk(j);
  return out;
}

/* 06_UPDATES_AND_EXPORT_CORRECTION.md: 리뷰 데이터는 장소가 아니므로 제외. */
function daIsReviewFeature(x) {
  return !!(x && x.properties && (('five_star_rating_published' in x.properties) || ('questions' in x.properties)));
}
function daJsonPlaces(j) {
  if (j && j.type === 'FeatureCollection' && Array.isArray(j.features)) {
    return daJson({ features: j.features.filter((f) => !daIsReviewFeature(f)) });
  }
  return daJson(j);
}

/* private/personal.html: function fm2HasCoords — 그대로 옮김 */
function daHasCoords(p) { return !!p && fm2Coord(p.lat, 90) !== null && fm2Coord(p.lng, 180) !== null; }

/* private/personal.html: function fmLink — 그대로 옮김. 실제 저장된 링크 최우선. */
function daLink(p) {
  if (p.url) return p.url;
  const q = p.lat && p.lng ? (p.lat + ',' + p.lng) : p.name;
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}

/* private/personal.html: const FM_CITY_ALT — 그대로 옮김(도시 이름 → 대체 표기 정규식). */
/* private/personal.html: const FM_INFER / function fmInfer — 그대로 옮김.
   이름·메모·주소 텍스트로 유형을 짐작한다. 한국어뿐 아니라 일본어·영어·
   프랑스어·터키어·베트남어 등 여러 언어 낱말을 같이 봐서 특정 여행지
   전용이 아니다(2026-09-09 코드 검토 — 후쿠오카 전용으로 만들지 말 것).
   순서가 규칙이다 — 위에서 걸리면 아래는 안 본다. */
const FM_INFER = [
  ['숙소', /ホテル|旅館|民宿|hotel|hôtel|otel\b|hostel|호스텔|호텔|숙소|료칸|inn\b|resort|guest ?house|ryokan|khách sạn|pension|auberge|albergo|posada|hospedaje|b&b|motel|lodge/],
  ['교통', /駅|空港|港|バス|station|gare\b|istasyon|havaliman|aéroport|airport|aeropuerto|flughafen|bahnhof|metro|subway|터미널|역$|공항|terminal|bến xe|ga hà|bus stop|port\b|ferry|pier/],
  ['사우나·온천', /温泉|銭湯|サウナ|onsen|sento|온천|사우나|찜질|족욕|열탕|노천탕|sauna|hamam|hammam|banya|therme|thermal|bath ?house|ancient baths|\bbaths\b|bagno termale/],
  ['마사지·스파', /マッサージ|エステ|massage|\bspa\b|마사지|스파|에스테|아로마|경락|발마사지|타이마사지|foot ?massage|reflexolog|masaj|mát ?xa|wellness|salon de massage|masaje/],
  ['약국·병원', /薬局|ドラッグ|病院|クリニック|pharmac|farmacia|farmácia|apotheke|eczane|nhà thuốc|drug ?store|hospital|hôpital|hastane|bệnh viện|clinic|clinique|klinik|약국|병원|의원|응급|치과|드럭스토어|메디컬|boots\b|walgreens|\bcvs\b|medical/],
  ['카페·디저트', /カフェ|珈琲|喫茶|パン|coffee|caf[eé]|kahve|kaffee|caff[eè]|cà ?phê|kopi\b|boulangerie|p[aâ]tisserie|bakery|panader|konditorei|pasticceria|gelat|dessert|tea ?house|tearoom|çay|카페|디저트|베이커리|제과|빵집|brunch/],
  ['바·이자카야', /居酒屋|酒場|屋台|バー|クラブ|パブ|\bbar\b|\bbars\b|\bpub\b|\bclub\b|lounge|meyhane|birahane|bodega|cantina|taberna|kneipe|weinstube|brauerei|brewery|taproom|\bale\b|\bbia\b|\bbeer\b|birreria|cocktail|whisk|vinoteca|wine ?bar|이자카야|포차|술집|클럽|나이트|펍|라운지|와인바|위스키/],
  ['관광·명소', /神社|寺|城|公園|展望|博物館|美術館|shrine|temple|tempel|\bwat\b|chùa|đền|cami|camii|mosque|mezquita|church|chiesa|iglesia|kirche|église|cathedral|cathédrale|basilica|museum|mus[eé]e|museo|müze|gallery|galleria|galerie d'art|palace|palais|palazzo|saray|castle|château|schloss|castillo|kale\b|tower|\btour\b|kule|park\b|parc\b|parque|jardin|garden|bahçe|giardin|square|plaza|meydan|piazza|bridge|pont\b|köprü|puente|monument|statue|beach|plage|playa|sahil|공원|신사|사찰|전망|박물관|미술관|해변|성당|사원/],
  ['쇼핑', /百貨店|モール|市場|ショップ|\bstore\b|\bshop\b|market|marché|mercado|mercato|markt|pazar|pasar\b|çarşı|\bmall\b|galeries|boutique|chợ|department|outlet|쇼핑|시장|백화점|마트|편의점/],
  ['맛집·식당', /寿司|鮨|刺身|海鮮|ラーメン|うどん|焼鳥|焼肉|restaurant|restaurante|ristorante|trattoria|osteria|taverna|lokanta|sofras|meze|bistro|brasserie|comptoir|pizzeria|pizza|burger|steak|grill|kitchen|diner|eatery|noodle|\bphở?\b|\bbún\b|\bcơm\b|nhà hàng|quán\b|warung|som ?tam|pad ?thai|khao\b|tom ?yum|\bkrua\b|taquer|taco|tapas|curry|kebab|döner|dönerci|식당|맛집|스시|라멘|우동|야키토리|고기|국밥|분식/],
];
function daInfer(s) {
  s = String(s || '').toLowerCase();
  for (let i = 0; i < FM_INFER.length; i++) if (FM_INFER[i][1].test(s)) return FM_INFER[i][0];
  return '기타';
}
/* 2026-09-11 재검토(9차) 6-2절 — 세계 공통 상위분류(FM_INFER의 단일
   category)는 그대로 두고, 그 위에 세부 다중 태그를 얹는다. 한 장소가
   여러 태그를 동시에 가질 수 있다(예: 야키토리+이자카야). 이름이
   다른 동의어(주판점/리커샵/주류샵 등)는 여기서 한 태그로 합쳐 둔다 —
   일본 한정이 아니라 태국·이탈리아·카페·마사지 등에도 같은 방식을 쓴다.
   시작 어휘일 뿐 필요하면 늘릴 수 있다("불확실하면 미분류" 원칙은
   daInferTags가 빈 배열을 돌려주는 것으로 지킨다 — 억지로 아무 태그나
   붙이지 않는다). */
/* 2026-09-11 재검토(10차) 4절 — ChatGPT가 실제로 재현한 두 가지 오분류:
   ① daInferTags('居酒屋') → ['이자카야','주류샵'] : 酒屋가 居酒屋의
      부분 문자열이라 이자카야 가게가 주류샵으로도 잘못 겹쳐 잡힌다.
   ② daInferTags('스시 말고 라멘 먹기') → ['스시','라멘'] : "말고"(부정·
      계획 문장)로 실제로는 뺀 항목을 업종 근거로 오인했다.
   또한 "21개 고정 정규식이 허용 목록 전체"라는 설계를 버리고, 태그
   ID·표시명·동의어·출처를 분리한 레지스트리로 바꾼다. 기존 데이터와의
   호환을 위해 place.tags에는 지금처럼 "표시명(label) 문자열"을 그대로
   저장한다(비파괴적 이전 — 데이터 마이그레이션이 필요 없다). id는
   내부적으로 동의어 연결·향후 다국어 표시명 분리(영어 지원 구조,
   10차 8절)에 쓰기 위한 안정적인 키일 뿐, 지금 저장 형식은 그대로다. */
const TAG_REGISTRY_BUILTIN = [
  { id: 'yakitori', label: '야키토리', pattern: /焼き?鳥|やきとり|야키토리|닭꼬치|yakitori|chicken ?skewer/, synonyms: [] },
  { id: 'sushi', label: '스시', pattern: /寿司|鮨|스시|초밥|\bsushi\b/, synonyms: [] },
  { id: 'ramen', label: '라멘', pattern: /ラーメン|라멘|\bramen\b/, synonyms: [] },
  { id: 'udon_soba', label: '우동·소바', pattern: /うどん|そば|蕎麦|우동|소바|\budon\b|\bsoba\b/, synonyms: [] },
  { id: 'izakaya', label: '이자카야', pattern: /居酒屋|이자카야|\bizakaya\b/, synonyms: [] },
  // 2026-09-11 재검토(10차) — 酒屋 앞이 居가 아닐 때만 매칭(居酒屋의
  // 부분 문자열로 잘못 겹쳐 잡히는 것 방지). 룩비하인드 대신 문자
  // 클래스 제외를 써서 오래된 브라우저에서도 동작한다.
  { id: 'liquor_shop', label: '주류샵', pattern: /(?:^|[^居])酒屋|주류샵|주판점|리커샵|리큐어\s?샵|사케샵|와인샵|liquor ?store|bottle ?shop|off-licen[cs]e|wine ?shop/, synonyms: [] },
  { id: 'okonomiyaki', label: '오코노미야키', pattern: /お好み焼き|오코노미야키|okonomiyaki/, synonyms: [] },
  { id: 'takoyaki', label: '타코야키', pattern: /たこ焼き|타코야키|takoyaki/, synonyms: [] },
  { id: 'tonkatsu', label: '돈카츠', pattern: /とんかつ|돈카츠|tonkatsu|\bkatsu\b/, synonyms: [] },
  { id: 'tempura', label: '텐푸라', pattern: /天ぷら|텐푸라|튀김|tempura/, synonyms: [] },
  { id: 'thai_food', label: '타이음식', pattern: /타이음식|타이푸드|팟타이|똠얌|thai food|pad ?thai|tom ?yum/, synonyms: [] },
  { id: 'italian', label: '이탈리안', pattern: /이탈리안|이태리 ?음식|ristorante|trattoria|osteria|파스타|\bpasta\b|피자|pizzeria/, synonyms: [] },
  { id: 'cafe', label: '카페', pattern: /카페|커피|coffee|caf[eé]/, synonyms: [] },
  { id: 'bakery_dessert', label: '베이커리·디저트', pattern: /베이커리|제과|빵집|디저트|bakery|p[aâ]tisserie|dessert/, synonyms: [] },
  { id: 'massage', label: '마사지', pattern: /마사지|massage/, synonyms: [] },
  { id: 'spa_onsen', label: '스파·온천', pattern: /스파|온천|찜질|\bspa\b|onsen|thermal|therme/, synonyms: [] },
  { id: 'bbq_grill', label: '바베큐·그릴', pattern: /바베큐|그릴|고기집|barbecue|\bbbq\b|\bgrill\b/, synonyms: [] },
  { id: 'french', label: '프렌치', pattern: /프렌치|프랑스 ?요리|bistro|brasserie|french restaurant/, synonyms: [] },
  { id: 'mexican', label: '멕시칸', pattern: /멕시칸|타케리아|taco|taquer[ií]a|mexican/, synonyms: [] },
  { id: 'indian_curry', label: '인도·커리', pattern: /인도음식|커리|\bcurry\b|indian food/, synonyms: [] },
  { id: 'chinese', label: '중식', pattern: /중식|중국요리|chinese restaurant|dim ?sum|딤섬/, synonyms: [] },
];
/* 사용자가 만든 태그·기본 태그 표시명 override(foodMap.customTags에
   저장) — loadFoodMap이 채우고 CRUD 함수(daCreateTag/daRenameTag/
   daDeleteCustomTag)가 갱신한다. 한 항목은 둘 중 하나다:
   - source:'user' — 사용자가 직접 만든 진짜 새 태그.
   - source:'builtin-override' — 기본 태그(TAG_REGISTRY_BUILTIN) 하나의
     "이 계정에서만 다르게 보일 표시명"(id가 그 기본 태그의 id와 같다).
   2026-09-11 재검토(11차) — "기본 태그 이름 변경을 허용한다면 원본
   전역 배열을 수정하지 말고 계정별 표시명으로 저장해"라는 지시 반영.
   TAG_REGISTRY_BUILTIN은 이 페이지가 켜져 있는 동안 모든 계정이 같은
   모듈 인스턴스를 공유하는 상수이므로, 직접 고치면 로그아웃 후 다른
   계정으로 들어와도 이전 계정의 이름 변경이 새어 들어온다 — override
   레코드로 완전히 분리해 둔다. */
let _customTags = [];
// foodMap.deletedTagIds와 같은 참조를 가리킨다(loadFoodMap이 연결) —
// account_places의 deletedPlaceIds와 같은 역할.
let _deletedTagIds = [];
function _builtinOverrideMap() {
  const m = new Map();
  for (const t of _customTags) if (t && t.source === 'builtin-override') m.set(t.id, t.label);
  return m;
}
/* 화면 표시·검색용 "지금 유효한 태그 목록" — 기본 태그는 override가
   있으면 그 표시명으로 바꿔 보여주고(원본 객체는 그대로, 스프레드로
   새 객체만 만든다), 사용자 태그는 그대로 이어붙인다. */
function _allTagEntries() {
  const overrides = _builtinOverrideMap();
  const builtinResolved = TAG_REGISTRY_BUILTIN.map((t) => (overrides.has(t.id) ? { ...t, label: overrides.get(t.id) } : t));
  const userTags = _customTags.filter((t) => t && t.source !== 'builtin-override');
  return builtinResolved.concat(userTags);
}
function _slugifyTagId(label) {
  const base = String(label || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'tag';
  let id = 'custom_' + base, n = 1;
  const taken = new Set(_allTagEntries().map((t) => t.id));
  while (taken.has(id)) { id = 'custom_' + base + '_' + (++n); }
  return id;
}
/* 2026-09-11 재검토(10차) — "스시 말고 라멘 먹기" 같은 부정·계획 문장을
   실제 업종으로 확정하지 말라는 지시 반영. "[매칭된 단어] 말고/아니고/
   대신..." 형태로 곧바로 이어지면 그 항목은 실제로는 뺀 것으로 보고
   제외한다. 완전한 문장 이해는 아니고 딱 이 패턴 하나를 가려내는
   한정적 규칙이다(과도한 일반화 금지 — 문서에도 그대로 남긴다). */
const NEGATION_AFTER = /^\s*(말고|아니고|아니라|대신|보다는|하지\s?말고)/;
/* 2026-09-11 재검토(11차) — "개인 태그와 실제 업종 태그를 구분해. 개인
   태그가 다른 장소의 업종 자동 추정에 사용되면 안 된다." 사용자가
   만든 태그(꼭 가기 같은 개인 주제어)는 절대 이 함수를 통해 다른
   장소로 자동 번지면 안 된다 — TAG_REGISTRY_BUILTIN(우리가 실제
   업종 패턴을 검증해 둔 21개 + 늘어날 항목)만 자동 추정 후보로
   쓴다. 사용자 태그는 언제나 사람이 명시적으로 붙여야만(단일 편집·
   일괄 편집) 장소에 남는다. 기본 태그의 override 표시명은 여기서도
   그대로 반영한다(패턴은 원본과 동일 — 표시명만 바뀐다). */
function daInferTags(s) {
  s = String(s || '').toLowerCase();
  const out = [];
  const overrides = _builtinOverrideMap();
  for (const builtinTag of TAG_REGISTRY_BUILTIN) {
    const tag = overrides.has(builtinTag.id) ? { ...builtinTag, label: overrides.get(builtinTag.id) } : builtinTag;
    let hit = false;
    if (tag.pattern) {
      const flags = tag.pattern.flags.includes('g') ? tag.pattern.flags : tag.pattern.flags + 'g';
      const re = new RegExp(tag.pattern.source, flags);
      let m;
      while ((m = re.exec(s))) {
        const after = s.slice(m.index + m[0].length, m.index + m[0].length + 6);
        if (!NEGATION_AFTER.test(after)) { hit = true; break; }
        if (m.index === re.lastIndex) re.lastIndex++; // 빈 매치 무한루프 방지.
      }
    }
    if (!hit && Array.isArray(tag.synonyms)) {
      for (const syn of tag.synonyms) {
        const idx = s.indexOf(String(syn).toLowerCase());
        if (idx < 0) continue;
        const after = s.slice(idx + String(syn).length, idx + String(syn).length + 6);
        if (!NEGATION_AFTER.test(after)) { hit = true; break; }
      }
    }
    if (hit) out.push(tag.label);
  }
  return out;
}
/* 2026-09-11 재검토(10차) 8절 — 영어 지원은 "구조만" 준비한다(번역
   자체·기존 화면 전체 확대는 이번 범위 밖). 핵심 원칙:
   - 내부 키(ID)와 표시 문구를 분리한다. TAG_REGISTRY_BUILTIN이 이미
     id(yakitori)/label(야키토리)을 분리해 둔 것과 같은 원칙을 여기서
     "화면 문구"에도 적용한다 — 지금 만드는 새 화면(태그 관리 등)만
     daT()로 문구를 뽑아 쓰게 해, 나중에 언어를 늘릴 때 이 화면들은
     사전만 채우면 되고 코드를 안 건드려도 되는 구조를 보여준다.
   - 날짜·시간·거리 단위·목적지 시간대는 이 로케일 값과 완전히
     무관하다. daDestNow(위)는 FM_CITY_TZ(도시별 실제 시간대)만 보고
     이 _locale을 절대 참조하지 않는다 — "영어를 고르면 목적지 시간대가
     바뀌는" 사고를 애초에 구조적으로 만들 수 없게 한다(다른 함수가
     실수로 이 값을 시간대 계산에 섞어 쓰지 않는 한).
   - 장소 원문(originName 등)·사용자 메모는 이 사전이나 어떤 자동
     번역으로도 덮어쓰지 않는다 — 이 사전은 "우리가 만든 화면 문구"만
     다루고 사용자 데이터には 절대 관여하지 않는다.
   - 화면을 열 때마다 AI 번역을 부르는 구조를 만들지 않는다 — 이
     사전은 정적 문자열 조회일 뿐 네트워크 호출이 전혀 없다. */
const I18N_DICTIONARIES = {
  ko: {
    'tags.frequent': '자주 쓰는 태그',
    'tags.more': '더 보기',
    'tags.newPlaceholder': '목록에 없으면 새 태그 이름 입력',
    'tags.add': '추가',
    'location.average': '평균 위치',
    'location.gps': '내 위치(GPS)',
    'location.testPrefix': '테스트 위치',
  },
  // en: 아직 없음(실제 영어 문구가 준비되면 이 자리만 채우면 됨 —
  // daT를 쓰는 코드는 손댈 필요가 없다). 지금은 UI에 언어 선택지
  // 자체를 노출하지 않는다 — 구조 검증 단계일 뿐 실제 영어 지원
  // 출시가 아니다.
};
let _locale = 'ko';
function daT(key, fallbackText) {
  const dict = I18N_DICTIONARIES[_locale] || I18N_DICTIONARIES.ko;
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  return fallbackText !== undefined ? fallbackText : key;
}
function daSetLocale(loc) {
  if (!I18N_DICTIONARIES[loc]) return false; // 사전 없는 로케일은 조용히 무시(깨진 화면 방지) — 지금은 'ko'만 존재.
  _locale = loc;
  return true;
}
function daLocale() { return _locale; }

/* 2026-09-11 재검토(10차) 5절 — 자동분류 우선순위: 사용자 확정값 >
   "이미 확보한 신뢰 가능한 장소 유형" > 명확한 규칙(이름 텍스트) >
   (필요시 AI) > 미분류. 이 표는 Google Places(New)의 자유형 types
   문자열(공식: https://developers.google.com/maps/documentation/places/web-service/place-types
   — 이 세션은 접속이 막혀 재확인은 못했다) 중 우리 상위분류·세부
   태그로 안전하게 대응되는 것만 담는다 — 모르는 type은 그냥
   무시한다(억지로 끼워 맞추지 않는다). 국가·언어와 무관한 매핑이라
   방콕의 스시집도 정확히 스시로 분류된다(실제 근거가 공급자 데이터인
   경우). */
const PLACE_TYPE_TO_CATEGORY = {
  lodging: '숙소', hotel: '숙소', hostel: '숙소', guest_house: '숙소',
  transit_station: '교통', train_station: '교통', subway_station: '교통', airport: '교통', bus_station: '교통',
  spa: '마사지·스파', massage: '마사지·스파',
  pharmacy: '약국·병원', hospital: '약국·병원', doctor: '약국·병원',
  cafe: '카페·디저트', bakery: '카페·디저트', coffee_shop: '카페·디저트',
  bar: '바·이자카야', night_club: '바·이자카야', pub: '바·이자카야',
  tourist_attraction: '관광·명소', museum: '관광·명소', park: '관광·명소', place_of_worship: '관광·명소',
  shopping_mall: '쇼핑', supermarket: '쇼핑', store: '쇼핑', convenience_store: '쇼핑',
  restaurant: '맛집·식당', food: '맛집·식당', meal_takeaway: '맛집·식당',
};
const PLACE_TYPE_TO_TAG = {
  cafe: '카페', coffee_shop: '카페', bakery: '베이커리·디저트',
  bar: null, // bar만으로는 이자카야/와인바 등 세부를 지어내지 않는다(근거 부족 시 미분류 원칙).
  spa: '스파·온천', massage: '마사지',
};
/* types(공급자가 방금 돌려준 실제 유형 배열)로 cat/tags를 올린다.
   사용자가 이미 확정한 값(catConfirmed/tagsConfirmed=true)은 이 확인이
   방금 일어났어도 절대 덮지 않는다 — "사용자 확정값이 최우선"이라는
   순서를 places 객체 단위로 강제한다. */
function daApplyConfirmedTypes(p, types) {
  if (!p || !Array.isArray(types)) return;
  p.confirmedTypes = types; // 근거 추적용 — 나중에 재분류·디버깅에 쓴다.
  if (!p.catConfirmed) {
    for (const ty of types) {
      const cat = PLACE_TYPE_TO_CATEGORY[ty];
      if (cat) { p.cat = cat; break; }
    }
  }
  if (!p.tagsConfirmed) {
    const suggested = new Set(p.tags || []);
    for (const ty of types) {
      const tagLabel = PLACE_TYPE_TO_TAG[ty];
      if (tagLabel) suggested.add(tagLabel);
    }
    p.tags = Array.from(suggested);
  }
}

/* 2026-09-11 재검토(11차) 4절 — AI 보조 분류 클라이언트 연결. 규칙
   (daInfer/daApplyConfirmedTypes)으로도 못 정한("기타"로 남고 사용자가
   직접 고르지도 않은) 곳만 골라 서버 /api/places/classify-batch에
   보낸다 — 이미 규칙으로 해결된 곳은 애초에 이 목록에 안 들어간다.
   입력은 이름·주소·이미 확보한 confirmedTypes뿐이다(개인 메모는
   서버로 아예 안 보낸다 — sanitizeItem이 note를 안 받으므로 여기서도
   굳이 담지 않는다). */
function daNeedsAiClassify(p) {
  return !!p && !p.catConfirmed && (!p.cat || p.cat === '기타');
}
/* 요청 시점의 입력 지문 — 응답이 돌아왔을 때 그 사이 사용자가 이름을
   고치거나 유형을 직접 확정했는지(더 이상 이 지문과 안 맞는지) 확인하는
   용도. 서버의 input_hash와 같은 재료(name/address/confirmedTypes)를
   쓰지만, 여긴 그냥 지금 값과 비교만 하면 되므로 해시가 아니라 JSON
   문자열 그대로 쓴다(클라 쪽에서 sha256을 새로 끌어올 필요가 없다). */
function daAiClassifyInputFingerprint(p) {
  return JSON.stringify({ name: p && p.name || '', address: p && p.address || '', confirmedTypes: ((p && p.confirmedTypes) || []).slice().sort() });
}
/* AI(모의든 실제든) 결과를 place 하나에 반영한다. 그 사이 사용자가
   직접 확정했으면(catConfirmed=true) 절대 덮지 않는다 — "사용자
   확정값이 최우선"이라는 daApplyConfirmedTypes와 같은 원칙. 태그는
   여기서 자동으로 새로 만들거나 붙이지 않는다(AI가 제안한 이름이
   개인 선호 태그와 우연히 겹쳐 다른 곳에 잘못 번지는 위험을 아예
   구조적으로 차단 — 상위분류만 자동 적용하고, 태그는 사람이 태그
   편집 화면에서 직접 다룬다). 근거 부족(unresolved)이면 아무것도
   바꾸지 않고 "여전히 미분류"로 정직하게 남긴다. */
function daApplyAiClassifyResult(p, result) {
  if (!p || !result || p.catConfirmed) return false;
  if (result.unresolved || !result.category) return false;
  p.cat = result.category;
  return true;
}
/* 태그 CRUD — 사용자가 새 태그를 만들거나 이름을 바꾸거나 지울 수
   있어야 한다는 지시(10차 4절) 반영. place.tags는 계속 label 문자열을
   저장하므로, 이름 수정은 레지스트리의 label만 바꾸는 게 아니라 이미
   저장된 장소들의 tags 배열 안 문자열도 함께 바꿔 줘야 데이터가
   일관된다. 삭제는 태그 연결만 끊고 장소 자체는 절대 지우지 않는다. */
function daFindTagByLabel(label) {
  const norm = String(label || '').trim();
  return _allTagEntries().find((t) => t.label === norm) || null;
}
function daCreateTag(label, synonyms) {
  const norm = String(label || '').trim();
  if (!norm) return { ok: false, reason: 'empty-label' };
  // 중복 정규화 — 이미 같은(대소문자 무시) 표시명이 있으면 새로 안
  // 만들고 기존 태그를 그대로 돌려준다(AI 제안 태그에도 같은 규칙을
  // 적용할 수 있게 별도 함수로 분리해 둔다 — daNormalizeTagLabel 참고).
  const existing = _allTagEntries().find((t) => t.label.toLowerCase() === norm.toLowerCase());
  if (existing) return { ok: true, tag: existing, created: false };
  // version: 0은 "서버에 아직 한 번도 저장 안 됨"을 뜻한다(account_places
  // 의 baseVersion 관례와 동일) — 다음 daSyncPush가 이 값을 기준으로
  // 서버에 새로 만든다.
  const tag = { id: _slugifyTagId(norm), label: norm, synonyms: Array.isArray(synonyms) ? synonyms.filter(Boolean).map(String) : [], source: 'user', createdAt: new Date().toISOString(), version: 0 };
  _customTags.push(tag);
  return { ok: true, tag, created: true };
}
/* 새로 제안된 태그 라벨을 등록하기 전 항상 거치는 정규화 — 앞뒤 공백
   제거, 너무 길거나 빈 값은 거절한다(10차 6절 "새 태그 제안은 중복
   정규화·출력 검증을 거쳐 반영" — AI 어댑터(R10-5)도 이 함수를 그대로
   재사용한다). */
function daNormalizeTagLabel(label) {
  const norm = String(label || '').trim().replace(/\s+/g, ' ');
  if (!norm || norm.length > 20) return null;
  return norm;
}
function daRenameTag(oldLabel, newLabelRaw, places) {
  const newLabel = daNormalizeTagLabel(newLabelRaw);
  if (!newLabel) return { ok: false, reason: 'invalid-label' };
  const tag = daFindTagByLabel(oldLabel);
  if (!tag) return { ok: false, reason: 'not-found' };
  if (daFindTagByLabel(newLabel) && newLabel.toLowerCase() !== oldLabel.toLowerCase()) return { ok: false, reason: 'duplicate-label' };
  const isBuiltin = TAG_REGISTRY_BUILTIN.some((t) => t.id === tag.id);
  if (isBuiltin) {
    // 2026-09-11 재검토(11차) — 전역 배열(TAG_REGISTRY_BUILTIN)은 절대
    // 직접 고치지 않는다. 이 계정만의 표시명 override를 customTags
    // 안에 별도 항목으로 저장한다(같은 id를 다시 바꾸면 그 항목만
    // 갱신 — 새 override를 계속 쌓지 않는다).
    let ov = _customTags.find((t) => t.id === tag.id && t.source === 'builtin-override');
    if (ov) ov.label = newLabel;
    else _customTags.push({ id: tag.id, label: newLabel, source: 'builtin-override', synonyms: [], version: 0 });
  } else {
    const custom = _customTags.find((t) => t.id === tag.id);
    if (custom) custom.label = newLabel; // _allTagEntries()가 사용자 태그는 원본 참조를 그대로 돌려주므로 안전하게 직접 고칠 수 있다.
  }
  for (const p of (places || [])) {
    if (!Array.isArray(p.tags)) continue;
    const i = p.tags.indexOf(oldLabel);
    if (i >= 0) p.tags[i] = newLabel;
  }
  return { ok: true, tag: { ...tag, label: newLabel } };
}
/* 태그를 지워도 장소는 절대 안 지운다 — 연결(tags 배열의 문자열)만
   끊는다. 빌트인 태그는 정규식 매칭 자체를 없앨 수 없으므로(다음
   자동분류 때 다시 붙을 수 있음) 삭제 대상은 사용자가 만든 진짜
   태그(source:'user')로 한정한다 — 기본 태그 표시명 override는 이
   함수로 지우지 않는다(다시 이름을 바꾸면 그 항목이 갱신될 뿐이다). */
function daDeleteCustomTag(id, places) {
  const idx = _customTags.findIndex((t) => t.id === id && t.source === 'user');
  if (idx < 0) return { ok: false, reason: 'not-found' };
  const [removed] = _customTags.splice(idx, 1);
  for (const p of (places || [])) {
    if (!Array.isArray(p.tags)) continue;
    p.tags = p.tags.filter((t) => t !== removed.label);
  }
  // 2026-09-11 재검토(11차) — 이 삭제가 서버에도 반영되게(다른 기기·
  // 재로그인에도 되살아나지 않게) 기준 버전과 함께 삭제 큐에 남긴다
  // (account_places의 deletedPlaceIds와 같은 패턴).
  _deletedTagIds.push({ id: removed.id, baseVersion: removed.version || 0 });
  return { ok: true };
}
/* 일괄 편집 — 여러 장소에 한 태그를 한 번에 붙이거나 뗀다(10차 4절
   "단일/일괄 편집"). 사용자가 직접 고른 결과이므로 tagsConfirmed를
   확정 처리해 자동분류·재가져오기가 덮지 않게 한다. */
function daBulkSetTag(places, placeIds, label, add) {
  const norm = String(label || '').trim();
  if (!norm) return 0;
  const idSet = new Set(placeIds || []);
  let changed = 0;
  for (const p of (places || [])) {
    if (!idSet.has(p.id)) continue;
    const tags = new Set(p.tags || []);
    const had = tags.has(norm);
    if (add) tags.add(norm); else tags.delete(norm);
    if (tags.has(norm) !== had) changed++;
    p.tags = Array.from(tags);
    p.tagsConfirmed = true;
  }
  return changed;
}
const FM_CITY_ALT = {
  '후쿠오카': '福岡|fukuoka|hakata|博多', '도쿄': '東京|tokyo|shibuya|shinjuku', '오사카': '大阪|osaka|namba|umeda',
  '교토': '京都|kyoto', '삿포로': '札幌|sapporo', '오키나와': '沖縄|okinawa|naha|那覇', '나고야': '名古屋|nagoya',
  '서울': '서울|seoul', '부산': '부산|busan', '제주': '제주|jeju',
  '타이베이': '台北|taipei', '타이중': '台中|taichung', '가오슝': '高雄|kaohsiung',
  '홍콩': '香港|hong ?kong|kowloon', '상하이': '上海|shanghai', '베이징': '北京|beijing',
  '방콕': 'bangkok|กรุงเทพ|krung ?thep', '치앙마이': 'chiang ?mai|เชียงใหม่',
  '하노이': 'hà ?nội|ha ?noi|hanoi', '호치민': 'hồ ?chí ?minh|ho ?chi ?minh|saigon|sài ?gòn',
  '다낭': 'đà ?nẵng|da ?nang', '후에': 'huế|hue',
  '싱가포르': 'singapore', '쿠알라룸푸르': 'kuala ?lumpur|\\bkl\\b', '세부': 'cebu', '보라카이': 'boracay',
  '발리': 'bali|denpasar|ubud|seminyak', '뉴욕': 'new ?york|manhattan|brooklyn',
  '파리': 'paris', '로마': 'roma|rome', '바르셀로나': 'barcelona', '런던': 'london',
  '시드니': 'sydney', '이스탄불': 'istanbul|i̇stanbul', '두바이': 'dubai|دبي',
};
/* private/personal.html: function fmCityGuess — 2026-09-09 수정본 그대로 옮김.
   증거 없이 도시를 확정하지 않는다 — 주소 텍스트에 아는 도시 이름이 정확히
   하나만 걸리면 그 도시, 여러 개 걸리면(또는 하나도 없으면) 확정 안 함.
   메모는 안 쓴다(실제로 다른 도시와 비교하는 개인 코멘트를 도시로 오인한
   적이 있다). 좌표만으로는 여기서 확정하지 않는다 — daCityHint() 참고. */
function daCityGuess(p) {
  const txt = String(p.address || '').toLowerCase();
  if (!txt.trim()) return null;
  const hit = [];
  for (const city in FM_CITY_ALT) {
    const pat = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (FM_CITY_ALT[city] ? ('|' + FM_CITY_ALT[city]) : '');
    let re; try { re = new RegExp(pat, 'i'); } catch (e) { continue; }
    if (re.test(txt)) hit.push(city);
  }
  if (hit.length === 1) return hit[0];
  return null;
}
/* private/personal.html: function fmCityHint — 그대로 옮김.
   좌표 기반 "짐작"이다. 후쿠오카 사각 범위는 실제 후쿠오카시보다 넓어서
   (사가·나가사키·구마모토 일부까지 포함) 박스 안에 있다고 후쿠오카가
   확정은 아니다. p.city(확정값)에는 안 쓰고, 화면 제안에만 쓴다. */
function daCityHint(p) {
  if (daHasCoords(p) && p.lat >= 32.7 && p.lat <= 34.15 && p.lng >= 129.2 && p.lng <= 131.25) return '후쿠오카';
  return null;
}
/* 2026-09-09 코드 검토(2차): 코스 생성이 "지금 시각"을 기기(브라우저)
   시각대로 읽고 있었다 — 한국에서 켠 폰으로 후쿠오카 코스를 밤에 다시
   짜면, 기기가 한국 시각이어도 실제로는 후쿠오카(JST) 영업시간·"지금
   몇 시부터"를 기준으로 계산해야 한다. FM_CITY_ALT에 있는 도시들을
   시간대로 매핑해 둔다(없는 도시는 도쿄로 근사 — 완전하진 않다). */
const FM_CITY_TZ = {
  '후쿠오카': 'Asia/Tokyo', '도쿄': 'Asia/Tokyo', '오사카': 'Asia/Tokyo', '교토': 'Asia/Tokyo',
  '삿포로': 'Asia/Tokyo', '오키나와': 'Asia/Tokyo', '나고야': 'Asia/Tokyo',
  '서울': 'Asia/Seoul', '부산': 'Asia/Seoul', '제주': 'Asia/Seoul',
  '타이베이': 'Asia/Taipei', '타이중': 'Asia/Taipei', '가오슝': 'Asia/Taipei',
  '홍콩': 'Asia/Hong_Kong', '상하이': 'Asia/Shanghai', '베이징': 'Asia/Shanghai',
  '방콕': 'Asia/Bangkok', '치앙마이': 'Asia/Bangkok',
  '하노이': 'Asia/Ho_Chi_Minh', '호치민': 'Asia/Ho_Chi_Minh', '다낭': 'Asia/Ho_Chi_Minh', '후에': 'Asia/Ho_Chi_Minh',
  '싱가포르': 'Asia/Singapore', '쿠알라룸푸르': 'Asia/Kuala_Lumpur',
  '세부': 'Asia/Manila', '보라카이': 'Asia/Manila', '발리': 'Asia/Makassar',
  '뉴욕': 'America/New_York', '파리': 'Europe/Paris', '로마': 'Europe/Rome',
  '바르셀로나': 'Europe/Madrid', '런던': 'Europe/London', '시드니': 'Australia/Sydney',
  '이스탄불': 'Europe/Istanbul', '두바이': 'Asia/Dubai',
};
function daDestNow(cityName) {
  const tz = FM_CITY_TZ[cityName] || 'Asia/Tokyo';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date());
    const get = (t) => +((parts.find((x) => x.type === t) || {}).value);
    let h = get('hour'); if (h === 24) h = 0;
    return { hour: h, minute: get('minute'), ymd: get('year') + '-' + String(get('month')).padStart(2, '0') + '-' + String(get('day')).padStart(2, '0') };
  } catch (e) {
    const d = new Date();
    return { hour: d.getHours(), minute: d.getMinutes(), ymd: d.toISOString().slice(0, 10) };
  }
}
/* private/personal.html: function fmGpsDistance — 그대로 옮김(미터 단위). */
function daGpsDistance(a, b) {
  if (!a || !b) return 0;
  const r = Math.PI / 180, a1 = a.lat * r, a2 = b.lat * r, da = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
  const z = Math.sin(da / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(z), Math.sqrt(1 - z));
}
/* 2026-09-11 재검토(9차) 6-1절 — 좌표가 확인된 장소들의 평균 좌표.
   "정렬만을 위해 유료 지오코딩 API 호출 금지" 제약 때문에, 숙소는
   텍스트 이름만 있고 좌표가 없어(POST /api/trips가 {name}만 보냄)
   위치 권한 없이도 쓸 수 있는 기본 기준점으로 삼는다. GPS 옵트인
   버튼은 이번 라운드에서는 구현하지 않은 별도 개선 항목으로 남긴다. */
function daCentroid(spots) {
  const withCoords = (spots || []).filter((s) => s && typeof s.lat === 'number' && typeof s.lng === 'number');
  if (!withCoords.length) return null;
  const sum = withCoords.reduce((acc, s) => ({ lat: acc.lat + s.lat, lng: acc.lng + s.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / withCoords.length, lng: sum.lng / withCoords.length };
}
function daRelevanceScore(s, q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return 0;
  const name = String(s.name || '').toLowerCase();
  const cat = String(s.category || '').toLowerCase();
  const addr = String(s.area || '').toLowerCase();
  if (name === query) return 5;
  if (name.startsWith(query)) return 4;
  if (name.includes(query)) return 3;
  if (cat.includes(query)) return 2;
  if (addr.includes(query)) return 1;
  return 0;
}
/* 6-1절 — 정렬 4종(최근추가순/오래된순/거리순/관련순). 날짜·좌표를
   모르는 항목은 추측하지 않고 정직하게 맨 뒤로 보낸다(숨기지 않음 —
   "안 보이던 곳이 사라졌다"는 오해를 막기 위해). 위치 권한 없이도
   목록 자체는 그대로 쓸 수 있어야 하므로 기본 정렬은 recent다. */
function daSortSpots(list, opts) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const o = opts || {};
  const mode = o.mode || 'recent';
  if (mode === 'recent' || mode === 'oldest') {
    const dir = mode === 'recent' ? -1 : 1;
    return arr.sort((a, b) => {
      const ta = a.firstAddedAt ? Date.parse(a.firstAddedAt) : NaN;
      const tb = b.firstAddedAt ? Date.parse(b.firstAddedAt) : NaN;
      const aKnown = Number.isFinite(ta), bKnown = Number.isFinite(tb);
      if (!aKnown && !bKnown) return 0;
      if (!aKnown) return 1; // 최초 추가 시점을 모르는 기존 약 160곳 — 뒤로.
      if (!bKnown) return -1;
      return dir * (ta - tb);
    });
  }
  if (mode === 'distance') {
    const ref = o.refPoint;
    return arr.sort((a, b) => {
      const aHas = ref && typeof a.lat === 'number' && typeof a.lng === 'number';
      const bHas = ref && typeof b.lat === 'number' && typeof b.lng === 'number';
      if (!aHas && !bHas) return 0;
      if (!aHas) return 1; // 좌표 없는 곳은 숨기지 않고 맨 뒤에만 둔다.
      if (!bHas) return -1;
      return daGpsDistance(ref, a) - daGpsDistance(ref, b);
    });
  }
  if (mode === 'relevance') {
    const q = o.query || '';
    if (!String(q).trim()) return arr; // 검색어 없이 근거 없는 "추천순"을 지어내지 않는다.
    return arr
      .map((s, i) => ({ s, score: daRelevanceScore(s, q), i }))
      .sort((x, y) => (y.score - x.score) || (x.i - y.i))
      .map((x) => x.s);
  }
  return arr;
}
/* private/personal.html: function fmIsPlaceUrl — 그대로 옮김. 검색 URL은
   특정 장소 식별자가 아니다(2026-09-09 코드 검토). */
function daIsPlaceUrl(u) {
  const t = String(u || '');
  if (!t) return false;
  if (/\/maps\/search\//i.test(t)) return false;
  if (/place_id[:=]/i.test(t)) return true;
  if (/[?&]cid=/i.test(t)) return true;
  if (/!1s0x[0-9a-f]+:0x[0-9a-f]+/i.test(t)) return true;
  if (/\/maps\/place\//i.test(t)) return true;
  return false;
}
/* 2026-09-09 코드 검토(로드맵 ④ 후속) — "실제 위치 확인은 저장된 식별자
   에서 확인 가능한 정보부터 먼저 쓰고, 추가 조회가 필요한 항목만 구분해
   처리한다." daCoordFromUrl은 URL 문자열 안에 좌표가 그대로 박혀 있는
   경우(!3d!4d, @lat,lng, q=lat,lng 등)만 추가 조회 없이 뽑아낸다.
   goo.gl/maps.app.goo.gl 같은 축약 링크나 cid만 있는 링크는 실제
   목적지를 알려면 리다이렉트를 따라가거나 Places API를 불러야 한다 —
   이건 "저장된 정보만으로 확인 가능"한 범위를 벗어난 별도 조회다.
   소비자에게 API 키를 넣게 하지 않는다는 원칙(코드 검토 ④) 때문에
   여기서 그 조회를 실행하지 않는다 — 대신 "좌표 확인에 추가 조회가
   필요한 곳"으로 구분해 표시만 한다(서버 쪽 키 보호·조회 한도·비용
   추정이 정리된 뒤 별도로 연결할 대상). */
function daIsShortMapsUrl(u) {
  const t = String(u || '');
  return /^https?:\/\/(goo\.gl\/maps|maps\.app\.goo\.gl)\//i.test(t);
}
/* 2026-09-09 코드 검토(2차) — 재현된 버그: 좌표가 URL에 안 박혀 있는
   FID 링크(`!1s0x123:0x456`, 좌표 성분 없이 식별자만 있는 경우)가
   cid 패턴에도 축약 링크 패턴에도 안 걸려 needsLookup=false로
   잘못 판정됐다 — "더 확인할 게 없다"로 조용히 처리된 것이다.
   실제로는 daIsPlaceUrl()이 "특정 장소를 가리키는 링크"로 인정하는
   모든 형태(place_id=, cid=, FID, /maps/place/)에 대해 "그 식별자는
   있는데 좌표가 URL 문자열에 없다"는 게 진짜 조건이어야 한다 — cid만
   특별 취급할 이유가 없다. URL 자체가 아예 없는 경우(주소·이름뿐)도
   이전엔 false였는데, 그건 "확인할 것 없음"이 아니라 오히려 확인할
   근거가 가장 부족한 상태라 needsLookup=true가 맞다. 반대로 검색
   URL(daIsPlaceUrl=false, "이 근처 카페" 같은 링크)은 애초에 어떤
   장소를 가리키는지조차 특정이 안 된 별도 상태라 여기서 true로 안
   묶는다(daLookupState가 이 경우를 'ambiguous-search'로 따로 구분). */
function daNeedsLookup(p) {
  if (daHasCoords(p)) return false;
  const state = daLookupState(p);
  return state === 'short-link' || state === 'place-id-no-coords' || state === 'no-evidence';
}
/* 좌표 없는 장소를 상태별로 분류한다(라벨링용 — 실제 서버 조회는 아직
   연결 안 함, 클라이언트에 API 키를 두지 않는다는 원칙 때문에 서버
   쪽에서 처리해야 한다: 작업 목록 #17/#21). 화면에서 상태별로 다른
   안내 문구를 보여줄 수 있게 문자열로 구분해 돌려준다.
   - 'has-coords'         : 이미 좌표 있음 — 조회 불필요
   - 'short-link'         : 축약 링크 — 리다이렉트를 따라가야 실제 목적지를 안다
   - 'place-id-no-coords' : 특정 장소 식별자(FID·cid·place_id·/maps/place/)는
                            있는데 URL 문자열 자체엔 좌표가 없음 — 식별자로 조회 가능
   - 'ambiguous-search'   : 검색 URL이라 애초에 "그 장소가 무엇인지"조차
                            URL만으로는 특정이 안 됨(좌표 조회 이전 문제)
   - 'no-evidence'        : URL도 없음 — 이름·주소만으로 조회를 시도해야 함(가장 근거 부족) */
function daLookupState(p) {
  if (daHasCoords(p)) return 'has-coords';
  const u = String(p.url || '');
  if (!u) return 'no-evidence';
  if (daIsShortMapsUrl(u)) return 'short-link';
  if (daIsPlaceUrl(u) && !daCoordFromUrl(u)) return 'place-id-no-coords';
  return 'ambiguous-search';
}
/* private/personal.html: function fmPlacesConflict — 그대로 옮김.
   양쪽에 placeId가 실제로 있고 서로 다르면(2026-09-09 코드 검토 반영)
   구글 기준으로 이미 다른 장소라는 확실한 증거다. */
function daPlacesConflict(a, x) {
  if (a.placeId && x.placeId && a.placeId !== x.placeId) return true;
  const ca = daCityGuess(a), cx = daCityGuess(x);
  if (ca && cx && ca !== cx) return true;
  if (daHasCoords(a) && daHasCoords(x) && daGpsDistance(a, x) > 5000) return true;
  return false;
}

/* private/personal.html: fmMerge — 2026-09-09 재작성본 그대로 옮김(카테고리
   자동분류 호출부만 뺐다 — fmInfer 는 로드맵 ③에서 연결한다).
   "이름만 같으면 자동으로 합친다"를 없앴다 — 서울·부산 동명 가게가 하나로
   합쳐지는 실제 버그가 있었다. 이제 검증된 식별자(placeId·URL·이름+실좌표)
   만 자동 병합하고, 이름만 같으면 dupCandidateIds 로 후보만 남긴다(충돌
   근거가 있으면 후보로도 안 남긴다). 재수입 시 사용자가 고친 값(원본과
   달라진 이름·메모·주소)은 새로 들어온 값으로 덮지 않는다. */
const daNameKey = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
/* private/personal.html: function fmDupKey — 그대로 옮김. */
function daDupKey(p) { return daNameKey(p.name) + '|' + String(p.address || '').trim().toLowerCase() + '|' + String(p.url || '').trim(); }
function daMerge(arr, sourceLabel, places, importBatchId) {
  let added = 0, updated = 0, skipped = 0, dupCandidates = 0;
  const byKey = new Map(); const byName = new Map();
  /* 좌표가 진짜 있을 때만 이름+좌표를 검증된 식별자로 쓴다.
     null|null 은 "좌표가 없다"는 뜻이지 "같은 좌표"가 아니다 — 이걸
     구분 안 해서 좌표 없는 동명 장소가 자동으로 합쳐지고 있었다. */
  const kName = (p) => daHasCoords(p) ? ((p.name || '').toLowerCase() + '|' + p.lat + '|' + p.lng) : null;
  const urlKey = (p) => daIsPlaceUrl(p.url) ? p.url : null;
  const addName = (nk, p) => { if (!nk) return; if (!byName.has(nk)) byName.set(nk, []); byName.get(nk).push(p); };
  /* private/personal.html 의 regKeys와 동일 — 합친 뒤 삭제되는 쪽의
     URL·placeId를 별칭(aliasUrls/aliasPlaceIds)으로도 등록해 둔다. */
  const regKeys = (p) => {
    [p.placeId, urlKey(p), kName(p)].forEach((k) => { if (k) byKey.set(k, p); });
    (p.aliasUrls || []).forEach((u) => { if (u) byKey.set(u, p); });
    (p.aliasPlaceIds || []).forEach((id) => { if (id) byKey.set(id, p); });
  };
  places.forEach((p) => {
    regKeys(p);
    addName(daNameKey(p.name), p);
  });
  arr.forEach((x) => {
    if (!x || !x.name) { skipped++; return; }
    const nk = daNameKey(x.name);
    const kx = kName(x);
    let exact = (x.placeId && byKey.get(x.placeId)) || (urlKey(x) && byKey.get(urlKey(x))) || (kx && byKey.get(kx));
    /* 강한 식별자 충돌 검사 — 이름+좌표(또는 URL)로 후보를 찾았어도 양쪽
       placeId가 서로 다르면 병합하지 않는다(2026-09-09 코드 검토).
       단, x.placeId가 exact.aliasPlaceIds(사람이 이미 병합해 남겨 둔
       승인된 별칭)에 있으면 충돌이 아니라 별칭 재확인이다 — 재현된
       버그: 이걸 구분 안 하면 합친 뒤 삭제된 쪽 식별자로 재수입할 때마다
       레코드가 다시 늘어난다(2026-09-09 코드 검토 2차). */
    if (exact && x.placeId && exact.placeId && x.placeId !== exact.placeId && !(Array.isArray(exact.aliasPlaceIds) && exact.aliasPlaceIds.includes(x.placeId))) exact = null;
    if (exact) {
      /* private/personal.html 과 동일 — origin* 필드 자체가 없는 기존
         레코드는 "지금 값 === undefined"가 항상 참이 되어 무조건
         덮어써지고 있었다(2026-09-09 코드 검토). 원본을 모르면 사용자가
         이미 고쳐 놨을 수도 있으니 이번엔 안 건드리고 origin*만 채운다. */
      if (x.name && exact.originName !== undefined && exact.name === exact.originName) exact.name = x.name;
      exact.originName = x.name !== undefined ? x.name : exact.originName;
      if (exact.originNote !== undefined && exact.note === exact.originNote) exact.note = x.note || '';
      exact.originNote = x.note !== undefined ? x.note : exact.originNote;
      if (exact.originAddress !== undefined && exact.address === exact.originAddress) exact.address = x.address || exact.address;
      exact.originAddress = x.address !== undefined ? x.address : exact.originAddress;
      if (x.placeId) exact.placeId = x.placeId;
      if (x.url) exact.url = x.url;
      if (x.lat !== null && x.lat !== undefined) exact.lat = x.lat;
      if (x.lng !== null && x.lng !== undefined) exact.lng = x.lng;
      if (!exact.cityConfirmed) exact.city = daCityGuess(exact);
      /* 유형 분류 — 확인된 유형(원본에 실제 cat이 있으면)을 이름 기반
         추정보다 우선하고, 사용자가 직접 고친 분류(catConfirmed)는
         재수입 때도 절대 덮지 않는다(2026-09-09 코드 검토). */
      if (!exact.catConfirmed) { exact.cat = x.cat || daInfer(exact.name + ' ' + exact.note + ' ' + exact.address); exact.catConfirmed = !!x.cat; }
      // 6-2절 — 세부 다중 태그도 같은 규칙(catConfirmed와 동일하게
      // tagsConfirmed). 사용자가 직접 고른 적 없으면 재수입 때마다
      // 최신 이름·메모·주소 기준으로 다시 추정해 둔다(더 정확해질 뿐,
      // 사람이 확정한 값은 절대 안 건드림).
      if (!exact.tagsConfirmed) exact.tags = daInferTags(exact.name + ' ' + exact.note + ' ' + exact.address);
      if (sourceLabel) { exact.sourceLists = Array.isArray(exact.sourceLists) ? exact.sourceLists : []; if (!exact.sourceLists.includes(sourceLabel)) exact.sourceLists.push(sourceLabel); }
      // 2026-09-11 재검토(9차) 6-1절 — 재가져오기가 이미 아는 장소의
      // 최초 추가 시각(firstAddedAt)이나 사용자가 이미 채운
      // originalSavedAt을 절대 덮지 않는다. 이 파일이 처음으로
      // originalSavedAt을 알려주는 경우(예전엔 몰랐던 원본 저장일)만
      // 채워 넣는다 — "몰랐던 정보를 채움"이지 "덮어쓰기"가 아니다.
      if (exact.originalSavedAt === undefined && x.originalSavedAt) exact.originalSavedAt = x.originalSavedAt;
      regKeys(exact);
      updated++; return;
    }
    /* 2026-09-09 코드 검토(2차): 식별자가 없는 항목은 같은 파일을 다시
       올릴 때마다 후보가 하나씩 더 쌓여 개수가 계속 늘었다 — "같은
       출처에서 이미 받아들인 내용"(importKeys: 출처+내용 키)이면 후보로
       또 쌓지 않고 그 레코드를 그대로 갱신한다. */
    const pKeyPre = daDupKey(x);
    const importFingerprint = (sourceLabel || '') + '|' + pKeyPre;
    const already = (byName.get(nk) || []).find((o) => Array.isArray(o.importKeys) && o.importKeys.includes(importFingerprint));
    if (already) {
      // 2026-09-11 재검토(9차) 6-1절 — importFingerprint는 이름/주소/URL만
      // 보고 판단하므로(저장일이 새로 추가된 열이라도 지문은 그대로
      // 같다), "이미 받아들인 내용"으로 판정돼도 원본에 새로 보이는
      // originalSavedAt까지 무시하면 안 된다. exact 식별자 매칭 분기와
      // 똑같이, 몰랐던 값만 비파괴적으로 채운다(덮어쓰지 않음).
      if (already.originalSavedAt === undefined && x.originalSavedAt) already.originalSavedAt = x.originalSavedAt;
      updated++; return;
    }
    const p = Object.assign({ id: 'fm' + Date.now() + added + Math.floor(Math.random() * 9999) }, x);
    delete p.title;
    p.originName = x.name; p.originNote = x.note || ''; p.originAddress = x.address || '';
    p.cat = x.cat || daInfer(p.name + ' ' + p.note + ' ' + p.address);
    p.catConfirmed = !!x.cat;
    // 6-2절 — 상위분류(cat)는 그대로 두고, 세부 다중 태그를 처음부터
    // 같이 추정해 둔다(불확실하면 daInferTags가 빈 배열을 준다 — 억지로
    // 아무 태그나 붙이지 않는다).
    p.tags = daInferTags(p.name + ' ' + p.note + ' ' + p.address);
    p.tagsConfirmed = false;
    p.city = daCityGuess(p);
    p.sourceLists = sourceLabel ? [sourceLabel] : [];
    p.importKeys = [importFingerprint];
    // 2026-09-11 재검토(9차) 6-1절 — "최근 추가순" 정렬의 근거. 앱이
    // 이 장소를 처음 알게 된 순간(firstAddedAt, 절대 나중에 안 바뀜)과
    // 이번에 같이 들어온 항목들의 묶음(importBatchId, 재가져오기에서
    // "이번에 추가된 곳"을 구분하는 근거)을 한 번만 찍는다.
    // originalSavedAt(원본 파일이 실제로 알려준 저장일)은 이미 x에
    // 있으면 그대로 따라오고, 없으면 undefined로 남아 지어내지 않는다.
    p.firstAddedAt = new Date().toISOString();
    p.importBatchId = importBatchId || null;
    /* 이름만 같아도 사람이 이미 "다른 곳이에요"로 확인해 둔 조합
       (dismissedDupKeys)이면 같은 판단을 또 묻지 않는다. */
    const pKey = daDupKey(p);
    const sameName = (byName.get(nk) || []).filter((o) => !daPlacesConflict(o, p) && !(o.dismissedDupKeys || []).includes(pKey));
    if (sameName.length) {
      p.dupCandidateIds = sameName.map((o) => o.id);
      sameName.forEach((o) => { o.dupCandidateIds = Array.isArray(o.dupCandidateIds) ? o.dupCandidateIds : []; if (!o.dupCandidateIds.includes(p.id)) o.dupCandidateIds.push(p.id); });
      dupCandidates++;
    }
    places.push(p);
    regKeys(p);
    addName(nk, p);
    added++;
  });
  return { added, updated, skipped, dupCandidates };
}
/* 여러 장소를 한 번에, 또는 하나씩 도시로 확정한다(로드맵 ④에서 요구한
   "여러 장소 선택 → 여행지 일괄 지정과 개별 수정"). 좌표를 만들어내지
   않는다 — 도시 지정과 실제 좌표 확인은 다른 것이다. 동선 계산은
   여전히 hasCoords 가 true 인 곳에만 쓸 수 있다. */
/* private/personal.html: function fmSetCat — 그대로 옮김. 사용자가 직접
   고른 분류는 catConfirmed=true로 남겨 재수입 때도 절대 안 덮는다. */
function daSetCat(places, id, cat) {
  const p = (places || []).find((x) => x.id === id);
  if (!p) return false;
  p.cat = cat;
  p.catConfirmed = true;
  return true;
}
/* 6-2절 — 세부 태그 사용자 수정. catConfirmed와 같은 규칙: 한 번 사람이
   고르면 tagsConfirmed=true로 남아 재수입·재동기화 때도 절대 안 덮인다. */
function daSetTags(places, id, tags) {
  const p = (places || []).find((x) => x.id === id);
  if (!p) return false;
  p.tags = Array.from(new Set((tags || []).filter(Boolean)));
  p.tagsConfirmed = true;
  return true;
}
/* 원래 없던 tags 필드를 처음 켜는 날(또는 예전 가져오기로 tags가 아예
   없는 ~160곳)을 위한 1회성 채움 — cat/catConfirmed 마이그레이션과
   같은 자리에서 같은 방식으로 돈다(사용자가 확정한 적 없으면 계속
   다시 추정해도 무해하지만, 최소한 "아예 없음"은 없앤다). */
function _migrateTags(places) {
  if (!Array.isArray(places)) return;
  for (const p of places) {
    if (!p || !p.id) continue;
    if (!p.tagsConfirmed && !Array.isArray(p.tags)) {
      p.tags = daInferTags(String(p.name || '') + ' ' + String(p.note || '') + ' ' + String(p.address || ''));
    }
  }
}
function daAssignCity(places, placeIds, city) {
  const set = new Set(placeIds);
  let n = 0;
  (places || []).forEach((p) => { if (set.has(p.id)) { p.city = city; p.cityConfirmed = true; n++; } });
  return n;
}
/* private/personal.html: fmResolveDup — 그대로 옮김(2026-09-09 코드
   검토 반영). 중복 후보 하나를 해결한다.
   'dismiss': 후보 연결만 끊는다(둘 다 남는다 — 실제로 다른 곳). 같은
   조합(dismissedDupKeys)을 나중에 또 후보로 올리지 않는다 — 같은 파일을
   다시 올려도 매번 같은 질문을 반복하지 않기 위함이다.
   'merge': 진짜 합친다 — 사람이 "같은 곳 맞다"고 확인한 뒤에만 불러야
   한다(자동 병합 아님). 삭제되는 쪽의 URL·placeId는 별칭(aliasUrls/
   aliasPlaceIds)으로 남겨서, 그 파일을 나중에 다시 가져와도 검증된
   식별자로 이 레코드를 다시 찾아 "갱신"으로 처리되게 한다 — 새 레코드가
   또 생기면 안 된다. 메모가 양쪽에 다 있고 다르면 하나를 버리지 않고
   이어붙인다. 방문 기록·분류도 a에 없으면 b에서 가져온다. 반환값은
   호출자가 "오늘 동선" 같은 자기만의 참조(route/selected 등)를 삭제되는
   id에서 살아남는 id로 옮길 수 있게 {mergedId, survivorId}를 준다. */
function daResolveDup(places, aId, bId, action) {
  const a = (places || []).find((p) => p.id === aId);
  const b = (places || []).find((p) => p.id === bId);
  if (!a || !b) return false;
  if (action === 'dismiss') {
    a.dupCandidateIds = (a.dupCandidateIds || []).filter((id) => id !== bId);
    b.dupCandidateIds = (b.dupCandidateIds || []).filter((id) => id !== aId);
    a.dismissedDupKeys = Array.isArray(a.dismissedDupKeys) ? a.dismissedDupKeys : [];
    if (!a.dismissedDupKeys.includes(daDupKey(b))) a.dismissedDupKeys.push(daDupKey(b));
    b.dismissedDupKeys = Array.isArray(b.dismissedDupKeys) ? b.dismissedDupKeys : [];
    if (!b.dismissedDupKeys.includes(daDupKey(a))) b.dismissedDupKeys.push(daDupKey(a));
    return true;
  }
  a.aliasUrls = Array.isArray(a.aliasUrls) ? a.aliasUrls : [];
  a.aliasPlaceIds = Array.isArray(a.aliasPlaceIds) ? a.aliasPlaceIds : [];
  if (a.url && a.url !== b.url && !a.aliasUrls.includes(a.url)) a.aliasUrls.push(a.url);
  if (b.url && b.url !== a.url && !a.aliasUrls.includes(b.url)) a.aliasUrls.push(b.url);
  if (a.placeId && a.placeId !== b.placeId && !a.aliasPlaceIds.includes(a.placeId)) a.aliasPlaceIds.push(a.placeId);
  if (b.placeId && b.placeId !== a.placeId && !a.aliasPlaceIds.includes(b.placeId)) a.aliasPlaceIds.push(b.placeId);
  (b.aliasUrls || []).forEach((u) => { if (u && u !== a.url && !a.aliasUrls.includes(u)) a.aliasUrls.push(u); });
  (b.aliasPlaceIds || []).forEach((id) => { if (id && id !== a.placeId && !a.aliasPlaceIds.includes(id)) a.aliasPlaceIds.push(id); });
  if (!a.address && b.address) a.address = b.address;
  if (b.note && b.note !== a.note) a.note = a.note ? (a.note + ' / ' + b.note) : b.note;
  if (!daHasCoords(a) && daHasCoords(b)) { a.lat = b.lat; a.lng = b.lng; }
  if (!a.url && b.url) a.url = b.url;
  if (!a.placeId && b.placeId) a.placeId = b.placeId;
  if (!a.city && b.city) { a.city = b.city; a.cityConfirmed = b.cityConfirmed; }
  if (!a.visited && b.visited) { a.visited = b.visited; if (b.visitedAt) a.visitedAt = b.visitedAt; }
  if ((!a.cat || a.cat === '기타') && b.cat && b.cat !== '기타') a.cat = b.cat;
  if (!a.kind && b.kind) a.kind = b.kind;
  a.sourceLists = Array.from(new Set([...(a.sourceLists || []), ...(b.sourceLists || [])]));
  a.dupCandidateIds = (a.dupCandidateIds || []).filter((id) => id !== bId);
  (b.dupCandidateIds || []).forEach((id) => {
    if (id === aId) return;
    const other = (places || []).find((p) => p.id === id);
    if (other) {
      other.dupCandidateIds = (other.dupCandidateIds || []).filter((x) => x !== bId);
      if (!other.dupCandidateIds.includes(aId)) other.dupCandidateIds.push(aId);
      a.dupCandidateIds = a.dupCandidateIds || [];
      if (!a.dupCandidateIds.includes(id)) a.dupCandidateIds.push(id);
    }
  });
  const idx = (places || []).findIndex((p) => p.id === bId);
  const mergedVersion = b.version; // splice 전에 잡아 둔다 — 서버 삭제 요청의 기준 버전으로 쓴다(8차).
  if (idx >= 0) places.splice(idx, 1);
  return { mergedId: bId, survivorId: aId, mergedVersion };
}

/**
 * foodMap 을 읽어 승인 디자인이 기대하는 spots/cities 모양으로 바꾼다.
 *
 * 2026-09-09 이전에는 "지금 활성 여행지 하나"만 city 로 취급했다. 이제
 * places[] 는 여러 도시를 계속 보관하는 창고이므로, 장소마다 실제로 추측된
 * (또는 사용자가 확정한) city 를 그대로 쓴다. city 가 없는 곳은 "지역 확인
 * 필요"라는 별도 묶음으로 보여준다 — 후쿠오카로 임의 확정하지 않는다.
 */
const UNKNOWN_CITY = '지역 확인 필요';
function daBuildSpots(foodMap) {
  const places = Array.isArray(foodMap.places) ? foodMap.places : [];
  const spots = places.map((p) => ({
    id: p.id,
    name: p.name || '이름 없음',
    category: p.cat || '기타',
    catConfirmed: !!p.catConfirmed,
    area: p.address || '',
    memo: p.note || '',
    image: null, // 실 사진 미연결 — 카드가 이 값을 보고 빈 상태를 그린다
    city: p.city || UNKNOWN_CITY,
    cityKnown: !!p.city,
    cityConfirmed: !!p.cityConfirmed,
    cityHint: p.city ? null : daCityHint(p), // 확정 아님 — 제안용
    url: daLink(p),
    hasCoords: daHasCoords(p),
    needsLookup: daNeedsLookup(p),
    lookupState: daLookupState(p),
    lat: p.lat, lng: p.lng,
    sourceLists: Array.isArray(p.sourceLists) ? p.sourceLists : [],
    dupCandidateIds: Array.isArray(p.dupCandidateIds) ? p.dupCandidateIds : [],
    // 2026-09-11 재검토(9차) — 같은 필드를 두 기기가 서로 다르게
    // 고친 진짜 충돌(daRemergePlaceConflict가 남겨 둔 것). 화면에서
    // 조용히 사라지지 않게 그대로 넘긴다.
    fieldConflicts: p._fieldConflicts || null,
    // 6-1절 — 정렬·"이번에 추가된 곳" 표시의 근거. 원본에 저장일이
    // 없으면 originalSavedAt은 undefined 그대로 넘어간다(지어내지 않음).
    originalSavedAt: p.originalSavedAt || null,
    firstAddedAt: p.firstAddedAt || null,
    importBatchId: p.importBatchId || null,
    // 6-2절 — 상위분류(category)는 그대로, 세부 다중 태그만 추가로 넘긴다.
    tags: Array.isArray(p.tags) ? p.tags : [],
    tagsConfirmed: !!p.tagsConfirmed,
  }));
  const byCity = new Map();
  spots.forEach((s) => { byCity.set(s.city, (byCity.get(s.city) || 0) + 1); });
  const cities = [...byCity.keys()]
    .sort((a, b) => (a === UNKNOWN_CITY) - (b === UNKNOWN_CITY) || byCity.get(b) - byCity.get(a))
    .map((name) => ({ name, label: name === UNKNOWN_CITY ? UNKNOWN_CITY : name, country: '', count: byCity.get(name) }));
  return { spots, cities };
}

/* 2026-09-09 코드 검토 — 로드맵 ⑧⑨ 구매 흐름·백엔드 연동.
   서버(server/) API를 부르는 공통 헬퍼. window.API_BASE가 없으면
   같은 출처(같은 서버가 이 정적 파일도 같이 서빙하는 배포 형태)로
   본다 — 테스트에서는 임시로 띄운 서버 주소를 명시적으로 넣어 준다.
   세션 토큰은 foodMap.session에 저장한다(다른 저장 데이터와 같은
   localStorage 키를 그대로 쓴다 — 새 저장 키를 안 만든다). */
function daApiBase() { return (typeof window !== 'undefined' && window.API_BASE) || ''; }
function daSessionToken(foodMap) { return (foodMap && foodMap.session && foodMap.session.token) || null; }
async function daApi(path, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  try {
    const res = await fetch(daApiBase() + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* 본문 없음 */ }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, reason: 'network', json: null };
  }
}

window.DesignAdapter = {
  UNKNOWN_CITY,
  SALE_MODE,
  api: daApi,
  apiBase: daApiBase,
  sessionToken: daSessionToken,
  loadFoodMap: () => {
    const fm = daLoad('foodmap_v1', { places: [], dest: '', destCountry: '' });
    // 2026-09-11 재검토(10차) 4절 — 사용자가 만든 태그도 계정 데이터의
    // 일부다. fm.customTags를 그대로 _customTags가 가리키게 해(별도
    // 복사본을 안 둠) daCreateTag 등의 in-place 변경이 곧바로
    // foodMap.customTags에도 반영되게 한다 — saveFoodMap 호출 때 별도
    // 동기화 코드가 필요 없다.
    fm.customTags = Array.isArray(fm.customTags) ? fm.customTags : [];
    _customTags = fm.customTags;
    fm.deletedTagIds = Array.isArray(fm.deletedTagIds) ? fm.deletedTagIds : [];
    _deletedTagIds = fm.deletedTagIds;
    _stampPlaceVersions(fm.places); // 버전 필드가 없는(한 번도 저장 안 된) 장소만 0으로 초기화.
    _migrateTags(fm.places); // 6-2절 — tags 필드가 아예 없는 예전 장소(약 160곳 포함)를 1회 채움.
    // 2026-09-11 재검토(10차) — "지금 로컬에 있는 내용"이 아니라 "마지막
    // 으로 서버와 실제로 맞춘 시점의 내용"을 기준선으로 복원한다(재시작
    // 보존). 이 앱은 로그인 직후에도 이 함수를 다시 부르지 않으므로,
    // 계정 전환 시 새는 걸 막는 책임은 daLogout()의 clearSyncBaselines
    // 호출에 있다(로그아웃 시 반드시 먼저 지운다).
    _restoreBaselinesFromStorage();
    return fm;
  },
  saveFoodMap: (fm) => { _stampPlaceVersions(fm.places); return daSave('foodmap_v1', fm); },
  resyncPlacesBaseline: _resetPlacesSnapshot,
  getPlaceBaseline: _getPlaceBaseline,
  placeContentKey: _placeContentKey,
  resyncCoursesBaseline: _resetCoursesSnapshot,
  getCourseBaseline: _getCourseBaseline,
  resyncTripsBaseline: _resetTripsSnapshot,
  getTripBaseline: _getTripBaseline,
  resyncTagsBaseline: _resetTagsSnapshot,
  getTagBaseline: _getTagBaseline,
  tagContentKey: _tagContentKey,
  clearSyncBaselines: _clearSyncBaselines,
  parseCsv: daCsv,
  parseJson: daJsonPlaces,
  merge: daMerge,
  buildSpots: daBuildSpots,
  cityGuess: daCityGuess,
  cityHint: daCityHint,
  assignCity: daAssignCity,
  resolveDup: daResolveDup,
  setCat: daSetCat,
  setTags: daSetTags,
  inferTags: daInferTags,
  knownCats: FM_INFER.map((x) => x[0]).concat('기타'),
  // 2026-09-11 재검토(10차) 4절 — getter로 둬서 세션 중 사용자가 만든
  // 태그(daCreateTag)도 곧바로 반영되게 한다. 21개는 시작 어휘일 뿐
  // 허용 목록 전체가 아니라는 지시를 그대로 구현한 부분이다.
  get knownTags() { return _allTagEntries().map((t) => t.label); },
  get tagEntries() { return _allTagEntries().map((t) => ({ id: t.id, label: t.label, source: t.source || 'builtin' })); },
  createTag: daCreateTag,
  renameTag: daRenameTag,
  deleteCustomTag: daDeleteCustomTag,
  bulkSetTag: daBulkSetTag,
  findTagByLabel: daFindTagByLabel,
  normalizeTagLabel: daNormalizeTagLabel,
  // 2026-09-11 재검토(11차) — 태그 레지스트리 계정별 동기화(daSyncPush가
  // 씀). rawCustomTags는 저장 그대로(id/label/synonyms/source/version)를
  // 돌려준다 — knownTags/tagEntries는 화면 표시용으로 이미 가공돼 있어
  // 동기화 페이로드로 못 쓴다.
  get rawCustomTags() { return _customTags; },
  get deletedTagIds() { return _deletedTagIds; },
  // fm.customTags/fm.deletedTagIds를 spots.js가 통째로 새 배열로
  // 바꿔치기한 뒤(서버 응답 반영) 이 어댑터의 내부 참조도 다시
  // 맞춘다 — loadFoodMap이 처음 연결할 때와 같은 이유(별도 복사본을
  // 두지 않고 항상 같은 배열을 가리키게 해 CRUD 함수의 in-place
  // 변경이 곧바로 foodMap에도 반영되게 한다).
  resyncCustomTagsRef(fm) {
    fm.customTags = Array.isArray(fm.customTags) ? fm.customTags : [];
    _customTags = fm.customTags;
    fm.deletedTagIds = Array.isArray(fm.deletedTagIds) ? fm.deletedTagIds : [];
    _deletedTagIds = fm.deletedTagIds;
  },
  applyConfirmedTypes: daApplyConfirmedTypes,
  needsAiClassify: daNeedsAiClassify,
  aiClassifyInputFingerprint: daAiClassifyInputFingerprint,
  applyAiClassifyResult: daApplyAiClassifyResult,
  t: daT,
  setLocale: daSetLocale,
  get locale() { return daLocale(); },
  knownCities: Object.keys(FM_CITY_ALT),
  esc: daEsc,
  hasCoords: daHasCoords,
  needsLookup: daNeedsLookup,
  lookupState: daLookupState,
  migrateStorage: daMigrateStorage,
  destNow: daDestNow,
  sortSpots: daSortSpots,
  centroid: daCentroid,
  testModeAllowed: daTestModeAllowed,
  refreshTestAccess: daRefreshTestAccess,
  testLocationPresets: TEST_LOCATION_PRESETS,
  getTestLocation: daGetTestLocation,
  setTestLocation: daSetTestLocation,
  clearTestLocation: daClearTestLocation,
};
