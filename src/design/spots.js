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

let city = cities[0] ? cities[0].name : '';
let filter = '전체', selected = new Set(), route = new Set(), selecting = false;

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
  const list = spots.filter((p) => p.city === city && (filter === '전체' || p.category === filter)
    && [p.name, p.area, p.category, p.memo].some((v) => String(v || '').toLowerCase().includes(q)));
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
function resetSearch() { $('#search').value = ''; filter = '전체'; document.querySelectorAll('[data-filter]').forEach((x) => { x.classList.toggle('active', x.dataset.filter === '전체'); x.setAttribute('aria-pressed', x.dataset.filter === '전체'); }); render(); }
function toggle(id) { selected.has(id) ? selected.delete(id) : selected.add(id); render(); }
function open(title, html) { $('#sheetLabel').textContent = title; $('#sheetContent').innerHTML = html; if (!sheet.open) sheet.showModal(); }

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
      cityBlock += `<div class="inline-note">${lookupMsg} 자동 조회는 아직 연결되지 않았습니다.` +
        (p.url ? `<br><a class="text-button" href="${A.esc(p.url)}" target="_blank" rel="noopener noreferrer">Google 지도에서 직접 열어 확인하기 ↗</a>` : '') +
        `</div>`;
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
  open(usingSample ? '샘플 장소' : '내 장소', `<div class="detail">${photoHTML(p, 'detail-photo')}<h2>${A.esc(p.name)}</h2><span class="category">${A.esc(p.category)}${!usingSample && !p.catConfirmed ? '(짐작)' : ''}</span>${catBlock}${!usingSample ? ` <span class="category">${A.esc(p.city)}${p.cityKnown && !p.cityConfirmed ? '(짐작)' : ''}</span>` : ''}<p>${A.esc(p.area) || '위치 정보 없음'}</p>${p.memo ? `<p>“${A.esc(p.memo)}”</p>` : ''}<button class="primary" data-detail-pick="${id}">${selected.has(id) ? '선택에서 빼기' : '오늘 갈 곳으로 선택'}</button>${mapHref ? `<a target="_blank" rel="noopener noreferrer" href="${mapHref}">${mapLabel}</a>` : ''}${cityBlock}${notes.map((n) => `<small>${n}</small>`).join('')}</div>`);
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
  refreshFromStorage();
  city = cityName;
  updateCity();
  sheet.close();
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
  if (foodMap && foodMap.course && Array.isArray(foodMap.course.stops) && foodMap.course.stops.length
    && (!foodMap.course.city || foodMap.course.city === city)) {
    showSavedCourse();
    return;
  }
  const list = spots.filter((p) => p.city === city && route.has(p.id));
  open(city + ' · 오늘 동선', `<div class="detail"><h2>오늘은 이곳으로.</h2><p>${list.length ? '담아 둔 ' + list.length + '곳을 확인하세요.' : '마음에 드는 장소를 먼저 골라보세요.'}</p>${list.map((p, i) => `<div class="route-row"><span>${i + 1}</span>${photoHTML(p, '')}<div><b>${A.esc(p.name)}</b><p>${A.esc(p.area)}</p></div><button data-remove="${p.id}" aria-label="${A.esc(p.name)} 동선에서 빼기">×</button></div>`).join('')}${list.length ? '<button class="primary" data-build-course>코스 만들기 ↗</button>' : ''}<button class="text-button" data-dismiss>스팟 더 고르기</button></div>`);
}
/* ── 짧은 구매 흐름(로드맵 ⑨) ────────────────────────────────────────
   샘플 체험 → 가져오기 → (필요할 때만) 로그인 → 내 코스 결과 →
   (더 필요할 때만) 이용권 제시 → 결제 → 원래 코스로 복귀.
   "무료 결과의 실제 가치를 먼저 보여주고, 그다음에 유료 기능을
   제시한다. 데이터를 불편하게 잠가서 결제를 강요하지 않는다"는
   원칙대로, 이미 만들어 둔 첫 코스는 로그인 없이 그대로 다시 볼 수
   있다 — 게이트는 "코스를 새로 만들려는" 시점에만 걸린다. */

/* 이미 코스를 한 번 만들어 봤는지가 곧 "무료체험을 이미 썼는지"의
   1차 신호다(정확한 판정은 로그인 뒤 서버가 한다 — 이건 로그인을
   물어볼지 말지 결정하는 데만 쓰는 로컬 신호). */
