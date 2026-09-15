'use strict';
/**
 * 자전거 공유 반납 포트 안내(차리차리 등) — 2026-09-15 신규.
 *
 * 00_READ_FIRST_CLAUDE.md 1절 — "챠리챠리 앱을 복제하지 않고, 사용자가
 * 저장한 목적지에 도착하는 앞뒤의 번거로움을 줄인다." 대여·잠금 해제·
 * 실시간 반납 상태·이용 종료 확인은 전부 공식 앱/웹지도에서 한다 — 이
 * 화면은 (a) 목적지 근처 반납 포트 후보, (b) 그 포트까지/거기서
 * 목적지까지의 안내, (c) "반납했어요"를 사용자가 직접 누르는 수동
 * 전환만 다룬다.
 *
 * 승인된 디자인을 그대로 따른다 — spots.js의 open()/sheet 다이얼로그,
 * .detail/.city-option/.inline-note/.primary/.text-button 클래스를
 * 그대로 재사용하고 새 CSS·새 탭·지도 화면을 추가하지 않는다.
 *
 * 이 파일은 spots.js의 내부 상태(foodMap·spots·city 등)를 직접 건드리지
 * 않는다 — 전부 호출부(spots.js의 detail())가 명시적으로 넘겨준다.
 * open()·sheet·daToast·daRequestMyLocation·manualLocationSheet·A는
 * 전부 최상위 function 선언(호이스팅되는 전역)이라 로드 순서와 무관하게
 * 안전하게 참조할 수 있다(phrasebook.js와 같은 전제).
 */

let _bikeStatusCache = null; // 서버가 실제로 활성화한 지역 목록(성공 응답만 캐시)

/* token을 명시적으로 받는다 — 이 파일은 spots.js의 foodMap을 직접
   읽지 않는다(파일 상단 설명 참고). 로그인 전(토큰 없음)에 호출되면
   401을 받을 뿐인데, 그 실패는 캐시하지 않는다 — 로그인 후 다시
   부르면 정상적으로 다시 시도된다(부팅 시점엔 아직 로그인 전일 수
   있고, daOpenBikeGuide가 열릴 때는 이미 로그인 상태이므로 그때 다시
   확인된다). */
async function daBikePortsLoadStatus(token) {
  if (_bikeStatusCache) return _bikeStatusCache;
  const r = await A.api('/api/bike-ports/status', { token });
  if (r.ok && r.json && r.json.ok) { _bikeStatusCache = r.json.regions || []; return _bikeStatusCache; }
  return [];
}

/* 도시 이름으로 활성 지역을 찾는다 — 서버(bike-share-providers.mjs)가
   유일한 판정 근거이고, 이 파일은 그 응답을 그대로 따를 뿐 어떤 도시
   이름도 직접 하드코딩하지 않는다(7절). 캐시가 아직 안 찼으면(부팅
   직후 아주 짧은 순간) null — 다음 렌더에서 다시 시도된다. */
function daBikePortsRegionForCity(cityName) {
  if (!_bikeStatusCache || !cityName) return null;
  const needle = String(cityName).trim().toLowerCase();
  return _bikeStatusCache.find((r) => (r.cityNames || []).some((n) => String(n).toLowerCase() === needle)) || null;
}

/* 장소 상세 화면에 넣을 진입 버튼 — 좌표가 확정된 장소에서만, 그 도시가
   활성 지역일 때만 보여준다. */
function daBikeEntryButtonHTML(place) {
  if (!place || !place.hasCoords || place.needsLookup) return '';
  if (!daBikePortsRegionForCity(place.city)) return '';
  return `<button class="text-button" data-open-bike-guide style="padding:6px 0">🚲 자전거로 가기</button>`;
}

/* 출발지 — 테스트 위치 > 세션 GPS > 직접 입력만 인정한다. "평균 위치"는
   실제 출발점이 아니므로 이 기능에서는 절대 안 쓴다(3절 — "출발지
   없으면 '내 주변'이라고 표시하지 않기"). spots.js의 _myGpsLocation·
   _myManualLocation은 그 파일 안의 비공개 상태라 여기서 직접 못 읽으므로,
   호출부(daOpenBikeGuideSheet)가 origin을 인자로 받는다 — 이 함수는
   "origin이 없을 때 사용자에게 보여줄 화면"만 담당한다. */
function daBikeNoOriginSheetHTML() {
  return `<div class="detail"><h2>출발지를 알려주세요</h2>` +
    `<p>자전거로 이동할 실제 출발 지점이 필요해요 — 평균 위치로는 안내하지 않아요.</p>` +
    `<div class="city-options">` +
    `<button class="city-option" data-bike-origin-gps><span><b>내 위치 사용</b><small>브라우저 위치 권한이 필요해요</small></span><span class="city-check">›</span></button>` +
    `<button class="city-option" data-bike-origin-manual><span><b>직접 입력</b><small>숙소 좌표 등을 알고 있을 때</small></span><span class="city-check">›</span></button>` +
    `</div></div>`;
}

