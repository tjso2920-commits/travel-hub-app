'use strict';
/**
 * 2026-09-10 재검토(8차) 1절 — ChatGPT가 재현한 동기화 충돌 보호 버그.
 *
 * 재현 순서(원문 그대로):
 *  1) 기기 A·B가 원본(버전 1)을 각각 읽음.
 *  2) A가 수정 후 서버에 반영(버전이 2가 됨).
 *  3) B가 "원본(버전 1) 기준"으로 다른 수정을 해서 저장을 시도.
 *  4) 예전 서버는 `incomingVersion >= existing.version`만 봐서 —
 *     B가 자기 로컬에서도 "내가 수정했으니 버전 2"라고 올려 보내면
 *     이미 서버가 2인데도 다시 수락해 A의 수정을 지워버렸다.
 *
 * 새 프로토콜: 클라이언트가 보내는 version 필드는 "이 수정이 근거로
 * 삼은 서버 버전"(baseVersion)이다. 서버는 그 값이 지금 서버가 들고
 * 있는 버전과 **정확히 같을 때만** 수락한다(>=가 아니라 ===). A·B가
 * 둘 다 원본(버전 1)에서 시작했으므로 둘 다 baseVersion=1을 보내고,
 * 서버는 먼저 도착한 것만 수락(버전을 2로 발급)하고 나중 것은
 * 정직하게 충돌로 보고한다(서버 데이터를 그대로 보존).
 *
 * 실행: node server/test/sync-conflict-protection.test.mjs
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
  let json = null; try { json = await res.json(); } catch (e) {}
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

// =====================================================================
// (a) 정확히 지시된 재현 순서 — 장소(places)
// =====================================================================
{
  const acc = directAccount('sync-race-places@example.com');
  const token = directSession(acc);

  // 원본을 만들고 A·B 둘 다 "원본(버전 1)"을 읽었다고 가정.
  const r0 = await api('PUT', '/api/places', { token, body: { places: [{ id: 'p1', name: '원본 이름', note: '원본 메모', version: 0 }] } });
  const baseVersion = r0.json.places[0].version; // 보통 1

  // A가 원본(baseVersion) 기준으로 수정해 먼저 저장 — 수락되고 버전이 올라가야 한다.
  const rA = await api('PUT', '/api/places', { token, body: { places: [{ id: 'p1', name: 'A가 고친 이름', note: '원본 메모', version: baseVersion }] } });
  t('(a) A의 수정은 원본 기준이라 수락됨', rA.status === 200 && !rA.json.conflicts.some((c) => c.placeId === 'p1'));
  const afterA = rA.json.places.find((p) => p.id === 'p1');
  t('(a) A의 수정이 실제로 반영됨', afterA.name === 'A가 고친 이름');

  // B는 A의 수정을 전혀 모른 채, 자신도 "원본(baseVersion)" 기준으로
  // 다른 필드를 고쳐 저장을 시도한다 — 이 요청은 반드시 거부돼야 한다.
  const rB = await api('PUT', '/api/places', { token, body: { places: [{ id: 'p1', name: '원본 이름', note: 'B가 고친 메모', version: baseVersion }] } });
  t('(a) B의 뒤처진 기준(baseVersion) 수정은 충돌로 보고됨(조용히 수락되지 않음)', rB.json.conflicts.some((c) => c.placeId === 'p1'));
  const afterB = rB.json.places.find((p) => p.id === 'p1');
  t('(a) B의 충돌 시도 후에도 A의 수정(이름)이 사라지지 않고 그대로 남음', afterB.name === 'A가 고친 이름');
  t('(a) B의 충돌 시도가 A의 메모까지 덮어쓰지 않음', afterB.note === '원본 메모');

  const conflictEntry = rB.json.conflicts.find((c) => c.placeId === 'p1');
  t('(a) 충돌 응답에 서버의 현재 값(재병합용)이 함께 실려 옴', conflictEntry && conflictEntry.serverPlace && conflictEntry.serverPlace.name === 'A가 고친 이름');
  t('(a) 충돌 응답에 서버의 최신 버전 번호가 포함됨', conflictEntry && typeof conflictEntry.serverVersion === 'number' && conflictEntry.serverVersion === afterA.version);
}

// =====================================================================
// (a2) `>=`와 `===`가 실제로 다르게 동작하는 지점 — 예전 클라이언트는
//     "내가 수정했으니 다음 버전"을 스스로 계산해(base+1) 보냈다. A가
//     이미 그 base+1 값을 정식으로 받아 서버 버전이 그만큼 올라간
//     뒤에도, 예전 서버(`>=`)는 "그 값과 같거나 큰 값"을 전부 신뢰해
//     받아줬다 — 즉 클라이언트가 우연히·혹은 스스로 계산해 서버의
//     지금 버전과 "같은" 값을 다시 보내면 그게 실제로 그 버전을
//     "읽고 나서" 수정한 게 맞는지 서버가 전혀 확인하지 않았다는
//     뜻이다. 정확한 대조(`===`)로 바꿔도 이 특정 재현(우연히 숫자가
//     같은 경우)까지 서버 혼자 완전히 막을 수는 없다 — 진짜 근본
//     해결은 "클라이언트가 자기 마음대로 다음 버전을 추측해서 보내지
//     않고, 서버에서 마지막으로 확인한 기준 버전만 보낸다"는 클라이언트
//     쪽 수정이다(import-adapter.js — 실제 두 기기 화면 흐름 검증은
//     scripts/test-sync-conflict-devices.mjs). 여기서는 서버가 최소한
//     "클라이언트가 서버보다 더 미래의 버전을 주장하는" 명백히 말이
//     안 되는 경우까지도 그냥 신뢰해 버리던 예전 결함을 고쳤는지만
//     확인한다 — `>=`는 이런 경우도 무조건 통과시켰지만 `===`는 반드시
//     막는다(이 부분은 실제로 `>=`→`===`만으로 검증 가능한 차이).
// =====================================================================
{
  const acc = directAccount('sync-future-version@example.com');
  const token = directSession(acc);
  const r0 = await api('PUT', '/api/places', { token, body: { places: [{ id: 'p1', name: '이름', version: 0 }] } });
  const v1 = r0.json.places[0].version; // 보통 1

  // 서버는 아직 버전 1인데, 클라이언트가 "미래의" 더 큰 버전(예: 잘못된
  // 로컬 상태·복원된 백업 등)을 주장하며 수정을 보낸다.
  const rFuture = await api('PUT', '/api/places', { token, body: { places: [{ id: 'p1', name: '미래버전을 주장하는 수정', version: v1 + 5 }] } });
  t('(a2) 서버 버전보다 큰(미래) 버전을 주장하는 수정은 충돌로 거부됨(예전엔 >=라서 무조건 통과됐다)', rFuture.json.conflicts.some((c) => c.placeId === 'p1'));
  const afterFuture = rFuture.json.places.find((p) => p.id === 'p1');
  t('(a2) 미래 버전 주장이 거부돼 원래 이름이 그대로 남음', afterFuture.name === '이름');
}

// =====================================================================
// (b) 무변경 재전송은 버전을 올리지 않음
// =====================================================================
{
  const acc = directAccount('sync-noop-places@example.com');
  const token = directSession(acc);
  const r0 = await api('PUT', '/api/places', { token, body: { places: [{ id: 'p1', name: '이름', note: '메모', version: 0 }] } });
  const v1 = r0.json.places[0].version;

  // 똑같은 내용을 같은 baseVersion으로 다시 보낸다(예: 재시도, 여러
  // 탭에서 동시 저장 등) — 실제로 아무것도 안 바뀌었으니 버전이 또
  // 올라가면 안 된다(그러면 다른 기기의 baseVersion이 부당하게 뒤처진
  // 것처럼 보인다).
  const r1 = await api('PUT', '/api/places', { token, body: { places: [{ id: 'p1', name: '이름', note: '메모', version: v1 }] } });
  const v2 = r1.json.places.find((p) => p.id === 'p1').version;
  t('(b) 내용이 그대로면 버전이 올라가지 않음', v2 === v1);
  t('(b) 무변경 재전송은 충돌로도 안 보고됨', !r1.json.conflicts.some((c) => c.placeId === 'p1'));
}

// =====================================================================
// (c) 삭제도 기준 버전+충돌 정책을 적용한다 — 삭제 대상이 그 사이
//    다른 기기에서 수정됐으면(예: 좌표가 채워짐) 조용히 지우지 않는다.
// =====================================================================
{
  const acc = directAccount('sync-delete-conflict@example.com');
  const token = directSession(acc);
  const r0 = await api('PUT', '/api/places', { token, body: { places: [{ id: 'dup1', name: '중복 후보', version: 0 }] } });
  const baseVersion = r0.json.places[0].version;

  // 다른 기기가 그 사이 이 장소에 실제 좌표를 채워 넣었다(정당한 수정).
  const rEdit = await api('PUT', '/api/places', { token, body: { places: [{ id: 'dup1', name: '중복 후보', lat: 33.5, lng: 130.4, version: baseVersion }] } });
  t('(c) 사전 조건 — 다른 기기의 수정이 먼저 반영됨', rEdit.json.places.find((p) => p.id === 'dup1').lat === 33.5);

  // 이 기기는 그 수정을 전혀 모른 채(옛 baseVersion 그대로) 중복
  // 병합으로 이 장소를 지우려 한다 — 조용히 지워지면 방금 채워진
  // 좌표가 통째로 사라진다.
  const rDelete = await api('PUT', '/api/places', { token, body: { places: [], deletedIds: [{ id: 'dup1', baseVersion }] } });
  t('(c) 기준 버전이 뒤처진 삭제 시도는 충돌로 보고되고 실제로 지워지지 않음', !rDelete.json.places.find((p) => p.id === 'dup1') ? false : true);
  t('(c) 삭제 충돌이 conflicts에 정확히 보고됨', rDelete.json.conflicts.some((c) => c.placeId === 'dup1' && c.reason === 'stale-base-version-delete'));
  const stillThere = rDelete.json.places.find((p) => p.id === 'dup1');
  t('(c) 좌표가 채워진 최신 값이 그대로 보존됨(삭제로 사라지지 않음)', stillThere && stillThere.lat === 33.5);

  // 최신 baseVersion으로 다시 삭제를 시도하면 실제로 지워져야 한다.
  const latestVersion = stillThere.version;
  const rDelete2 = await api('PUT', '/api/places', { token, body: { places: [], deletedIds: [{ id: 'dup1', baseVersion: latestVersion }] } });
  t('(c) 최신 기준 버전으로 다시 삭제하면 정상적으로 지워짐', !rDelete2.json.places.find((p) => p.id === 'dup1'));
}

// =====================================================================
// (d) 코스(courses)도 같은 기준 버전 대조 원칙을 따른다.
// =====================================================================
{
  const acc = directAccount('sync-race-courses@example.com');
  const token = directSession(acc);
  const r0 = await api('PUT', '/api/courses', { token, body: { courses: [{ city: '테스트', date: '2026-01-01', stops: [{ id: 'x' }], version: 0 }] } });
  const baseVersion = r0.json.courses[0].version;
  const rA = await api('PUT', '/api/courses', { token, body: { courses: [{ city: '테스트', date: '2026-01-01', stops: [{ id: 'x' }, { id: 'y' }], version: baseVersion }] } });
  t('(d) A의 코스 수정 수락', rA.status === 200 && rA.json.courses.find((c) => c.date === '2026-01-01').stops.length === 2);
  const rB = await api('PUT', '/api/courses', { token, body: { courses: [{ city: '테스트', date: '2026-01-01', stops: [{ id: 'x' }, { id: 'z' }], version: baseVersion }] } });
  t('(d) B의 뒤처진 기준 코스 수정은 충돌로 거부됨', rB.json.conflicts.some((c) => c.date === '2026-01-01'));
  const afterB = rB.json.courses.find((c) => c.date === '2026-01-01');
  t('(d) A의 코스 수정이 사라지지 않음(스톱 2개 유지)', afterB.stops.length === 2 && afterB.stops[1].id === 'y');
}

// =====================================================================
// (e) 여행(trips)도 같은 결함이 있었다 — "기준 버전보다 크거나 같으면
//     통과"였다. 원본에서 시작한 두 기기가 서로 다른 필드를 고치면
//     나중 요청이 먼저 요청을 덮어써야 정상인데, 정확 대조로 막는다.
// =====================================================================
{
  const acc = directAccount('sync-race-trips@example.com');
  const token = directSession(acc);
  const rCreate = await api('POST', '/api/trips', { token, body: { city: '테스트시티', name: '원래 이름' } });
  const tripId = rCreate.json.trip.tripId;
  const baseVersion = rCreate.json.trip.version;

  const rA = await api('POST', '/api/trips/sync', { token, body: { trips: [{ tripId, city: '테스트시티', name: 'A가 고친 이름', version: baseVersion }] } });
  t('(e) A의 여행 수정 수락', !rA.json.conflicts.some((c) => c.tripId === tripId));

  const rB = await api('POST', '/api/trips/sync', { token, body: { trips: [{ tripId, city: '테스트시티', name: 'B가 고친 이름', version: baseVersion }] } });
  t('(e) B의 뒤처진 기준 여행 수정은 충돌로 거부됨', rB.json.conflicts.some((c) => c.tripId === tripId && c.reason === 'stale-base-version'));
  const afterB = rB.json.trips.find((tr) => tr.tripId === tripId);
  t('(e) A의 여행 수정(이름)이 사라지지 않고 그대로 남음', afterB.name === 'A가 고친 이름');
}

// =====================================================================
// (f) 방문 기록(visits)도 같은 결함이 있었다. 원본에서 시작한 두
//     기기가 서로 다른 날짜에 각각 방문 표시를 했을 때, 나중 요청이
//     먼저 요청의 방문 날짜를 통째로 지워버리면 안 된다 — 둘 다
//     보존(합집합)돼야 한다.
// =====================================================================
{
  const acc = directAccount('sync-race-visits@example.com');
  const token = directSession(acc);
  const rInit = await api('POST', '/api/visits/sync', { token, body: { visits: [{ placeId: 'v1', visitedDates: [{ date: '2026-01-01' }], version: 0 }] } });
  const baseVersion = rInit.json.visits.find((v) => v.placeId === 'v1').version;

  const rA = await api('POST', '/api/visits/sync', { token, body: { visits: [{ placeId: 'v1', visitedDates: [{ date: '2026-01-01' }, { date: '2026-02-01' }], version: baseVersion }] } });
  t('(f) A가 2월 방문 날짜를 추가 — 수락됨', rA.json.visits.find((v) => v.placeId === 'v1').visitedDates.length === 2);

  // B는 A의 추가를 전혀 모른 채(옛 기준 버전 그대로) 자신도 원본 기준으로
  // 다른 날짜(3월)를 추가해 저장을 시도한다.
  const rB = await api('POST', '/api/visits/sync', { token, body: { visits: [{ placeId: 'v1', visitedDates: [{ date: '2026-01-01' }, { date: '2026-03-01' }], version: baseVersion }] } });
  const afterB = rB.json.visits.find((v) => v.placeId === 'v1');
  const dates = afterB.visitedDates.map((d) => d.date).sort();
  t('(f) B의 뒤처진 기준 시도가 충돌로 보고됨', rB.json.conflicts.some((c) => c.placeId === 'v1'));
  t('(f) A가 추가한 2월 방문과 B가 추가한 3월 방문이 둘 다 보존됨(하나가 다른 하나를 안 지움)', dates.includes('2026-02-01') && dates.includes('2026-03-01'));
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