function daHasBuiltCourseBefore() {
  return !!(foodMap.course && Array.isArray(foodMap.course.stops) && foodMap.course.stops.length);
}

/* "코스 만들기"를 실제로 누르기 전에 통과해야 하는 문. 처음 만드는
   코스는 무엇도 안 묻고 바로 통과시킨다(무료 체험 자체에 로그인을
   요구하지 않는다). 이미 한 번 만들어 봤다면 로그인 → 서버가 판정한
   무료체험/이용권 상태를 확인한 뒤에만 통과시킨다. */
async function daGateThenBuildCourseSheet() {
  if (!daHasBuiltCourseBefore()) { buildCourseSheet(); return; }
  const token = A.sessionToken(foodMap);
  if (!token) { showLoginSheet(daGateThenBuildCourseSheet); return; }
  const trial = await A.api('/api/trial', { token });
  if (trial.ok && trial.json && trial.json.used === false) { buildCourseSheet(); return; }
  const ent = await A.api('/api/entitlement', { token });
  if (ent.ok && ent.json && ent.json.plan === 'paid') { buildCourseSheet(); return; }
  daTrackSafe('paywall_viewed', { trigger: 'second_course' });
  showPaywallSheet(ent.ok ? ent.json.price : null);
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
  open('코드 확인', `<div class="detail"><h2>이메일로 받은 코드를 입력하세요</h2><p>${A.esc(email)}로 6자리 코드를 보냈어요.</p>` +
    `<input class="xinput" id="loginCode" inputmode="numeric" placeholder="6자리 코드" style="width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit">` +
    `<button class="primary" id="loginVerifyBtn" style="margin-top:10px">확인</button>` +
    `<p class="inline-note" id="loginMsg" hidden></p></div>`);
  const msg = (t2) => { const el = $('#loginMsg'); el.textContent = t2; el.hidden = false; };
  $('#loginVerifyBtn').onclick = async () => {
    const code = $('#loginCode').value.trim();
    const r = await A.api('/api/auth/verify-code', { method: 'POST', body: { email, code } });
    if (!r.ok || !r.json || !r.json.token) { msg('코드가 맞지 않거나 만료됐어요. 다시 시도해 주세요.'); return; }
    foodMap.session = { token: r.json.token, email };
    A.saveFoodMap(foodMap);
    /* 2026-09-09 코드 검토(2차) 재현된 버그: 로그인 전에 이미 코스를
       한 번 만들어 봤다면 그 무료체험은 서버가 전혀 모른다(계정 자체가
       로그인 전엔 없었으니 서버에 반영할 대상이 없었다). 로그인하자마자
       그 사실을 서버에 알리지 않으면, 로그인 뒤 서버가 "아직 무료체험
       안 씀"으로 잘못 판단해 이용권 화면 없이 두 번째 코스를 그냥
       통과시켜 버린다 — 무료체험이 사실상 무제한이 되는 구멍이었다.
       consumeTrial은 멱등이라(이미 반영됐으면 조용히 무시) 여러 번
       불러도 안전하다. */
    if (daHasBuiltCourseBefore()) await A.api('/api/trial/consume', { method: 'POST', token: r.json.token });
    onSuccess();
  };
}
/* 이용권 제시 — 금액·기간·자동결제 여부를 분명히 보여준다(로드맵 ⑨
   요구사항: "금액/기간/자동결제 여부를 분명히 표시"). 결제 자체는
   실제 PG 연동 전까지 서버의 개발용 시뮬레이션을 부른다 — 클라이언트가
   "결제했다"고 스스로 선언하는 게 아니라, 서버가 자체 서명한 가짜
   웹훅을 실제 웹훅 처리 코드에 흘려보내는 방식이라 서명 검증·이용권
   반영 코드 경로 자체는 실제와 동일하다(server/routes/dev.mjs 참고). */
