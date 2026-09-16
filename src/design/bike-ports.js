'use strict';
/**
 * 자전거 공유 반납 포트 안내(차리차리 등) — 2026-09-15 신규,
 * 2026-09-16 ChatGPT 재검토 반영.
 *
 * 00_READ_FIRST_CLAUDE.md 1절 — "챠리챠리 앱을 복제하지 않고, 사용자가
 * 저장한 목적지에 도착하는 앞뒤의 번거로움을 줄인다." 대여·잠금 해제·
 * 실시간 반납 상태·이용 종료 확인은 전부 공식 앱/웹지도에서 한다 — 이
 * 화면은 (a) 목적지 근처 반납 포트 후보, (b) 그 포트까지/거기서
 * 목적지까지의 안내(+실제 길찾기 링크), (c) "반납했어요"를 사용자가
 * 직접 누르는 수동 전환만 다룬다.
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
 *
 * ctx = { foodMap, saveFoodMap, resolveOrigin, token, epoch } — epoch는
 * spots.js의 sessionEpoch를 읽는 함수다(2026-09-16 신규). 로그인/
 * 로그아웃/계정 전환이 일어나면 spots.js가 sessionEpoch를 올리므로,
 * 요청을 보내기 전 값과 응답이 돌아온 뒤의 값이 다르면 — 그 사이 계정이
 * 바뀐 것이므로 — 응답을 조용히 버린다(다른 계정 화면·저장소에
 * 새어나가지 않게).
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

/* 2026-09-16 신규 — 계정과 권한(test_access) 변경 시 캐시를 반드시
   비운다. 안 비우면 승인된 계정으로 실제 데이터를 확인한 뒤 같은 탭에서
   로그아웃하고 다른(승인 안 된) 계정으로 들어와도, 서버에 다시 묻지
   않고 예전 응답이 그대로 재사용될 수 있다(5절 — "상태 캐시는 계정과
   권한 변경 시 초기화"). spots.js의 daLogout()이 호출한다. */
function daBikePortsResetStatusCache() { _bikeStatusCache = null; }

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

/* 2026-09-16 재검토 1절 — "각 링크에 정확한 출발·도착 좌표와 이동수단을
   넣으세요." travelmode를 인자로 받는 일반화된 함수 하나로 자전거·도보
   링크를 둘 다 만든다(예전엔 자전거 전용 함수 하나뿐이었다 — 도보
   구간엔 링크 자체가 없었다). API 키가 필요 없는 표준 구글맵 길찾기
   웹 링크라 안전하다(비공식 앱 스킴 아님). */
