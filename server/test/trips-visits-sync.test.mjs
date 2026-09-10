'use strict';
/**
 * 2026-09-10 재검토(5차) 6절 — "재방문 기록을 보호하는 동기화"의 지정된
 * 검증 시나리오 5건을 그대로 재현한다:
 * 1. 기기 A가 방문 기록을 추가한 뒤 오래된 기기 B가 저장
 * 2. 서로 다른 여행이 두 기기에 추가됨
 * 3. 같은 장소가 두 기기에서 서로 다른 방문 날짜를 가짐
 * 4. 삭제(방문 취소) 후 오래된 기기가 재연결
 * 5. 로그아웃/계정 전환 시 다른 계정의 데이터가 새지 않음
 *
 * 실행: node server/test/trips-visits-sync.test.mjs
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
// 1. 기기 A가 방문 기록을 추가한 뒤(실시간 API로 서버 버전이 올라감),
//    아직 그 사실을 모르는(버전이 뒤처진) 기기 B가 자기 로컬 상태를
//    그대로 동기화 업로드 — B의 오래된 값이 A의 새 기록을 지우면 안 됨.
// ============================================================
{
  const acc = directAccount('device-a-b-stale@example.com');
  const token = directSession(acc);
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'placeAB', name: 'X' }] } });

  // 두 기기 모두 처음엔 미방문 상태(version 0)를 로컬에 갖고 있었다.
  const initial = await api('GET', '/api/visits', { token });
  t('사전 조건 — 처음엔 방문 기록이 없음', initial.json.visits.length === 0);

  // 기기 A — 실시간으로 방문 처리(서버 버전이 실제로 올라감).
  const markedByA = await api('POST', '/api/visits/placeAB/mark', { token, body: { date: '2025-05-01' } });
  t('기기 A의 실시간 방문 처리 성공', markedByA.status === 200);
  const serverVersionAfterA = markedByA.json.visit.version;

  // 기기 B — A의 변경을 전혀 모른 채(version 0을 여전히 로컬에 들고),
  // 자기 나름의(비어있는) 상태를 그대로 동기화 업로드.
  const syncFromB = await api('POST', '/api/visits/sync', {
    token, body: { visits: [{ placeId: 'placeAB', visited: false, wantRevisit: false, visitedDates: [], notes: '', version: 0, updatedAt: '2020-01-01T00:00:00.000Z' }] },
  });
  t('기기 B의 오래된 동기화가 충돌로 감지됨', syncFromB.json.conflicts.some((c) => c.placeId === 'placeAB'));
  const afterSync = syncFromB.json.visits.find((v) => v.placeId === 'placeAB');
  t('기기 A가 남긴 방문 기록이 기기 B의 오래된 값으로 지워지지 않음', afterSync.visited === true && afterSync.visitedDates.length === 1);
}

// ============================================================
// 2. 서로 다른 여행이 두 기기에 추가됨 — 서로 다른 tripId라 충돌 없이
//    둘 다 그대로 남아야 한다.
// ============================================================
{
  const acc = directAccount('two-devices-two-trips@example.com');
  const token = directSession(acc);
  const tripFromDeviceA = { tripId: 'trip_from_device_a', city: '서울', name: 'A기기 여행', version: 0 };
  const tripFromDeviceB = { tripId: 'trip_from_device_b', city: '부산', name: 'B기기 여행', version: 0 };
  const syncA = await api('POST', '/api/trips/sync', { token, body: { trips: [tripFromDeviceA] } });
  const syncB = await api('POST', '/api/trips/sync', { token, body: { trips: [tripFromDeviceB] } });
  t('기기 A가 만든 여행이 충돌 없이 반영됨', syncA.json.conflicts.length === 0);
  t('기기 B가 만든 여행도 충돌 없이 반영됨(서로 다른 tripId)', syncB.json.conflicts.length === 0);
  const finalList = await api('GET', '/api/trips', { token });
  const ids = finalList.json.trips.map((tr) => tr.tripId);
  t('두 기기가 각자 만든 여행이 둘 다 그대로 남아 있음', ids.includes('trip_from_device_a') && ids.includes('trip_from_device_b'));
}

// ============================================================
// 3. 같은 장소가 두 기기에서 서로 다른 방문 날짜를 가짐 — 둘 다 서로
//    몰랐던 상태로 동기화해도 두 날짜 모두 보존돼야 한다(하나가 다른
//    하나를 지우면 안 됨).
// ============================================================
{
  const acc = directAccount('two-devices-two-dates@example.com');
  const token = directSession(acc);
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'sharedPlace', name: 'Y' }] } });

  // 두 기기 모두 서버가 아직 아무 기록도 없던(version 0) 시점부터
  // 시작해, 서로 다른 날짜를 각자 기록했다.
  const syncDevice1 = await api('POST', '/api/visits/sync', {
    token, body: { visits: [{ placeId: 'sharedPlace', visited: true, visitedDates: [{ date: '2025-02-01', tripId: null }], version: 0, updatedAt: '2025-02-01T00:00:00.000Z' }] },
  });
  t('기기1의 첫 동기화는 충돌 없이 반영됨(서버에 아직 아무 것도 없었으므로)', syncDevice1.json.conflicts.length === 0);

  // 기기2는 기기1의 존재를 몰랐다(여전히 version 0 기준) — 다른 날짜로 동기화.
  const syncDevice2 = await api('POST', '/api/visits/sync', {
    token, body: { visits: [{ placeId: 'sharedPlace', visited: true, visitedDates: [{ date: '2025-02-15', tripId: null }], version: 0, updatedAt: '2025-02-15T00:00:00.000Z' }] },
  });
  t('기기2는 이미 기기1이 반영된 뒤라 충돌로 감지됨', syncDevice2.json.conflicts.some((c) => c.placeId === 'sharedPlace'));
  const merged = syncDevice2.json.visits.find((v) => v.placeId === 'sharedPlace');
  const dates = merged.visitedDates.map((d) => d.date).sort();
  t('두 기기의 서로 다른 방문 날짜가 하나도 안 지워지고 둘 다 보존됨', dates.length === 2 && dates.includes('2025-02-01') && dates.includes('2025-02-15'));
}

// ============================================================
// 4. 삭제(방문 취소) 후 오래된 기기가 재연결 — 이미 지운 날짜가
//    되살아나면 안 된다.
// ============================================================
{
  const acc = directAccount('delete-then-stale-reconnect@example.com');
  const token = directSession(acc);
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'deletedPlace', name: 'Z' }] } });

  // 방문 처리 후, 최신 기기에서 그 방문을 취소(실수 표시 되돌리기)한다.
  const marked = await api('POST', '/api/visits/deletedPlace/mark', { token, body: { date: '2025-07-01' } });
  const unmarked = await api('POST', '/api/visits/deletedPlace/unmark', { token, body: { date: '2025-07-01' } });
  t('사전 조건 — 방문 취소 후 미방문 상태로 돌아감', unmarked.json.visit.visited === false);
  const versionAfterUnmark = unmarked.json.visit.version;

  // 오래된 기기가 "아직 지우기 전"(그 날짜가 여전히 있던) 상태를 그대로
  // 들고 재연결해 동기화한다 — 버전이 뒤처져 있다(unmark 이전 버전).
  const staleReconnect = await api('POST', '/api/visits/sync', {
    token,
    body: { visits: [{ placeId: 'deletedPlace', visited: true, visitedDates: [{ date: '2025-07-01', tripId: null }], version: versionAfterUnmark - 2, updatedAt: '2020-01-01T00:00:00.000Z' }] },
  });
  t('오래된 기기의 재연결이 충돌로 감지됨', staleReconnect.json.conflicts.some((c) => c.placeId === 'deletedPlace'));
  const afterReconnect = staleReconnect.json.visits.find((v) => v.placeId === 'deletedPlace');
  t('이미 명시적으로 지운 방문 날짜는 오래된 기기가 재연결해도 되살아나지 않음', afterReconnect.visited === false && afterReconnect.visitedDates.length === 0);
}

// ============================================================
// 5. 로그아웃/계정 전환 — 한 계정의 동기화 요청이 다른 계정의 여행·
//    방문 데이터에 손을 대면 안 된다(계정 격리).
// ============================================================
{
  const accX = directAccount('account-x@example.com');
  const accY = directAccount('account-y@example.com');
  const tokenX = directSession(accX);
  const tokenY = directSession(accY);

  const tripX = await api('POST', '/api/trips', { token: tokenX, body: { city: 'X도시' } });
  const tripXId = tripX.json.trip.tripId;

  // 계정 Y가 계정 X 소유의 tripId를 자기 것인 양 동기화 페이로드에
  // 실어 보내도(예: 기기 조작·버그로 다른 계정 토큰이 섞인 상황을
  // 가정) 그 여행은 절대 바뀌지 않아야 한다.
  const crossAccountAttempt = await api('POST', '/api/trips/sync', {
    token: tokenY, body: { trips: [{ tripId: tripXId, city: '몰래바꾼도시', name: '침입 시도', version: 0 }] },
  });
  t('계정 Y의 동기화 요청이 200으로는 응답하되(부분 무시) 오류로 전체 실패하지 않음', crossAccountAttempt.status === 200);
  const tripXStillOwnedByX = await api('GET', '/api/trips', { token: tokenX });
  t('계정 X의 여행은 계정 Y의 동기화 시도로 전혀 바뀌지 않음', tripXStillOwnedByX.json.trips[0].city === 'X도시');
  const tripListY = await api('GET', '/api/trips', { token: tokenY });
  t('계정 Y의 목록에는 계정 X의 여행이 나타나지 않음(데이터 유출 없음)', !tripListY.json.trips.some((tr) => tr.tripId === tripXId));

  // 방문 기록도 같은 방식으로 계정 간 격리를 확인한다.
  await api('PUT', '/api/places', { token: tokenX, body: { places: [{ id: 'xOnlyPlace', name: 'X전용' }] } });
  await api('POST', '/api/visits/xOnlyPlace/mark', { token: tokenX, body: { date: '2025-01-01' } });
  const visitsY = await api('GET', '/api/visits', { token: tokenY });
  t('계정 Y가 방문 기록을 조회해도 계정 X의 기록은 전혀 보이지 않음', !visitsY.json.visits.some((v) => v.placeId === 'xOnlyPlace'));
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
