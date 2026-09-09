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
/* private/personal.html: function fmGpsDistance — 그대로 옮김(미터 단위). */
function daGpsDistance(a, b) {
  if (!a || !b) return 0;
  const r = Math.PI / 180, a1 = a.lat * r, a2 = b.lat * r, da = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
  const z = Math.sin(da / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(z), Math.sqrt(1 - z));
}
/* private/personal.html: function fmPlacesConflict — 그대로 옮김. */
function daPlacesConflict(a, x) {
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
function daMerge(arr, sourceLabel, places) {
  let added = 0, updated = 0, skipped = 0, dupCandidates = 0;
  const byKey = new Map(); const byName = new Map();
  /* 좌표가 진짜 있을 때만 이름+좌표를 검증된 식별자로 쓴다.
     null|null 은 "좌표가 없다"는 뜻이지 "같은 좌표"가 아니다 — 이걸
     구분 안 해서 좌표 없는 동명 장소가 자동으로 합쳐지고 있었다. */
  const kName = (p) => daHasCoords(p) ? ((p.name || '').toLowerCase() + '|' + p.lat + '|' + p.lng) : null;
  const addName = (nk, p) => { if (!nk) return; if (!byName.has(nk)) byName.set(nk, []); byName.get(nk).push(p); };
  places.forEach((p) => {
    [p.placeId, p.url, kName(p)].forEach((k) => { if (k) byKey.set(k, p); });
    addName(daNameKey(p.name), p);
  });
  arr.forEach((x) => {
    if (!x || !x.name) { skipped++; return; }
    const nk = daNameKey(x.name);
    const kx = kName(x);
    const exact = (x.placeId && byKey.get(x.placeId)) || (x.url && byKey.get(x.url)) || (kx && byKey.get(kx));
    if (exact) {
      if (x.name && exact.name === (exact.originName !== undefined ? exact.originName : exact.name)) exact.name = x.name;
      exact.originName = x.name !== undefined ? x.name : exact.originName;
      if (exact.note === (exact.originNote !== undefined ? exact.originNote : exact.note)) exact.note = x.note || '';
      exact.originNote = x.note !== undefined ? x.note : exact.originNote;
      if (exact.address === (exact.originAddress !== undefined ? exact.originAddress : exact.address)) exact.address = x.address || exact.address;
      exact.originAddress = x.address !== undefined ? x.address : exact.originAddress;
      if (x.placeId) exact.placeId = x.placeId;
      if (x.url) exact.url = x.url;
      if (x.lat !== null && x.lat !== undefined) exact.lat = x.lat;
      if (x.lng !== null && x.lng !== undefined) exact.lng = x.lng;
      if (!exact.cityConfirmed) exact.city = daCityGuess(exact);
      if (sourceLabel) { exact.sourceLists = Array.isArray(exact.sourceLists) ? exact.sourceLists : []; if (!exact.sourceLists.includes(sourceLabel)) exact.sourceLists.push(sourceLabel); }
      [exact.placeId, exact.url, kName(exact)].forEach((k) => { if (k) byKey.set(k, exact); });
      updated++; return;
    }
    const p = Object.assign({ id: 'fm' + Date.now() + added + Math.floor(Math.random() * 9999), cat: x.cat || '기타' }, x);
    delete p.title;
    p.originName = x.name; p.originNote = x.note || ''; p.originAddress = x.address || '';
    p.city = daCityGuess(p);
    p.sourceLists = sourceLabel ? [sourceLabel] : [];
    const sameName = (byName.get(nk) || []).filter((o) => !daPlacesConflict(o, p));
    if (sameName.length) {
      p.dupCandidateIds = sameName.map((o) => o.id);
      sameName.forEach((o) => { o.dupCandidateIds = Array.isArray(o.dupCandidateIds) ? o.dupCandidateIds : []; if (!o.dupCandidateIds.includes(p.id)) o.dupCandidateIds.push(p.id); });
      dupCandidates++;
    }
    places.push(p);
    [p.placeId, p.url, kName(p)].forEach((k) => { if (k) byKey.set(k, p); });
    addName(nk, p);
    added++;
  });
  return { added, updated, skipped, dupCandidates };
}
/* 여러 장소를 한 번에, 또는 하나씩 도시로 확정한다(로드맵 ④에서 요구한
   "여러 장소 선택 → 여행지 일괄 지정과 개별 수정"). 좌표를 만들어내지
   않는다 — 도시 지정과 실제 좌표 확인은 다른 것이다. 동선 계산은
   여전히 hasCoords 가 true 인 곳에만 쓸 수 있다. */
function daAssignCity(places, placeIds, city) {
  const set = new Set(placeIds);
  let n = 0;
  (places || []).forEach((p) => { if (set.has(p.id)) { p.city = city; p.cityConfirmed = true; n++; } });
  return n;
}
/* 중복 후보 하나를 해결한다. 'dismiss' 는 그냥 후보 연결만 끊는다(둘 다
   남는다 — 실제로 다른 곳이라는 뜻). 'merge' 는 진짜 합친다 — 이건 사람이
   "같은 곳 맞다"고 확인한 뒤에만 불려야 한다(자동 병합이 아니다). */
function daResolveDup(places, aId, bId, action) {
  const a = (places || []).find((p) => p.id === aId);
  const b = (places || []).find((p) => p.id === bId);
  if (!a || !b) return false;
  if (action === 'dismiss') {
    a.dupCandidateIds = (a.dupCandidateIds || []).filter((id) => id !== bId);
    b.dupCandidateIds = (b.dupCandidateIds || []).filter((id) => id !== aId);
    return true;
  }
  if (!a.address && b.address) a.address = b.address;
  if (!a.note && b.note) a.note = b.note;
  if (!daHasCoords(a) && daHasCoords(b)) { a.lat = b.lat; a.lng = b.lng; }
  if (!a.url && b.url) a.url = b.url;
  if (!a.placeId && b.placeId) a.placeId = b.placeId;
  if (!a.city && b.city) { a.city = b.city; a.cityConfirmed = b.cityConfirmed; }
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
  if (idx >= 0) places.splice(idx, 1);
  return true;
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
    area: p.address || '',
    memo: p.note || '',
    image: null, // 실 사진 미연결 — 카드가 이 값을 보고 빈 상태를 그린다
    city: p.city || UNKNOWN_CITY,
    cityKnown: !!p.city,
    cityConfirmed: !!p.cityConfirmed,
    cityHint: p.city ? null : daCityHint(p), // 확정 아님 — 제안용
    url: daLink(p),
    hasCoords: daHasCoords(p),
    lat: p.lat, lng: p.lng,
    sourceLists: Array.isArray(p.sourceLists) ? p.sourceLists : [],
    dupCandidateIds: Array.isArray(p.dupCandidateIds) ? p.dupCandidateIds : [],
  }));
  const byCity = new Map();
  spots.forEach((s) => { byCity.set(s.city, (byCity.get(s.city) || 0) + 1); });
  const cities = [...byCity.keys()]
    .sort((a, b) => (a === UNKNOWN_CITY) - (b === UNKNOWN_CITY) || byCity.get(b) - byCity.get(a))
    .map((name) => ({ name, label: name === UNKNOWN_CITY ? UNKNOWN_CITY : name, country: '', count: byCity.get(name) }));
  return { spots, cities };
}

window.DesignAdapter = {
  UNKNOWN_CITY,
  SALE_MODE,
  loadFoodMap: () => daLoad('foodmap_v1', { places: [], dest: '', destCountry: '' }),
  saveFoodMap: (fm) => daSave('foodmap_v1', fm),
  parseCsv: daCsv,
  parseJson: daJsonPlaces,
  merge: daMerge,
  buildSpots: daBuildSpots,
  cityGuess: daCityGuess,
  cityHint: daCityHint,
  assignCity: daAssignCity,
  resolveDup: daResolveDup,
  knownCities: Object.keys(FM_CITY_ALT),
  esc: daEsc,
  hasCoords: daHasCoords,
};
