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
function daMerge(arr, sourceLabel, places) {
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
      if (sourceLabel) { exact.sourceLists = Array.isArray(exact.sourceLists) ? exact.sourceLists : []; if (!exact.sourceLists.includes(sourceLabel)) exact.sourceLists.push(sourceLabel); }
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
    if (already) { updated++; return; }
    const p = Object.assign({ id: 'fm' + Date.now() + added + Math.floor(Math.random() * 9999) }, x);
    delete p.title;
    p.originName = x.name; p.originNote = x.note || ''; p.originAddress = x.address || '';
    p.cat = x.cat || daInfer(p.name + ' ' + p.note + ' ' + p.address);
    p.catConfirmed = !!x.cat;
    p.city = daCityGuess(p);
    p.sourceLists = sourceLabel ? [sourceLabel] : [];
    p.importKeys = [importFingerprint];
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
  if (idx >= 0) places.splice(idx, 1);
  return { mergedId: bId, survivorId: aId };
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
  setCat: daSetCat,
  knownCats: FM_INFER.map((x) => x[0]).concat('기타'),
  knownCities: Object.keys(FM_CITY_ALT),
  esc: daEsc,
  hasCoords: daHasCoords,
  needsLookup: daNeedsLookup,
  lookupState: daLookupState,
  migrateStorage: daMigrateStorage,
  destNow: daDestNow,
};
