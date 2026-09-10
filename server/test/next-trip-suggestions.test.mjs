'use strict';
/**
 * 2026-09-10 재검토(5차) 5-③ — 다음 여행 코스 후보 제안(미방문 우선,
 * 다시가고싶음 포함, 과거 여행 미방문 이월, 사용자 명시적 선택 항상
 * 존중)의 검증. trips-and-visits.test.mjs와 분리해 이 절만 다룬다.
 *
 * 실행: node server/test/next-trip-suggestions.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';

const { createServer } = await import('../index.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}
function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}
function directSession(accountId) {
  const db = openDb();
  const token = Buffer.from(String(Math.random())).toString('hex') + accountId;
  db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, accountId, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
  return token;
}

// ============================================================
// 1. 미방문 우선(preferUnvisited) — 배제가 아니라 정렬. 방문한 곳도
//    목록에 남지만 미방문이 앞에 온다.
// ============================================================
{
  const acc = directAccount('sort-unvisited-first@example.com');
  const token = directSession(acc);
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'visited1', name: '방문한곳' }, { id: 'unvisited1', name: '안가본곳' }] } });
  await api('POST', '/api/visits/visited1/mark', { token, body: { date: '2025-01-01' } });

  const suggested = await api('GET', '/api/trips/next-suggestions', { token });
  t('기본(미방문 우선)에서는 방문한 곳도 목록에 그대로 남아 있음(배제 아님)', suggested.json.suggestions.some((s) => s.placeId === 'visited1'));
  const idxUnvisited = suggested.json.suggestions.findIndex((s) => s.placeId === 'unvisited1');
  const idxVisited = suggested.json.suggestions.findIndex((s) => s.placeId === 'visited1');
  t('미방문 장소가 방문한 장소보다 앞에 옴', idxUnvisited < idxVisited);

  // "원래 순서를 유지"란 특정 고정 순서가 아니라 "방문 여부로 재배열
  // 되지 않는다"는 뜻이다 — 보관함 조회(/api/places)가 돌려주는 자연
  // 순서와 그대로 같아야 한다(SQLite는 별도 ORDER BY 없이는 기본키
  // 순서로 반환하므로 삽입 순서와 다를 수 있다 — 그 자체를 검증하지
  // 않고, "정렬 옵션을 끄면 재배열이 없다"만 검증한다).
  const rawPlaces = await api('GET', '/api/places', { token });
  const naturalOrder = rawPlaces.json.places.map((p) => p.id);
  const withoutPrefer = await api('GET', '/api/trips/next-suggestions?preferUnvisited=0', { token });
  const withoutPreferOrder = withoutPrefer.json.suggestions.map((s) => s.placeId);
  t('미방문 우선을 끄면 방문 여부로 재배열하지 않고 보관함의 자연 순서를 그대로 유지함', JSON.stringify(withoutPreferOrder) === JSON.stringify(naturalOrder));
}

// ============================================================
// 2. 다시 가고 싶음 포함 — 이미 방문했지만 want_revisit인 곳도 포함됨.
// ============================================================
{
  const acc = directAccount('include-want-revisit@example.com');
  const token = directSession(acc);
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'lovedplace', name: '또 가고 싶은 곳' }] } });
  await api('POST', '/api/visits/lovedplace/mark', { token, body: { date: '2025-01-01' } });
  await api('POST', '/api/visits/lovedplace/want-revisit', { token, body: { wantRevisit: true } });

  const suggested = await api('GET', '/api/trips/next-suggestions', { token });
  const found = suggested.json.suggestions.find((s) => s.placeId === 'lovedplace');
  t('다시 가고 싶음으로 표시한 곳은 이미 방문했어도 후보에 포함됨', !!found && found.wantRevisit === true && found.visited === true);
}

// ============================================================
// 3. 과거 여행에서 미방문 장소만 이월(fromTripId) — 방문한 곳은
//    이월 후보에서 빠지고, 미방문 장소만 남는다.
// ============================================================
{
  const acc = directAccount('carry-forward-unvisited@example.com');
  const token = directSession(acc);
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'wentThere', name: '갔던곳' }, { id: 'neverWent', name: '못간곳' }, { id: 'alsoNeverWent', name: '역시못간곳' }] } });
  const trip = await api('POST', '/api/trips', { token, body: { city: '베이징' } });
  const tripId = trip.json.trip.tripId;
  await api('PUT', `/api/trips/${tripId}/courses`, {
    token,
    body: { courses: [{ date: '2025-04-01', stops: ['wentThere', 'neverWent', 'alsoNeverWent'] }] },
  });
  await api('POST', '/api/visits/wentThere/mark', { token, body: { date: '2025-04-01', tripId } });

  const carried = await api('GET', `/api/trips/next-suggestions?fromTripId=${tripId}`, { token });
  const ids = carried.json.suggestions.map((s) => s.placeId).sort();
  t('과거 여행에서 실제로 방문한 곳은 이월 후보에서 빠짐', !ids.includes('wentThere'));
  t('과거 여행에서 방문하지 못한 곳들은 이월 후보로 그대로 남음', ids.includes('neverWent') && ids.includes('alsoNeverWent'));
  t('이월 응답에 어느 여행에서 가져왔는지 표시됨', carried.json.carriedFromTripId === tripId);
}

// ============================================================
// 4. 사용자 명시적 선택은 방문 상태와 무관하게 항상 반영됨 — 제안
//    목록 단계(mustIncludeIds)와, 실제 코스 생성 단계(course-generation
//    은 방문 상태를 아예 보지 않는다) 둘 다 확인.
// ============================================================
{
  const acc = directAccount('explicit-selection-wins@example.com');
  const token = directSession(acc);
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'forcedVisited', name: '강제 포함', lat: 33.6, lng: 130.4 }] } });
  await api('POST', '/api/visits/forcedVisited/mark', { token, body: { date: '2025-01-01' } });

  const trip = await api('POST', '/api/trips', { token, body: { city: '방콕' } });
  const tripId = trip.json.trip.tripId;
  // 이 여행 코스에는 담은 적이 없어(빈 코스) 이월 후보 풀 자체에는 안
  // 잡히지만, mustIncludeIds로 명시하면 방문 상태와 무관하게 포함돼야 한다.
  const suggested = await api('GET', `/api/trips/next-suggestions?fromTripId=${tripId}&mustInclude=forcedVisited`, { token });
  const found = suggested.json.suggestions.find((s) => s.placeId === 'forcedVisited');
  t('사용자가 명시적으로 고른 곳은 이미 방문했고 이월 풀에 없어도 후보에 강제 포함됨', !!found && found.mustInclude === true);

  // 실제 코스 생성 — 이미 방문한 장소를 명시적으로 다시 담아도 서버가
  // 방문 상태를 이유로 걸러내거나 거부하지 않는다.
  const origin = { lat: 33.59, lng: 130.40 };
  const gen = await api('POST', '/api/course/generate', {
    token,
    body: { idempotencyKey: 'k-explicit-1', city: '방콕', date: '2025-01-02', tripId, origin, places: [{ id: 'forcedVisited', name: '강제 포함', lat: 33.6, lng: 130.4 }] },
  });
  t('이미 방문한 장소를 명시적으로 코스에 담아도 정상 생성됨(방문 상태로 거부 안 함)', gen.status === 200 && gen.json.course.stops.some((s) => s.id === 'forcedVisited'));
}

// ============================================================
// 5. 제안 API 자체는 유료 API 호출을 전혀 안 일으킴.
// ============================================================
{
  const acc = directAccount('suggestions-are-free@example.com');
  const token = directSession(acc);
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'p1', name: 'X' }] } });
  const before = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
  await api('GET', '/api/trips/next-suggestions', { token });
  await api('GET', '/api/trips/next-suggestions?preferUnvisited=0&includeWantRevisit=0', { token });
  const after = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
  t('다음 여행 후보 제안을 여러 번 호출해도 비용 원장에는 아무 것도 안 남음', after === before);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
