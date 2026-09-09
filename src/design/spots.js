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
  if (usingSample) notes.push('실제 매장이 아닌 디자인 예시입니다. 사진은 분위기 참고용이며 주소·전화번호는 실제 장소 연결 후 표시됩니다.');
  else {
    if (!p.image) notes.push('사진은 아직 연결되지 않았습니다. 주소·전화번호·영업시간은 다음 단계에서 연결합니다.');
    if (!p.cityKnown) notes.push('도시를 확인하지 못했습니다. 주소나 지도 링크로 나중에 확인해 주세요.');
    if (p.sourceLists && p.sourceLists.length > 1) notes.push('여러 목록(' + p.sourceLists.map(A.esc).join(' · ') + ')에 저장돼 있어 하나로 합쳤습니다.');
  }
  open(usingSample ? '샘플 장소' : '내 장소', `<div class="detail">${photoHTML(p, 'detail-photo')}<h2>${A.esc(p.name)}</h2><span class="category">${A.esc(p.category)}</span>${!usingSample ? ` <span class="category">${A.esc(p.city)}</span>` : ''}<p>${A.esc(p.area) || '위치 정보 없음'}</p>${p.memo ? `<p>“${A.esc(p.memo)}”</p>` : ''}<button class="primary" data-detail-pick="${id}">${selected.has(id) ? '선택에서 빼기' : '오늘 갈 곳으로 선택'}</button>${mapHref ? `<a target="_blank" rel="noopener noreferrer" href="${mapHref}">${mapLabel}</a>` : ''}${notes.map((n) => `<small>${n}</small>`).join('')}</div>`);
}
function showRoute() {
  const list = spots.filter((p) => p.city === city && route.has(p.id));
  open(city + ' · 오늘 동선', `<div class="detail"><h2>오늘은 이곳으로.</h2><p>${list.length ? '담아 둔 ' + list.length + '곳을 확인하세요.' : '마음에 드는 장소를 먼저 골라보세요.'}</p>${list.map((p, i) => `<div class="route-row"><span>${i + 1}</span>${photoHTML(p, '')}<div><b>${A.esc(p.name)}</b><p>${A.esc(p.area)}</p></div><button data-remove="${p.id}" aria-label="${A.esc(p.name)} 동선에서 빼기">×</button></div>`).join('')}<small>최단거리 계산과 교통 안내는 아직 연결되지 않았습니다.</small><button class="primary" data-dismiss>스팟 더 고르기</button></div>`);
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
  open('내 장소 가져오기', `<div class="detail import-flow"><span class="flow-tag">실제 가져오기</span><h2>저장한 곳,<br>그대로 모아볼까요?</h2><p>구글맵에서 내보낸 <b>CSV 또는 JSON</b> 파일로 시작해요. (ZIP은 아직 자동으로 못 풀어요 — 먼저 압축을 풀어 주세요.)</p><div class="file-surface"><span class="file-symbol">↓</span><b>내보낸 파일 가져오기</b><span>CSV · JSON</span></div><input type="file" id="realFileIn" accept=".csv,text/csv,.json,application/json" style="display:none"><button class="primary" id="realFileBtn">받은 CSV 또는 JSON 선택</button>${importMsg ? `<p class="inline-note">${importMsg}</p>` : ''}<button class="text-button" id="sampleBtn">샘플로 먼저 둘러보기</button><details class="import-help"><summary>구글맵에서 파일은 어떻게 받나요?</summary><ol><li>Google Takeout을 열어요.</li><li>‘저장됨(Saved)’ 항목을 선택해 내보내세요.</li><li>받은 zip을 풀고, 그 안의 csv/json 파일을 이 화면에서 가져옵니다.</li></ol><a href="https://takeout.google.com/" target="_blank" rel="noopener noreferrer">Google Takeout 열기 ↗</a><p>계정에 따라 내보내기 준비 시간이 걸릴 수 있어요.</p></details></div>`);
  $('#realFileBtn').onclick = () => $('#realFileIn').click();
  $('#realFileIn').onchange = handleRealFile;
  $('#sampleBtn').onclick = () => { usingSample = true; spots = SAMPLE_SPOTS; cities = SAMPLE_CITIES; city = cities[0].name; updateCity(); sheet.close(); };
}
async function handleRealFile(e) {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  e.target.value = '';
  let parsed = [];
  try {
    const txt = await f.text();
    if (/\.csv$/i.test(f.name)) parsed = A.parseCsv(txt);
    else if (/\.json$/i.test(f.name)) parsed = A.parseJson(JSON.parse(txt));
    else { importMsg = '이 형식은 아직 읽지 못해요. CSV 또는 JSON 파일을 선택해 주세요.'; add(); return; }
  } catch (err) {
    importMsg = '파일을 읽지 못했어요. 구글에서 받은 저장 목록 CSV/JSON이 맞는지 확인해 주세요.';
    add(); return;
  }
  if (!parsed.length) { importMsg = '이 파일에서 저장된 장소를 찾지 못했어요.'; add(); return; }
  /* 병합 로직은 private/personal.html 의 fmMerge 를 그대로 옮긴
     A.merge() 를 쓴다 — 여기서 다시 만들지 않는다(중복 판정이 갈리는 사고를
     막는다). 이름만 같아도 겹치는 걸 잡고, 겹친 목록 소속은 다 보존한다. */
  foodMap.places = foodMap.places || [];
  const label = f.name.replace(/\.(csv|json)$/i, '');
  const z = A.merge(parsed, label, foodMap.places);
  A.saveFoodMap(foodMap);
  usingSample = false;
  refreshFromStorage();
  /* 지금 보고 있는 도시가 사라졌으면 물론 바꾸고, "지역 확인 필요"를 보던
     중이었는데 이번에 실제 도시가 새로 확인됐으면 그쪽을 먼저 보여준다 —
     아는 도시가 생겼는데 계속 "확인 필요" 화면에 머무를 이유가 없다. */
  const known = cities.find((c) => c.name !== A.UNKNOWN_CITY);
  if (!cities.some((c) => c.name === city) || (city === A.UNKNOWN_CITY && known)) city = (known || cities[0]).name;
  filter = '전체';
  updateCity(); // 배경 화면(grid·count·filters·album)도 같이 갱신 — 안 부르면 결과 시트를 닫아도 화면이 그대로 샘플로 남는다
  importDone(z);
}
function importDone(z) {
  const total = (foodMap.places || []).length;
  const unknown = spots.filter((p) => !p.cityKnown).length;
  open('가져오기 결과', `<div class="detail import-flow"><span class="flow-tag">실제 결과</span><h2>${z.added + z.updated}곳을 확인했어요.</h2><p>도시별로 모아뒀어요.</p><div class="import-summary"><span><b>${z.added}</b>새로 추가</span><span><b>${z.updated}</b>기존 갱신</span><span><b>${total}</b>전체</span></div>${z.merged ? `<p class="inline-note">그중 ${z.merged}곳은 다른 목록에도 있던 같은 곳이라 하나로 합쳤어요(메모·소속 목록은 다 남겼어요).</p>` : ''}${cities.map((c) => `<button class="city-option" data-city="${A.esc(c.name)}"><span class="city-initial">${A.esc(c.name.slice(0, 1))}</span><span><b>${A.esc(c.name)}</b><small>${c.count}곳</small></span><span class="city-check">↗</span></button>`).join('')}<small>실제 파일 분석 결과입니다.${unknown ? ' 그중 ' + unknown + '곳은 도시를 확인 못 해 "지역 확인 필요"로 넣어 뒀어요.' : ''}</small></div>`);
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
};
$('#addRoute').onclick = () => { spots.filter((p) => p.city === city && selected.has(p.id)).forEach((p) => { route.add(p.id); selected.delete(p.id); }); selecting = false; render(); showRoute(); };
$('#route').onclick = showRoute;
document.querySelectorAll('[data-profile]').forEach((b) => { b.onclick = profile; });
document.querySelectorAll('[data-add]').forEach((b) => { b.onclick = add; });
$('#browse').onclick = () => $('.section-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
$('#home').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
$('#collection').onclick = () => $('.album').scrollIntoView({ behavior: 'smooth', block: 'center' });
$('#cityPicker').onclick = cityPicker;
$('#nearby').onclick = nearby;

updateCity();