function showPaywallSheet(price) {
  const p = price || { amountKrw: 9900, periodDays: 30, autoRenew: false };
  open('이용권', `<div class="detail"><h2>더 만들려면 이용권이 필요해요</h2>` +
    `<p>무료 체험(코스 1회)은 이미 쓰셨어요. 계속 이용하시려면 아래 이용권을 확인해 주세요.</p>` +
    `<div class="inline-note"><b>${p.amountKrw.toLocaleString()}원</b> / ${p.periodDays}일<br>자동결제: ${p.autoRenew ? '켜짐(직접 해지 전까지 자동으로 갱신)' : '꺼짐(자동으로 다시 결제되지 않음)'}</div>` +
    `<button class="primary" id="payBtn" style="margin-top:10px">결제하기</button>` +
    `<button class="text-button" data-dismiss>다음에 할게요</button></div>`);
  $('#payBtn').onclick = async () => {
    daTrackSafe('payment_started', { amount_krw: p.amountKrw, period_days: p.periodDays });
    const token = A.sessionToken(foodMap);
    const r = await A.api('/api/dev/simulate-payment', { method: 'POST', token, body: { outcome: 'success' } });
    if (!r.ok) { daTrackSafe('payment_result', { result: 'failure' }); alert('결제를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'); return; }
    daTrackSafe('payment_result', { result: 'success' });
    // 결제 성공 뒤에는 원래 하려던 동작(코스 새로 만들기)으로 그대로 이어간다.
    buildCourseSheet();
  };
}

/* 출발지·가용 시간을 물어보는 시트. 출발지는 API 키 없이 되는 두 가지만
   준다 — 현재 위치(브라우저 GPS) 또는 담아 둔 곳 중 하나.
   2026-09-09 코드 검토(2차): route(오늘 동선)에는 다른 도시에서 담아 둔
   id가 도시를 바꾼 뒤에도 남아 있을 수 있다 — 지금 보고 있는 도시로
   한 번 더 걸러야 다른 도시 장소가 코스에 섞여 들어가지 않는다. */
