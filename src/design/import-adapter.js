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

/* private/personal.html: const SALE_MODE / const PFX — 그대로 옮김.
   이 화면도 같은 foodmap_v1 저장 데이터를 읽고 써야 하므로 접두어가 같아야 한다. */
const SALE_MODE = false; // TODO: 판매용 화면(design/index.html → src/index.html 대체 시) true 로
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
/* private/personal.html: function fmCityGuess — 2026-09-09 신설, 그대로 옮김.
   증거 없이 도시를 확정하지 않는다 — 텍스트에 도시 이름이 정확히 하나만
   걸리면 그 도시, 여러 개 걸리면 애매하니 확정 안 함. 텍스트로 못 찾았으면
   좌표로 후쿠오카만 교차검증(지금 정확한 범위를 아는 게 후쿠오카뿐이라).
   그래도 없으면 null — 화면은 이걸 "지역 확인 필요"로 보여준다. */
function daCityGuess(p) {
  /* 메모는 안 쓴다 — 실제로 후쿠오카의 한 가게 메모가 다른 도시와 비교하는
     개인 코멘트였고, 메모까지 보면 이걸 엉뚱한 도시로 잘못 확정했다.
     주소만 신뢰할 수 있는 장소 정보로 쓴다. */
  const txt = String(p.address || '').toLowerCase();
  if (txt.trim()) {
    const hit = [];
    for (const city in FM_CITY_ALT) {
      const pat = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (FM_CITY_ALT[city] ? ('|' + FM_CITY_ALT[city]) : '');
      let re; try { re = new RegExp(pat, 'i'); } catch (e) { continue; }
      if (re.test(txt)) hit.push(city);
    }
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) return null;
  }
  if (daHasCoords(p) && p.lat >= 32.7 && p.lat <= 34.15 && p.lng >= 129.2 && p.lng <= 131.25) return '후쿠오카';
  return null;
}

/* private/personal.html: fmMerge — 2026-09-09 개정본 그대로 옮김(카테고리 자동분류
   호출부만 뺐다 — fmInfer 는 다음 단계(로드맵 ③)에서 연결한다). 이름만으로도
   겹치는 걸 잡고(좌표·URL 형식이 달라도), 겹친 곳은 목록 소속을 다 보존한다. */
const daNameKey = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
function daMerge(arr, sourceLabel, places) {
  let added = 0, updated = 0, skipped = 0, merged = 0;
  const byKey = new Map(); const byName = new Map();
  const kName = (p) => (p.name || '').toLowerCase() + '|' + p.lat + '|' + p.lng;
  places.forEach((p) => {
    [p.placeId, p.url, kName(p)].forEach((k) => { if (k) byKey.set(k, p); });
    const nk = daNameKey(p.name); if (nk) byName.set(nk, p);
  });
  arr.forEach((x) => {
    if (!x || !x.name) { skipped++; return; }
    const key = x.placeId || x.url || kName(x);
    const nk = daNameKey(x.name);
    const exact = byKey.get(x.placeId) || byKey.get(x.url) || byKey.get(kName(x));
    const old = exact || (nk && byName.get(nk));
    if (old) {
      if (!exact) merged++;
      ['name', 'note', 'address', 'url', 'placeId', 'rating', 'ratingCount'].forEach((k) => { if (x[k] !== undefined && x[k] !== null && x[k] !== '') old[k] = x[k]; });
      if (x.lat !== null && x.lat !== undefined) old.lat = x.lat;
      if (x.lng !== null && x.lng !== undefined) old.lng = x.lng;
      if (!old.cityConfirmed) old.city = daCityGuess(old);
      if (sourceLabel) { old.sourceLists = Array.isArray(old.sourceLists) ? old.sourceLists : []; if (!old.sourceLists.includes(sourceLabel)) old.sourceLists.push(sourceLabel); }
      byKey.set(key, old); if (nk) byName.set(nk, old);
      updated++; return;
    }
    const p = Object.assign({ id: 'fm' + Date.now() + added + Math.floor(Math.random() * 9999), cat: x.cat || '기타' }, x);
    delete p.title;
    p.city = daCityGuess(p);
    p.sourceLists = sourceLabel ? [sourceLabel] : [];
    places.push(p); byKey.set(key, p); if (nk) byName.set(nk, p); added++;
  });
  return { added, updated, skipped, merged };
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
    url: daLink(p),
    hasCoords: daHasCoords(p),
    lat: p.lat, lng: p.lng,
    sourceLists: Array.isArray(p.sourceLists) ? p.sourceLists : [],
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
  loadFoodMap: () => daLoad('foodmap_v1', { places: [], dest: '', destCountry: '' }),
  saveFoodMap: (fm) => daSave('foodmap_v1', fm),
  parseCsv: daCsv,
  parseJson: daJsonPlaces,
  merge: daMerge,
  buildSpots: daBuildSpots,
  cityGuess: daCityGuess,
  esc: daEsc,
  hasCoords: daHasCoords,
};