function daBikeGoogleMapsDirUrl(origin, dest, mode) {
  return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&travelmode=${mode}`;
}

function daBikeUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'bike-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

/* 2026-09-16 재검토 4절 — 두 요청이 "같은 작업"인지 판단하는 기준.
   포트·출발지·목적지 중 하나라도 실제로 바뀌면 새 작업이다(새
   idempotencyKey를 써야 한다는 뜻). 좌표는 숫자 그대로 비교한다 —
   이 필드들은 사용자 입력이나 서버 응답에서 그대로 전달돼 재계산으로
   달라지지 않는다. */
function daBikeSameSignature(a, b) {
  if (!a || !b) return false;
  return a.providerId === b.providerId && a.regionCode === b.regionCode && a.portId === b.portId &&
    a.origin.lat === b.origin.lat && a.origin.lng === b.origin.lng &&
    a.destination.lat === b.destination.lat && a.destination.lng === b.destination.lng;
}

/* 후보 목록 화면 — 목적지 주변 포트(직선거리순, 무료 조회). isRecalc면
   "다른 포트로 바꾸기"로 들어온 것이다 — 2026-09-16 재검토 2절: "다른
   포트로 변경할 때 추가 생성 1회가 사용될 수 있음을 실행 전에 명확히
   안내." */
async function daBikeShowCandidates(place, region, origin, ctx, isRecalc) {
  open('반납 포트 고르기', `<div class="detail"><h2>불러오는 중…</h2></div>`);
  const r = await A.api(`/api/bike-ports/nearby?providerId=${encodeURIComponent(region.providerId)}&regionCode=${encodeURIComponent(region.regionCode)}&lat=${place.lat}&lng=${place.lng}&limit=3`, { token: ctx.token });
  if (!r.ok || !r.json || r.json.ok === false || !r.json.ports.length) {
    // 5절 — 일반 계정은 서버가 항상 빈 목록을 준다(실 데이터는 승인된
    // 테스트 계정에만 보인다). 그 경우도 포함해 여기서 공식 웹지도
    // 링크로만 안내한다 — 새 화면을 따로 만들 필요가 없다.
    open('반납 포트 고르기', `<div class="detail"><h2>포트 후보를 찾지 못했어요</h2>` +
      `<p class="inline-note">${A.esc(place.name)} 근처의 반납 포트 정보를 지금은 불러올 수 없어요.</p>` +
      `<a target="_blank" rel="noopener noreferrer" href="${A.esc(region.officialMapUrl)}">공식 웹지도에서 직접 확인하기 ↗</a>` +
      `<button class="text-button" data-dismiss style="margin-top:10px">닫기</button></div>`);
    return;
  }
  const asOf = r.json.sourceRetrievedAt ? new Date(r.json.sourceRetrievedAt).toLocaleDateString('ko-KR') : '알 수 없음';
  const recalcNote = isRecalc
    ? `<p class="inline-note">⚠️ 다른 포트를 고르면 이번 이용권의 코스 생성 횟수가 추가로 사용될 수 있어요.</p>`
    : '';
  const rows = r.json.ports.map((p) => `<button class="city-option" data-bike-pick-port="${A.esc(p.id)}">` +
    `<span><b>${A.esc(p.title)}</b><small>${A.esc(p.address)} · 목적지까지 직선거리 ${daBikeFmtMeters(p.distanceMeters)} · 수용 ${A.esc(String(p.capacity ?? '?'))}대(실시간 가용 아님)</small></span>` +
    `<span class="city-check">›</span></button>`).join('');
  open('반납 포트 고르기', `<div class="detail"><h2>${A.esc(place.name)} 근처 반납 포트</h2>` +
    `<p class="inline-note">직선거리 기준이에요(실제 이동 순서가 아니에요). 표시된 대수는 포트의 수용 대수일 뿐, 지금 실제로 반납 가능한지는 공식 앱에서 확인해야 해요. 데이터 기준: ${A.esc(asOf)}</p>` +
    recalcNote +
    `<div class="city-options">${rows}</div>` +
    `<a target="_blank" rel="noopener noreferrer" href="${A.esc(region.officialMapUrl)}">공식 웹지도에서 보기 ↗</a>` +
    `<button class="text-button" data-dismiss style="margin-top:10px">닫기</button></div>`);
  document.getElementById('sheetContent').querySelectorAll('[data-bike-pick-port]').forEach((b) => {
    b.onclick = () => daBikeRequestGuide(place, region, origin, b.dataset.bikePickPort, r.json.ports.find((p) => p.id === b.dataset.bikePickPort), ctx);
  });
}

/* 안내 생성(유료, 이용권 차감) — 선택한 포트 하나에 대해서만 계산한다.
   2026-09-16 재검토 4절 — "동일 작업의 응답 유실·재시도에는 같은 요청
   키와 본문을 재사용, 실제로 바뀐 경우에만 새 작업으로 구분." 요청을
   보내기 전에 서명(providerId/regionCode/portId/origin/destination)과
   idempotencyKey를 ctx.foodMap.bikeGuide.pendingRequest에 먼저
   저장해 둔다 — 그래야 응답이 오기 전에 네트워크가 끊기거나 페이지가
   새로고침돼도, 다음 시도가 같은 키를 재사용해 서버가 재생(replay)만
   하고 다시 차감하지 않는다. */
async function daBikeRequestGuide(place, region, origin, portId, portSummary, ctx) {
  const destination = { lat: place.lat, lng: place.lng };
  const signature = { providerId: region.providerId, regionCode: region.regionCode, portId, origin, destination };
  const existing = ctx.foodMap.bikeGuide;
  const reuseKey = (existing && existing.destinationId === place.id && daBikeSameSignature(existing.pendingSignature, signature))
    ? existing.pendingKey : null;
  const idempotencyKey = reuseKey || daBikeUuid();
  const isRecalc = !!(existing && existing.destinationId === place.id && existing.guide);

  // 요청 직전에 먼저 저장한다 — 이 저장 자체가 실패해도(드묾) 지금
  // 시도의 idempotencyKey 변수는 이 함수 안에서는 그대로 유효하다.
  ctx.foodMap.bikeGuide = {
    ...(existing && existing.destinationId === place.id ? existing : {}),
    destinationId: place.id, destinationCoord: destination,
    providerId: region.providerId, regionCode: region.regionCode, officialMapUrl: region.officialMapUrl,
    origin, portId,
    pendingKey: idempotencyKey, pendingSignature: signature,
    step: 'requesting',
    updatedAt: new Date().toISOString(),
  };
  ctx.saveFoodMap();

  const epochAtStart = ctx.epoch ? ctx.epoch() : null;
  open(isRecalc ? '다시 계산하는 중' : '안내 만드는 중', `<div class="detail"><h2>${isRecalc ? '다른 포트로 다시 계산하고 있어요…' : '안내를 만들고 있어요…'}</h2></div>`);
  const r = await A.api('/api/bike-ports/guide', {
    method: 'POST', token: ctx.token,
    body: { idempotencyKey, ...signature },
  });

  // 2026-09-16 재검토 4절 — "요청 중 로그아웃·계정 전환 후 늦게 도착한
  // 응답이 다른 계정 화면이나 저장소에 반영되지 않게 보호." spots.js가
  // 로그아웃/재로그인 때마다 sessionEpoch를 올린다 — 요청을 보낸 시점과
  // 값이 다르면 그 사이 계정이 바뀐 것이므로 응답을 조용히 버린다.
  if (ctx.epoch && ctx.epoch() !== epochAtStart) return;

  if (!r.ok || !r.json || r.json.ok === false) {
    const reason = r.json && r.json.reason;
    const officialMapUrl = (r.json && r.json.officialMapUrl) || region.officialMapUrl;
    const msg = reason === 'payment-required' ? '무료체험을 이미 써서 이용권이 필요해요.'
      : reason === 'entitlement-course-limit-reached' ? '이번 이용권의 생성 가능 횟수를 모두 썼어요.'
      : reason === 'generation-in-progress' ? '다른 요청을 처리 중이에요. 잠시 후 다시 시도해 주세요.'
      : reason === 'rate-limited' ? '요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.'
      : reason === 'real-data-access-required' ? '지금은 이 목적지의 반납 포트 안내를 제공하지 않아요.'
      : '안내를 만들지 못했어요. 잠시 후 다시 시도해 주세요.';
    open('안내 실패', `<div class="detail"><h2>${A.esc(msg)}</h2>` +
      (officialMapUrl ? `<a target="_blank" rel="noopener noreferrer" href="${A.esc(officialMapUrl)}">공식 웹지도에서 확인하기 ↗</a>` : '') +
      `<button class="primary" data-dismiss style="margin-top:10px">닫기</button></div>`);
    return;
  }

  ctx.foodMap.bikeGuide = {
    destinationId: place.id, destinationCoord: destination,
    providerId: region.providerId, regionCode: region.regionCode, officialMapUrl: region.officialMapUrl,
    origin, portId, pendingKey: null, pendingSignature: null,
    step: 'guide', guide: r.json.guide, updatedAt: new Date().toISOString(),
  };
  // 2026-09-16 재검토 4절 — "saveFoodMap 반환값을 검사하고 저장 실패를
  // 성공처럼 표시하지 않기 / 저장 실패 시에도 이미 생성한 결과를 다시
  // 과금하지 않고 복구할 수 있게 하기." 저장이 실패해도 성공을 감추지
  // 않되(정직하게 알림), 방금 만든 결과는 메모리에 이미 있으므로 지금
  // 화면에는 그대로 보여준다 — 다음에 이 destinationId를 다시 열었을
  // 때 로컬에 남아 있지 않으면, pendingKey도 함께 사라졌으므로 재시도는
  // 새 작업이 되지만 그 재시도는 idempotencyKey가 달라도 서버 쪽에서
  // 이미 이 계정의 이번 이용권 성공이 처리돼 있어 다시 결제를 요구하지
  // 않는다(무료체험은 소진, 유료는 이번 성공이 이미 카운트됨).
  const saved = ctx.saveFoodMap();
  if (!saved) daToast('안내를 만들었지만 이 기기에 저장하지 못했어요. 화면을 벗어나면 다시 찾아야 할 수 있어요.');
  daBikeRenderGuideScreen(place, ctx, isRecalc);
}

function daBikeRenderGuideScreen(place, ctx, justRecalculated) {
  const state = ctx.foodMap.bikeGuide;
  const guide = state.guide;
  const bikeLine = guide.bikeLeg.real
    ? `자전거로 ${daBikeFmtMinutes(guide.bikeLeg.seconds)}(약 ${daBikeFmtMeters(guide.bikeLeg.distanceMeters)})`
    : `자전거 경로를 확인하지 못했어요 — 아래 링크로 직접 확인해 주세요.`;
  const walkLine = `도보로 ${daBikeFmtMinutes(guide.walkLeg.seconds)}(약 ${daBikeFmtMeters(guide.walkLeg.distanceMeters)})${guide.walkLeg.real ? '' : ' · 추정치(실제 경로 확인 안 됨)'}`;
  // 2026-09-16 재검토 1절 — 자전거·도보 각 구간에 실제 출발·도착
  // 좌표와 이동수단을 담은 길찾기 버튼을 항상 준다(우리 자체 경로
  // 계산이 실패해도 링크 자체는 항상 만들 수 있다 — 숫자를 지어내는
  // 것과 다르다).
  const bikeDirUrl = daBikeGoogleMapsDirUrl(state.origin, guide.port, 'bicycling');
  const walkDirUrl = daBikeGoogleMapsDirUrl(guide.port, state.destinationCoord, 'walking');

  if (state.step === 'returned') {
    open('목적지까지 도보 안내', `<div class="detail"><h2>${A.esc(place.name)}까지</h2>` +
      `<p class="inline-note">반납한 포트(${A.esc(guide.port.title)})에서부터예요.</p>` +
      `<p>${walkLine}</p>` +
      `<a target="_blank" rel="noopener noreferrer" href="${A.esc(walkDirUrl)}">도보 길찾기 보기 ↗</a>` +
      `<p class="inline-note">실시간 반납 가능 여부와 실제 이용 종료는 공식 앱에서 확인해 주세요.</p>` +
      `<button class="text-button" data-bike-restart style="padding:6px 0">처음부터 다시 고르기</button>` +
      `<button class="primary" data-dismiss>닫기</button></div>`);
    document.getElementById('sheetContent').querySelector('[data-bike-restart]').onclick = () => { delete ctx.foodMap.bikeGuide; ctx.saveFoodMap(); daOpenBikeGuide(place, ctx); };
    return;
  }

  open('반납 포트 안내', `<div class="detail"><h2>${A.esc(guide.port.title)}</h2>` +
    (justRecalculated ? `<p class="inline-note">다시 계산했어요.</p>` : '') +
    `<p>${A.esc(guide.port.address)}</p>` +
    `<p>${bikeLine}</p>` +
    `<a target="_blank" rel="noopener noreferrer" href="${A.esc(bikeDirUrl)}">자전거 길찾기 보기 ↗</a>` +
    `<p style="margin-top:10px">도착 후 → ${walkLine}</p>` +
    `<a target="_blank" rel="noopener noreferrer" href="${A.esc(walkDirUrl)}">도보 길찾기 보기 ↗</a>` +
    `<p class="inline-note" style="margin-top:10px">대여·잠금 해제·반납 가능 여부·실제 이용 종료는 공식 앱에서 확인해 주세요(여기서는 반납 가능 여부를 실시간으로 알 수 없어요).</p>` +
    `<a target="_blank" rel="noopener noreferrer" href="${A.esc(state.officialMapUrl)}">공식 웹지도에서 보기 ↗</a>` +
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
    daBikeShowCandidates(place, region, state.origin, ctx, true);
  };
}

/* 공개 진입점 — spots.js의 detail()이 "🚲 자전거로 가기" 버튼에 연결한다.
   ctx = { foodMap, saveFoodMap, resolveOrigin, token, epoch }(spots.js가
   그대로 넘겨준다). */
async function daOpenBikeGuide(place, ctx) {
  await daBikePortsLoadStatus(ctx.token);
  const region = daBikePortsRegionForCity(place.city);
  if (!region) { daToast('이 목적지는 아직 지원하지 않아요.'); return; }

  const existing = ctx.foodMap.bikeGuide;
  // 2026-09-16 재검토 4절 — "저장한 안내에 목적지 좌표도 보존하고
  // 좌표가 바뀌면 기존 안내를 그대로 재사용하지 않기." 같은 place.id로
  // 저장돼 있어도, 그 사이 이 장소의 좌표가 다시 확정(위치 재확인 등)돼
  // 바뀌었다면 예전 안내는 더 이상 맞지 않는다 — 새로 고른다.
  const coordUnchanged = existing && existing.destinationCoord &&
    existing.destinationCoord.lat === place.lat && existing.destinationCoord.lng === place.lng;
  if (existing && existing.destinationId === place.id && existing.guide && coordUnchanged) {
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

  daBikeShowCandidates(place, region, origin, ctx, false);
}

window.BikePorts = {
  loadStatus: daBikePortsLoadStatus,
  resetStatusCache: daBikePortsResetStatusCache,
  regionForCity: daBikePortsRegionForCity,
  entryButtonHTML: daBikeEntryButtonHTML,
  open: daOpenBikeGuide,
};