function daBikeHaversineMeters(a, b) {
  const r = Math.PI / 180;
  const a1 = a.lat * r, a2 = b.lat * r, da = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
  const z = Math.sin(da / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(z), Math.sqrt(1 - z));
}

function daBikeFmtMeters(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`; }
function daBikeFmtMinutes(s) { return `약 ${Math.max(1, Math.round(s / 60))}분`; }

function daBikeGoogleMapsBikeDirUrl(origin, dest) {
  return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&travelmode=bicycling`;
}

function daBikeUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'bike-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

/* 후보 목록 화면 — 목적지 주변 포트(직선거리순, 무료 조회). */
async function daBikeShowCandidates(place, region, origin, ctx) {
  open('반납 포트 고르기', `<div class="detail"><h2>불러오는 중…</h2></div>`);
  const r = await A.api(`/api/bike-ports/nearby?providerId=${encodeURIComponent(region.providerId)}&regionCode=${encodeURIComponent(region.regionCode)}&lat=${place.lat}&lng=${place.lng}&limit=3`, { token: ctx.token });
  if (!r.ok || !r.json || r.json.ok === false || !r.json.ports.length) {
    open('반납 포트 고르기', `<div class="detail"><h2>포트 후보를 찾지 못했어요</h2>` +
      `<p class="inline-note">${A.esc(place.name)} 근처의 반납 포트 정보를 지금은 불러올 수 없어요.</p>` +
      `<a target="_blank" rel="noopener noreferrer" href="${A.esc(region.officialMapUrl)}">공식 지도에서 직접 확인하기 ↗</a>` +
      `<button class="text-button" data-dismiss style="margin-top:10px">닫기</button></div>`);
    return;
  }
  const asOf = r.json.sourceRetrievedAt ? new Date(r.json.sourceRetrievedAt).toLocaleDateString('ko-KR') : '알 수 없음';
  const rows = r.json.ports.map((p) => `<button class="city-option" data-bike-pick-port="${A.esc(p.id)}">` +
    `<span><b>${A.esc(p.title)}</b><small>${A.esc(p.address)} · 목적지까지 직선거리 ${daBikeFmtMeters(p.distanceMeters)} · 수용 ${A.esc(String(p.capacity ?? '?'))}대(실시간 가용 아님)</small></span>` +
    `<span class="city-check">›</span></button>`).join('');
  open('반납 포트 고르기', `<div class="detail"><h2>${A.esc(place.name)} 근처 반납 포트</h2>` +
    `<p class="inline-note">직선거리 기준이에요(실제 이동 순서가 아니에요). 표시된 대수는 포트의 수용 대수일 뿐, 지금 실제로 반납 가능한지는 공식 앱에서 확인해야 해요. 데이터 기준: ${A.esc(asOf)}</p>` +
    `<div class="city-options">${rows}</div>` +
    `<a target="_blank" rel="noopener noreferrer" href="${A.esc(region.officialMapUrl)}">공식 지도에서 보기 ↗</a>` +
    `<button class="text-button" data-dismiss style="margin-top:10px">닫기</button></div>`);
  document.getElementById('sheetContent').querySelectorAll('[data-bike-pick-port]').forEach((b) => {
    b.onclick = () => daBikeRequestGuide(place, region, origin, b.dataset.bikePickPort, r.json.ports.find((p) => p.id === b.dataset.bikePickPort), ctx, false);
  });
}

/* 안내 생성(유료, 이용권 차감) — 선택한 포트 하나에 대해서만 계산한다. */
async function daBikeRequestGuide(place, region, origin, portId, portSummary, ctx, isRecalc) {
  open(isRecalc ? '다시 계산하는 중' : '안내 만드는 중', `<div class="detail"><h2>${isRecalc ? '다른 포트로 다시 계산하고 있어요…' : '안내를 만들고 있어요…'}</h2></div>`);
  const r = await A.api('/api/bike-ports/guide', {
    method: 'POST', token: ctx.token,
    body: { idempotencyKey: daBikeUuid(), providerId: region.providerId, regionCode: region.regionCode, portId, origin, destination: { lat: place.lat, lng: place.lng } },
  });
  if (!r.ok || !r.json || r.json.ok === false) {
    const reason = r.json && r.json.reason;
    const msg = reason === 'payment-required' ? '무료체험을 이미 써서 이용권이 필요해요.'
      : reason === 'entitlement-course-limit-reached' ? '이번 이용권의 생성 가능 횟수를 모두 썼어요.'
      : reason === 'generation-in-progress' ? '다른 요청을 처리 중이에요. 잠시 후 다시 시도해 주세요.'
      : reason === 'rate-limited' ? '요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.'
      : '안내를 만들지 못했어요. 잠시 후 다시 시도해 주세요.';
    open('안내 실패', `<div class="detail"><h2>${A.esc(msg)}</h2><button class="primary" data-dismiss>닫기</button></div>`);
    return;
  }
  ctx.foodMap.bikeGuide = {
    destinationId: place.id, providerId: region.providerId, regionCode: region.regionCode,
    officialMapUrl: region.officialMapUrl, origin, step: 'guide', guide: r.json.guide, updatedAt: new Date().toISOString(),
  };
  ctx.saveFoodMap();
  daBikeRenderGuideScreen(place, ctx, isRecalc);
}

