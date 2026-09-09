'use strict';
/**
 * 기능 통합 어댑터 — 승인 디자인(spots.js)에 실제 데이터를 연결하는 다리.
 *
 * 02_DESIGN_CONTRACT.md: "spots.js: 샘플 데이터와 UI 이벤트. 실데이터 어댑터로 대체"
 * 03_INTEGRATION_AND_ACCEPTANCE.md 1절: "현재 구조가 여전히 같은지 확인 후
 * 생성 파일만 단독 편집하는 실수를 피한다" — 그래서 파싱·저장 로직을
 * private/personal.html 에서 새로 만들지 않고 그대로 옮겼다(아래 각 함수
 * 위에 원본 위치를 적어 뒀다). private/personal.html 이 바뀌면 이 파일도
 * 같이 맞춰야 한다.
 *
 * 실제 178곳(구글 Takeout 원본)으로 이 파일 그대로 검증했다.
 * 자세한 수치는 docs/DESIGN_INTEGRATION_REPORT.md 참고.
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

/* private/personal.html: const esc= — 그대로 옮김.
   승인 spots.js 는 실데이터를 검증 없이 innerHTML 에 꽂았다. 사용자 저장 이름을
   그대로 꽂으면 이론상 삽입 공격 표면이 된다(빈도는 낮지만 계약이 요구하는
   sanitization 항목). 실데이터 렌더링 경로 전부에 이 esc 를 적용한다. */
const daEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* private/personal.html: function fm2Coord — 그대로 옮김 */
function fm2Coord(v, max) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}

/* private/personal.html: function fmCoordFromUrl — 그대로 옮김.
   구글맵 URL 안에 좌표가 박혀 있으면(@lat,lng · !3d!4d · ?q=lat,lng 등) 꺼낸다.
   실제로는 Takeout CSV URL 대부분에 좌표가 없다 — 아래 리포트의 핵심 발견. */
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

/* private/personal.html: function fmCsvRows — 그대로 옮김 (따옴표·줄바꿈·빈 줄 처리) */
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

/* private/personal.html: function fmCsv — 그대로 옮김.
   한글 Takeout 헤더(제목·메모·댓글)와 영문 헤더(Title·Note)를 둘 다 받는다. */
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

/* private/personal.html: fmObj / fmJson (라이브 재정의판) — 그대로 옮김.
   "지도(내 장소)/저장한 장소.json" 같은 GeoJSON FeatureCollection도 읽는다. */
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

/* 06_UPDATES_AND_EXPORT_CORRECTION.md: "리뷰/설정 데이터는 장소 목록과 구분하고
   불필요한 데이터는 수입하지 않는다." 리뷰.json 은 features[].properties 에
   five_star_rating_published / questions 가 있다 — 저장 장소에는 없는 필드다. */
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

/* private/personal.html: function fmLink — 그대로 옮김.
   03_INTEGRATION_AND_ACCEPTANCE.md: "detail: 검증된 매장 … 지도 …" —
   실제로 저장했던 구글맵 링크를 최우선으로 쓴다. 없으면 이름으로 검색 링크. */
function daLink(p) {
  if (p.url) return p.url;
  const q = p.lat && p.lng ? (p.lat + ',' + p.lng) : p.name;
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}

/* private/personal.html: function fmInFukuoka — 2026-09-09 수정본 그대로 옮김.
   (좌표도 주소도 없으면 빼지 않는다 — 실 데이터 178곳 중 165곳이 이 버그로
   사라졌던 것을 고친 바로 그 로직. docs/DESIGN_INTEGRATION_REPORT.md 참고) */
function daInFukuoka(p) {
  const a = String((p.address || '') + ' ' + (p.note || '')).toLowerCase();
  if (/福岡|fukuoka|후쿠오카|糸島|itoshima|이토시마|北九州|kitakyushu/.test(a)) return true;
  if (p.lat === null || p.lat === undefined || p.lng === null || p.lng === undefined) return true;
  return p.lat >= 32.7 && p.lat <= 34.15 && p.lng >= 129.2 && p.lng <= 131.25;
}

/**
 * foodMap 을 읽어 승인 디자인이 기대하는 spots/cities 모양으로 바꾼다.
 *
 * ⚠️ 알려진 단순화 — 지금 앱은 "여행 하나만 활성"인 구조다(나라를 바꾸면
 * tripReset() 이 이전 여행을 지운다, HANDOFF.md 35절 이전부터 그랬다).
 * 승인 디자인은 후쿠오카·삿포로·뉴욕을 한 화면에서 동시에 넘나드는 걸
 * 전제로 한다(03_INTEGRATION_AND_ACCEPTANCE.md "후쿠오카에서 선택한 장소가
 * 뉴욕 동선에 섞이지 않음"). 지금은 실제로 여러 여행을 동시에 저장하는
 * 기능이 없으므로, 지금 활성 여행(foodMap.dest) 하나만 city 로 놓는다.
 * 여러 여행을 실제로 병행 저장하려면 데이터 구조를 바꿔야 하고, 그건
 * 기존 저장 데이터에 영향을 주는 결정이라 여기서 임의로 하지 않는다.
 * → docs/DESIGN_INTEGRATION_REPORT.md "결정이 필요한 것" 참고.
 */
function daBuildSpots(foodMap) {
  const dest = foodMap.dest || '내 여행지';
  const places = Array.isArray(foodMap.places) ? foodMap.places : [];
  const visible = places.filter((p) => (foodMap.destCountry === 'JP' && /후쿠오카|하카타|fukuoka/i.test(dest)) ? daInFukuoka(p) : true);
  const spots = visible.map((p) => ({
    id: p.id,
    name: p.name || '이름 없음',
    category: p.cat || '기타',
    area: p.address || p.note || '',
    memo: p.note || '',
    image: null, // 실 사진 미연결 — 카드가 이 값을 보고 빈 상태를 그린다
    city: dest,
    url: daLink(p),
    hasCoords: daHasCoords(p),
    lat: p.lat, lng: p.lng,
  }));
  const cities = [{ name: dest, label: dest, country: foodMap.destCountry || '', count: spots.length }];
  return { spots, cities };
}

window.DesignAdapter = {
  loadFoodMap: () => daLoad('foodmap_v1', { places: [], dest: '', destCountry: '' }),
  saveFoodMap: (fm) => daSave('foodmap_v1', fm),
  parseCsv: daCsv,
  parseJson: daJsonPlaces,
  buildSpots: daBuildSpots,
  esc: daEsc,
  hasCoords: daHasCoords,
};