function buildCourseSheet() {
  const list = spots.filter((p) => p.city === city && route.has(p.id));
  open('출발지 정하기', `<div class="detail"><h2>어디서 출발할까요?</h2>` +
    `<p>${list.length}곳을 실제 방문 순서·이동시간으로 만듭니다.</p>` +
    `<div class="city-options"><button class="city-option" data-start-gps><span><b>현재 위치에서 출발</b><small>브라우저 위치 권한이 필요해요</small></span><span class="city-check">›</span></button>` +
    list.map((p) => `<button class="city-option" data-start-pick="${p.id}"><span><b>${A.esc(p.name)}</b><small>${p.hasCoords ? '이 장소에서 출발' : '좌표가 없어 출발지로 못 씀'}</small></span><span class="city-check">${p.hasCoords ? '›' : '—'}</span></button>`).join('') +
    `</div><label class="xsmall" style="display:block;margin-top:6px">쓸 수 있는 시간(분, 선택)<input class="xinput" id="courseMinutes" type="number" min="30" step="10" placeholder="예: 240" style="margin-top:6px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:20px;border:1px solid #e5e6e1;font:inherit"></label></div>`);
  $('#sheetContent').querySelectorAll('[data-start-pick]').forEach((b) => {
    b.onclick = () => { const p = spots.find((s) => s.id === b.dataset.startPick); if (p && p.hasCoords) runCourseGeneration({ lat: p.lat, lng: p.lng }, p.id); };
  });
  const gpsBtn = $('[data-start-gps]');
  if (gpsBtn) gpsBtn.onclick = () => {
    if (!navigator.geolocation) { alert('이 브라우저는 위치 기능을 지원하지 않아요. 목록에서 출발지를 골라 주세요.'); return; }
    gpsBtn.textContent = '위치 확인 중…';
    navigator.geolocation.getCurrentPosition(
      (pos) => runCourseGeneration({ lat: pos.coords.latitude, lng: pos.coords.longitude }, null),
      () => { alert('현재 위치를 가져오지 못했어요. 목록에서 출발지를 골라 주세요.'); buildCourseSheet(); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };
}
/* 실제로 코스를 만든다 — CourseGen.generate가 도보는 실제 라우팅으로,
   실패하면 직선거리 추정으로 계산해 돌려준다(어느 쪽인지 결과에
   routedReal로 표시돼 있어 화면에서 정직하게 구분해 보여준다). */
async function runCourseGeneration(origin, startPlaceId) {
  const minutesInput = $('#courseMinutes');
  const budgetMinutes = minutesInput && minutesInput.value ? +minutesInput.value : null;
  /* 2026-09-09 코드 검토(2차): route에 다른 도시 id가 남아 있을 수 있어
     여기서도 지금 도시로 한 번 더 거른다(buildCourseSheet만 걸러서는
     이 함수가 다른 경로로 직접 불릴 가능성까지 막지 못한다). */
  const list = spots.filter((p) => p.city === city && route.has(p.id) && p.id !== startPlaceId);
  /* 시작 시각은 "오전 9시" 고정이 아니라 여행지 현지의 지금 시각이다 —
     밤에 코스를 다시 짜면 밤부터, 아침이면 아침부터 계산해야 도착 예정
     시각이 실제로 말이 된다(이전엔 언제 눌러도 항상 9시부터로 계산해
     실제 지금 시각과 무관한 숫자를 보여줬다). */
  const destNow = A.destNow(city);
  const startMinutes = destNow.hour * 60 + destNow.minute;
  open('코스 만드는 중', '<div class="detail"><h2>실제 이동시간을 계산하고 있어요…</h2><p>도보 경로를 먼저 확인합니다. 네트워크 상태에 따라 몇 초 걸릴 수 있어요.</p></div>');
  const result = await window.CourseGen.generate(origin, list, { startMinutes, budgetMinutes });
  if (!result.ok) {
    open('코스를 만들 수 없어요', '<div class="detail"><h2>좌표가 있는 곳이 없어요.</h2><p>담아 둔 곳 모두 좌표가 없어 이동시간을 계산할 수 없습니다. 장소 상세에서 위치를 먼저 확인해 주세요.</p><button class="primary" data-dismiss>돌아가기</button></div>');
    return;
  }
  /* 2026-09-09 코드 검토(2차): 저장하는 코스에 도시·출발지·이동수단·
     계산 근거·생성 조건을 같이 남긴다 — 안 남기면 도시를 바꿨을 때 이
     코스가 어느 도시 것인지 구분할 수 없고("새로고침해도 유지"라는 게
     오히려 사고가 된다), 나중에 "이 코스는 무슨 조건으로 짰었는지"도
     알 수 없다. 새로 만들기 전까지는 기존 코스를 절대 먼저 지우지
     않는다 — 여기서 결과가 확정된 뒤에만 교체한다(실패·취소 시 이전
     코스가 그대로 남는다). */
  const newCourse = {
    made: new Date().toISOString().slice(0, 10),
    city,
    origin,
    mode: 'walking',
    startHour: destNow.hour,
    startMinutes,
    budgetMinutes: budgetMinutes || null,
    goals: [],
    stops: result.stops,
    endAt: result.endAt,
    walkTotal: result.walkTotal,
    routedReal: result.routedReal,
    totalMeters: result.totalMeters,
    excludedIds: result.excluded.map((p) => p.id),
    excludedReasons: result.excludedReasons || {},
    source: 'design',
  };
  foodMap.course = newCourse;
  const saved = A.saveFoodMap(foodMap);
  if (!saved) {
    /* 저장이 실패하면 저장소는 안 바뀌어 있으니, 저장소에서 다시 읽어
       오면 이전 코스가 그대로 살아난다(방금 만든 새 코스로 메모리만
       앞서가 있던 상태를 되돌린다 — 실패를 성공처럼 반영하지 않는다). */
    foodMap = A.loadFoodMap();
    alert('코스를 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');
    showRoute();
    return;
  }
  daTrackSafe('course_generated', { routed_real: !!newCourse.routedReal, stop_count: newCourse.stops.length });
  /* 로그인한 상태에서 무료체험을 아직 안 썼다면, 방금 만든 이 코스가
     그 1회를 쓴 것으로 서버에 반영한다(로그인 전 첫 코스는 서버에
     전혀 알리지 않는다 — 05_IMPORT_ONBOARDING_SPEC.md: "무료 결과의
     실제 가치를 먼저 보여주고, 그 다음에 유료 기능을 제시한다"는
     방향대로, 로그인을 요구하기 전까지는 서버 판정 자체가 끼어들지
     않는다). 유료 이용권이 있으면 애초에 체험 소진이 필요 없다 —
     daGateThenBuildCourseSheet가 그 경우엔 서버를 아예 안 부르고
     바로 통과시키므로 여기서도 다시 확인할 필요는 없지만, 상태가
     그 사이 바뀌었을 수 있어 안전하게 한 번 더 확인한다. */
  const token = A.sessionToken(foodMap);
  if (token) {
    const trial = await A.api('/api/trial', { token });
    const ent = await A.api('/api/entitlement', { token });
    const isPaid = ent.ok && ent.json && ent.json.plan === 'paid';
    if (!isPaid && trial.ok && trial.json && trial.json.used === false) {
      await A.api('/api/trial/consume', { method: 'POST', token });
    }
  }
  showSavedCourse();
}
/* 저장된 코스를 보여준다 — 새로고침해도 foodMap.course에 남아 있어
   그대로 다시 보인다. 실제 경로인지 추정인지 구분해서 보여주고(2026-
   09-09 코드 검토 — 직선거리를 실제 최단 동선처럼 보여주지 말 것),
   좌표가 없어 빠진 곳은 목록으로 따로 보여준다(조용히 안 뺌). 대중교통·
   택시·자전거는 자체 계산 없이 구글 지도로 바로 연결한다("연결된
   범위만 제공"). */
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
  open('오늘의 코스', `<div class="detail"><h2>${c.stops.length}곳 · 도보 이동 ${hours ? hours + '시간 ' : ''}${mins}분</h2>` +
    `<p>${c.routedReal ? '실제 도보 경로 기준으로 계산했습니다.' : '실제 경로 연결에 실패해 직선거리 기준으로 추정했습니다(실제와 다를 수 있어요).'} 총 이동 거리 약 ${totalKm}km · 마지막 장소 도착 예정 ${window.CourseGen.clockLabel(c.endAt - (c.stops[c.stops.length - 1] ? c.stops[c.stops.length - 1].dwell : 0))}</p>` +
    stopViews +
    (noCoordsList.length ? `<div class="inline-note">좌표가 없어 이번 코스 계산에서 빠진 곳 ${noCoordsList.length}곳: ${noCoordsList.map((p) => A.esc(p.name)).join(', ')}. 위치를 확인하면 다음 코스에 포함할 수 있어요.</div>` : '') +
    (timeList.length ? `<div class="inline-note">가용 시간 안에 다 들르지 못해 빠진 곳 ${timeList.length}곳: ${timeList.map((p) => A.esc(p.name)).join(', ')}. 쓸 수 있는 시간을 늘리거나 곳 수를 줄이면 포함할 수 있어요.</div>` : '') +
    `<button class="text-button" data-course-new>새로 만들기</button><button class="primary" data-dismiss>확인</button></div>`);
}
function profile() {
  const realCount = foodMap.places ? foodMap.places.length : 0;
  open('내 프로필', `<div class="profile"><div class="avatar">Y</div><h2>나의 여행 기록</h2><p>가고 싶은 곳을 하나씩 모으는 중</p><div class="stats"><div><b>${realCount}</b><span>저장한 스팟</span></div><div><b>${cities.length}</b><span>도시</span></div><div><b>${route.size}</b><span>오늘 갈 곳</span></div></div><p>${A.esc(city)} · ${usingSample ? '샘플 컬렉션' : '내 데이터'}</p><button class="primary" data-dismiss>내 스팟으로 돌아가기</button>${usingSample ? '<p>샘플 프로필입니다.</p>' : ''}</div>`);
}
function updateCity() {
  $('#cityName').textContent = city;
  const c = cities.find((x) => x.name === city);
  $('#albumCity').textContent = c ? (c.label || c.name).toUpperCase() : '';
  $('.filters').innerHTML = ['전체', ...new Set(spots.filter((p) => p.city === city).map((p) => p.category))]
    .map((c2) => `<button data-filter="${A.esc(c2)}" class="${c2 === filter ? 'active' : ''}" aria-pressed="${c2 === filter}">${A.esc(c2)}</button>`).join('');
  render();
}
function chooseCity(name) { city = name; filter = '전체'; selecting = false; $('#search').value = ''; updateCity(); sheet.close(); }
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
  finishImport([{ label, z: A.merge(parsed, label, foodMap.places) }], []);
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
    perFile.push({ label: shortName, z: A.merge(parsed, shortName.replace(/\.(csv|json)$/i, ''), foodMap.places) });
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
function nearby() {
  open('내 주변', `<div class="detail"><h2>지금 가까운 곳부터.</h2><p>현재 위치를 출발점으로, ${A.esc(city)}에 저장한 장소를 가까운 순서로 보여줄 공간입니다.</p><div class="inline-note">선택한 여행지: ${A.esc(city)}<br>위치 권한은 이 기능을 사용할 때만 요청합니다.</div><small>GPS 연결 전인 화면입니다. 현재 위치를 수집하거나 거리순으로 정렬하지 않습니다.</small><button class="primary" data-dismiss>저장한 스팟 계속 보기</button><button class="text-button" data-city-picker>여행지 바꾸기</button></div>`);
}

$('#search').addEventListener('input', render);
$('#clear').onclick = () => { $('#search').value = ''; render(); $('#search').focus(); };
$('.filters').onclick = (e) => { const b = e.target.closest('[data-filter]'); if (!b) return; filter = b.dataset.filter; document.querySelectorAll('[data-filter]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b); }); render(); };
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
  if (b.dataset.dupMerge) { const [x, y] = b.dataset.dupMerge.split('|'); return resolveDup(x, y, 'merge'); }
  if (b.dataset.dupDismiss) { const [x, y] = b.dataset.dupDismiss.split('|'); return resolveDup(x, y, 'dismiss'); }
  /* 2026-09-09 코드 검토(2차, 로드맵 ⑨): 처음 만드는 코스는 무료
     체험이라 곧바로 buildCourseSheet로 간다. 두 번째부터는
     daGateThenBuildCourseSheet가 로그인·무료체험/이용권 상태를
     먼저 확인한다(둘 다 이 게이트를 거친다 — daHasBuiltCourseBefore가
     "처음인지"를 판정한다). */
  if (b.hasAttribute('data-build-course')) return daGateThenBuildCourseSheet();
  /* 예전엔 여기서 기존 코스를 먼저 지우고 저장했다 — 그 상태에서
     출발지 화면을 취소하거나 코스 생성이 실패하면 이전 코스가 사라진
     채로 남았다. 이제 기존 코스는 그대로 두고 게이트를 거쳐 출발지
     화면으로만 넘어간다 — 실제로 새 코스가 완성돼 저장에 성공했을
     때만(runCourseGeneration) 교체된다. */
  if (b.hasAttribute('data-course-new')) daGateThenBuildCourseSheet();
};
function resolveDup(aId, bId, action) {
  const result = A.resolveDup(foodMap.places, aId, bId, action);
  if (!result) return;
  /* 2026-09-09 코드 검토(2차): 저장된 코스(foodMap.course.stops·
     excludedIds)에도 삭제되는 쪽 id가 남아 있을 수 있다 — 여긴
     places 배열이 아니라 foodMap에 직접 딸린 데이터라서 A.resolveDup가
     손대지 않는다. 여기서 옮겨 두지 않으면 합친 뒤 "저장된 코스"를
     다시 열었을 때 이미 없어진 장소를 가리키는 조용한 참조 오류가
     남는다. saveFoodMap을 부르기 전에 옮겨야 이번 저장에 같이 반영된다. */
  if (result.survivorId && result.mergedId && foodMap.course) {
    const from = result.mergedId, to = result.survivorId;
    if (Array.isArray(foodMap.course.stops)) {
      foodMap.course.stops.forEach((s) => { if (s.id === from) s.id = to; });
    }
    if (Array.isArray(foodMap.course.excludedIds)) {
      foodMap.course.excludedIds = foodMap.course.excludedIds.map((id) => (id === from ? to : id));
    }
    if (foodMap.course.excludedReasons && foodMap.course.excludedReasons[from] !== undefined) {
      foodMap.course.excludedReasons[to] = foodMap.course.excludedReasons[from];
      delete foodMap.course.excludedReasons[from];
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
  refreshFromStorage();
  updateCity();
  const stillThere = spots.find((s) => s.id === aId);
  if (stillThere) detail(aId); else sheet.close();
}
$('#addRoute').onclick = () => {
  const ids = spots.filter((p) => p.city === city && selected.has(p.id)).map((p) => p.id);
  if (city === A.UNKNOWN_CITY) return cityAssignSheet(ids);
  ids.forEach((id) => { route.add(id); selected.delete(id); });
  selecting = false; render(); showRoute();
};
$('#route').onclick = showRoute;
document.querySelectorAll('[data-profile]').forEach((b) => { b.onclick = profile; });
document.querySelectorAll('[data-add]').forEach((b) => { b.onclick = add; });
$('#browse').onclick = () => $('.section-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
$('#home').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
$('#collection').onclick = () => $('.album').scrollIntoView({ behavior: 'smooth', block: 'center' });
$('#cityPicker').onclick = cityPicker;
$('#nearby').onclick = nearby;

updateCity();