function daBikeRenderGuideScreen(place, ctx, justRecalculated) {
  const state = ctx.foodMap.bikeGuide;
  const guide = state.guide;
  const bikeLine = guide.bikeLeg.real
    ? `자전거로 ${daBikeFmtMinutes(guide.bikeLeg.seconds)}(약 ${daBikeFmtMeters(guide.bikeLeg.distanceMeters)})`
    : `자전거 경로를 확인하지 못했어요 — <a target="_blank" rel="noopener noreferrer" href="${daBikeGoogleMapsBikeDirUrl(state.origin, guide.port)}">외부 지도에서 확인 ↗</a>`;
  const walkLine = `도보로 ${daBikeFmtMinutes(guide.walkLeg.seconds)}(약 ${daBikeFmtMeters(guide.walkLeg.distanceMeters)})${guide.walkLeg.real ? '' : ' · 추정치(실제 경로 확인 안 됨)'}`;

  if (state.step === 'returned') {
    open('목적지까지 도보 안내', `<div class="detail"><h2>${A.esc(place.name)}까지</h2>` +
      `<p class="inline-note">반납한 포트(${A.esc(guide.port.title)})에서부터예요.</p>` +
      `<p>${walkLine}</p>` +
      `<p class="inline-note">공식 앱에서 이용 종료를 확인해 주세요.</p>` +
      `<button class="text-button" data-bike-restart style="padding:6px 0">처음부터 다시 고르기</button>` +
      `<button class="primary" data-dismiss>닫기</button></div>`);
    document.getElementById('sheetContent').querySelector('[data-bike-restart]').onclick = () => { delete ctx.foodMap.bikeGuide; ctx.saveFoodMap(); daOpenBikeGuide(place, ctx); };
    return;
  }

  open('반납 포트 안내', `<div class="detail"><h2>${A.esc(guide.port.title)}</h2>` +
    (justRecalculated ? `<p class="inline-note">다시 계산했어요.</p>` : '') +
    `<p>${A.esc(guide.port.address)}</p>` +
    `<p>${bikeLine}</p>` +
    `<p>도착 후 → ${walkLine}</p>` +
    `<p class="inline-note">대여·잠금 해제·반납 가능 여부는 공식 앱에서 확인해 주세요(여기서는 반납 가능 여부를 실시간으로 알 수 없어요).</p>` +
    `<a target="_blank" rel="noopener noreferrer" href="${A.esc(state.officialMapUrl)}">공식 지도/앱 열기 ↗</a>` +
    `<button class="primary" data-bike-returned style="margin-top:10px">반납했어요</button>` +
    `<button class="text-button" data-bike-other-port style="padding:6px 0">다른 포트로 바꾸기</button>` +
    `<button class="text-button" data-dismiss style="padding:6px 0">닫기(나중에 이어서 보기)</button></div>`);
  const content = document.getElementById('sheetContent');
  content.querySelector('[data-bike-returned]').onclick = () => {
    ctx.foodMap.bikeGuide.step = 'returned';
    ctx.saveFoodMap();
    daBikeRenderGuideScreen(place, ctx, false);
  };
  content.querySelector('[data-bike-other-port]').onclick = () => {
    const region = { providerId: state.providerId, regionCode: state.regionCode, officialMapUrl: state.officialMapUrl };
    daBikeShowCandidates(place, region, state.origin, ctx);
  };
}

/* 공개 진입점 — spots.js의 detail()이 "🚲 자전거로 가기" 버튼에 연결한다.
   ctx = { foodMap, saveFoodMap, token } (spots.js가 그대로 넘겨준다). */
async function daOpenBikeGuide(place, ctx) {
  await daBikePortsLoadStatus();
  const region = daBikePortsRegionForCity(place.city);
  if (!region) { daToast('이 목적지는 아직 지원하지 않아요.'); return; }

  const existing = ctx.foodMap.bikeGuide;
  if (existing && existing.destinationId === place.id && existing.guide) {
    daBikeRenderGuideScreen(place, ctx, false);
    return;
  }

  const origin = ctx.resolveOrigin();
  if (!origin) {
    open('출발지 필요', daBikeNoOriginSheetHTML());
    const content = document.getElementById('sheetContent');
    content.querySelector('[data-bike-origin-gps]').onclick = () => daRequestMyLocation(() => daOpenBikeGuide(place, ctx));
    content.querySelector('[data-bike-origin-manual]').onclick = () => manualLocationSheet(() => daOpenBikeGuide(place, ctx));
    return;
  }

  daBikeShowCandidates(place, region, origin, ctx);
}

window.BikePorts = { loadStatus: daBikePortsLoadStatus, regionForCity: daBikePortsRegionForCity, entryButtonHTML: daBikeEntryButtonHTML, open: daOpenBikeGuide };
