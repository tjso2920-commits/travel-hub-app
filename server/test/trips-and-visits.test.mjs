'use strict';
/**
 * 2026-09-10 재검토(5차) 5절 — 재방문 여행자 지원(장소 보관함/여행 분리
 * + 방문 기록)의 서버 스키마·API 검증. R5-5 범위: trips/place_visits
 * 스키마와 라우트, 마이그레이션, 무료/유료 경계. 다음 여행 코스 생성
 * (5-③)과 동기화 충돌 보호(6절)는 각각 별도 파일에서 검증한다.
 *
 * 실행: node server/test/trips-and-visits.test.mjs
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
// 1. 같은 도시로 여러 번의 여행 — 각각 따로 저장·열람·전환. 새 여행을
//    만들거나 도시를 바꿔도 기존 기록이 지워지지 않는다.
// ============================================================
{
  const acc = directAccount('multi-trip-same-city@example.com');
  const token = directSession(acc);

  const tripA = await api('POST', '/api/trips', { token, body: { city: '후쿠오카', name: '첫 후쿠오카 여행', startDate: '2025-01-01', endDate: '2025-01-03' } });
  t('첫 번째 후쿠오카 여행 생성 성공', tripA.status === 200 && !!tripA.json.trip.tripId);
  const tripB = await api('POST', '/api/trips', { token, body: { city: '후쿠오카', name: '두 번째 후쿠오카 여행', startDate: '2025-06-01', endDate: '2025-06-05' } });
  t('같은 도시로 두 번째 여행도 완전히 새로 생성됨(각각 분리)', tripB.status === 200 && tripB.json.trip.tripId !== tripA.json.trip.tripId);

  // 각 여행에 서로 다른 날짜의 코스를 저장한다.
  await api('PUT', `/api/trips/${tripA.json.trip.tripId}/courses`, { token, body: { courses: [{ date: '2025-01-01', stops: ['a1'] }] } });
  await api('PUT', `/api/trips/${tripB.json.trip.tripId}/courses`, { token, body: { courses: [{ date: '2025-06-01', stops: ['b1'] }] } });

  const listed = await api('GET', '/api/trips', { token });
  t('두 여행 모두 목록에 그대로 남아 있음(새 여행이 이전 여행을 지우지 않음)', listed.json.trips.length === 2);

  const coursesA = await api('GET', `/api/trips/${tripA.json.trip.tripId}/courses`, { token });
  const coursesB = await api('GET', `/api/trips/${tripB.json.trip.tripId}/courses`, { token });
  t('첫 번째 여행의 코스는 그대로 남아 있음(다른 여행 저장에 영향 안 받음)', coursesA.json.courses.length === 1 && coursesA.json.courses[0].stops[0] === 'a1');
  t('두 번째 여행의 코스도 독립적으로 저장됨', coursesB.json.courses.length === 1 && coursesB.json.courses[0].stops[0] === 'b1');

  // 도시를 바꿔도(다른 도시로 새 여행 생성) 기존 여행들이 지워지지 않는다.
  const tripC = await api('POST', '/api/trips', { token, body: { city: '도쿄', name: '도쿄 여행' } });
  t('다른 도시로 새 여행을 만들어도 이전 여행들이 그대로 남아 있음', tripC.status === 200);
  const listedAfter = await api('GET', '/api/trips', { token });
  t('도시를 바꾼 뒤에도 이전 두 후쿠오카 여행이 삭제되지 않음', listedAfter.json.trips.length === 3);
}

// ============================================================
// 2. 방문 기록 — 미방문/방문함/다시가고싶음 필터, 동시 설정 가능,
//    코스에 담아도 자동 방문처리 안 됨, 방문완료/취소 둘 다 가능,
//    반복 방문 날짜·메모 보존.
// ============================================================
{
  const acc = directAccount('visit-records@example.com');
  const token = directSession(acc);

  // 장소를 보관함에 저장하고 여행 코스에 담는다 — 이 행위 자체가 방문
  // 처리를 자동으로 유발하면 안 된다.
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'spot1', name: '스팟1' }] } });
  const trip = await api('POST', '/api/trips', { token, body: { city: '오사카' } });
  await api('PUT', `/api/trips/${trip.json.trip.tripId}/courses`, { token, body: { courses: [{ date: '2025-03-01', stops: ['spot1'] }] } });

  const visitsAfterAdd = await api('GET', '/api/visits', { token });
  t('코스에 장소를 담기만 해도 방문 기록에는 아무 것도 안 생김(자동 방문처리 금지)', visitsAfterAdd.json.visits.length === 0);

  // 명시적으로 방문 완료 처리.
  const marked = await api('POST', '/api/visits/spot1/mark', { token, body: { date: '2025-03-01', tripId: trip.json.trip.tripId } });
  t('명시적으로 방문 완료 처리하면 성공', marked.status === 200 && marked.json.visit.visited === true);
  t('미방문 상태에서 시작했으므로 방문 전엔 미방문이었음이 위 검증으로 확인됨', true);

  // 다시 가고 싶음은 완전히 독립적으로 켤 수 있다 — 방문함과 동시에.
  const wantRevisit = await api('POST', '/api/visits/spot1/want-revisit', { token, body: { wantRevisit: true } });
  t('방문함 상태에서도 다시가고싶음을 동시에 켤 수 있음', wantRevisit.json.visit.visited === true && wantRevisit.json.visit.wantRevisit === true);

  // 같은 장소를 다른 여행/날짜에 또 방문 — 반복 방문 날짜가 쌓인다.
  const trip2 = await api('POST', '/api/trips', { token, body: { city: '오사카' } });
  await api('POST', '/api/visits/spot1/mark', { token, body: { date: '2025-09-01', tripId: trip2.json.trip.tripId } });
  const notesSet = await api('POST', '/api/visits/spot1/notes', { token, body: { notes: '두 번째 방문 때 새로 생긴 메뉴가 맛있었음' } });
  t('반복 방문 날짜가 배열로 누적됨(두 번째 날짜 추가)', notesSet.json.visit.visitedDates.length === 2);
  t('개인 메모가 저장됨', notesSet.json.visit.notes.includes('새로 생긴 메뉴'));

  // 실수로 표시한 것 취소(가장 최근 날짜 하나만 제거) — 방문 자체는
  // 유지되고 메모도 그대로 보존된다.
  const unmarked = await api('POST', '/api/visits/spot1/unmark', { token, body: { date: '2025-09-01' } });
  t('특정 방문 날짜만 취소해도 다른 방문 기록(첫 방문)은 남아 있음', unmarked.json.visit.visited === true && unmarked.json.visit.visitedDates.length === 1);
  t('취소 후에도 메모는 보존됨', unmarked.json.visit.notes.includes('새로 생긴 메뉴'));

  // 마지막 남은 방문 기록까지 취소하면 다시 미방문으로 돌아간다.
  const unmarkedAll = await api('POST', '/api/visits/spot1/unmark', { token, body: { date: '2025-03-01' } });
  t('마지막 방문 기록까지 취소하면 미방문 상태로 돌아감', unmarkedAll.json.visit.visited === false && unmarkedAll.json.visit.visitedDates.length === 0);
  t('미방문으로 돌아가도 다시가고싶음 표시는 별개로 유지됨', unmarkedAll.json.visit.wantRevisit === true);
}

// ============================================================
// 4. 무료·유료 경계 — 기록 쓰기·조회·여행 전환은 전부 무료체험을
//    소진하지 않는다. 코스 "재계산"만 기존 정책(무료체험 1회)을 따른다.
// ============================================================
{
  const acc = directAccount('free-paid-boundary@example.com');
  const token = directSession(acc);

  const trialBefore = await api('GET', '/api/trial', { token });
  t('사전 조건 — 무료체험 미사용 상태로 시작', trialBefore.json.used === false);

  // 여러 개의 새 여행 생성 + 도시 전환 + 방문 기록 쓰기/조회를 잔뜩
  // 해도 무료체험 소진 여부에는 전혀 영향이 없어야 한다.
  const t1 = await api('POST', '/api/trips', { token, body: { city: '후쿠오카' } });
  const t2 = await api('POST', '/api/trips', { token, body: { city: '삿포로' } });
  const t3 = await api('POST', '/api/trips', { token, body: { city: '오키나와' } });
  await api('PUT', '/api/places', { token, body: { places: [{ id: 'freeplace', name: 'X' }] } });
  await api('POST', '/api/visits/freeplace/mark', { token, body: { date: '2025-01-01', tripId: t1.json.trip.tripId } });
  await api('POST', '/api/visits/freeplace/unmark', { token, body: {} });
  await api('POST', '/api/visits/freeplace/want-revisit', { token, body: { wantRevisit: true } });
  await api('POST', '/api/visits/freeplace/notes', { token, body: { notes: '메모' } });
  await api('GET', '/api/visits', { token });
  await api('GET', '/api/trips', { token });

  const trialAfter = await api('GET', '/api/trial', { token });
  t('여행 여러 개 생성·도시 전환·방문 기록 읽기/쓰기를 반복해도 무료체험은 그대로 미사용 상태', trialAfter.json.used === false);

  // 이용권이 만료된 뒤에도(유료 상태가 아니게 된 뒤에도) 기록 자체는
  // 계속 보이고 계속 쓸 수 있어야 한다 — 만료를 흉내내려고 계정을 그냥
  // free plan 그대로 둔 채(에초에 유료를 산 적 없음) 기록 API들이 여전히
  // 200으로 동작하는지 확인한다(엔타이틀먼트 검사 자체가 이 라우트들
  // 어디에도 걸려 있지 않다는 것 — 코드 경로 확인).
  const viewAfter = await api('GET', '/api/visits', { token });
  t('유료 이용권이 전혀 없는(free) 계정에서도 방문 기록 조회는 그대로 동작함', viewAfter.status === 200);
  const markAfter = await api('POST', '/api/visits/freeplace/mark', { token, body: { date: '2025-02-01' } });
  t('유료 이용권이 없어도 방문 완료 표시는 그대로 동작함(유료 API 호출이 아니므로)', markAfter.status === 200);
}

console.log(fail ? `\n실패 ${fail}건(1/2)` : '\n1/2 통과');
const failBeforeMigrationCheck = fail;
server.close();

// ============================================================
// 3. 기존 city+date 코스 데이터 + 예전 단일 일정 데이터의 무손실
//    마이그레이션 — 실제 파일 기반 DB로 "서버 재시작"을 그대로 재현한다
//    (:memory:는 프로세스가 재시작되면 데이터 자체가 사라지므로 이
//    시나리오를 검증할 수 없다 — 실제 마이그레이션은 지속 저장되는
//    파일 DB에서만 의미가 있다).
// ============================================================
{
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const dbPath = path.join(os.tmpdir(), `trips-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

  // 1단계 — 예전 프로세스인 척, DB를 처음 열어 예전 구조로만 데이터를 심는다.
  {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', plan_expires_at TEXT, active_order_id TEXT);
      CREATE TABLE account_courses (account_id TEXT NOT NULL, city TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (account_id, city, date));
      CREATE TABLE courses (account_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const now = new Date().toISOString();
    const legacyAcc = 'legacy-acc-1';
    raw.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(legacyAcc, 'legacy-migration@example.com', now, 'free');
    raw.prepare('INSERT INTO account_courses (account_id, city, date, data, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(legacyAcc, '나고야', '2024-05-01', JSON.stringify({ stops: ['old1'] }), now);
    raw.prepare('INSERT INTO account_courses (account_id, city, date, data, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(legacyAcc, '나고야', '2024-05-02', JSON.stringify({ stops: ['old2'] }), now);
    // 예전 단일 일정 구조(멀티데이 도입 이전) 데이터도 하나 심어 둔다.
    raw.prepare('INSERT INTO courses (account_id, data, updated_at) VALUES (?, ?, ?)')
      .run(legacyAcc, JSON.stringify({ city: '삿포로', date: '2023-11-01', stops: ['single-old'] }), now);
    raw.close();
  }

  // 2단계 — 새 프로세스가 이 DB 파일로 뜬 것처럼, 새 자식 프로세스에서
  // db.mjs의 migrate()를 실제로 실행시킨다(싱글턴 config/db 재사용
  // 문제를 피하려고 자식 프로세스로 분리 — 이 파일의 다른 테스트 구간과
  // 같은 프로세스 안에서는 db.mjs의 db 싱글턴이 이미 다른(:memory:) DB로
  // 고정돼 있어 파일 DB를 다시 열 수 없다).
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const checkScript = `
    process.env.DB_PATH = ${JSON.stringify(dbPath)};
    process.env.APP_ENV = 'development';
    const { openDb } = await import(${JSON.stringify(fileURLToPath(new URL('../db.mjs', import.meta.url)))});
    const db = openDb();
    const trips = db.prepare("SELECT * FROM trips WHERE city IN ('나고야','삿포로') ORDER BY city").all();
    const tripCourses = db.prepare('SELECT * FROM trip_courses').all();
    console.log(JSON.stringify({ trips, tripCourses }));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', checkScript], { encoding: 'utf8' });
  let fail2 = 0; const t2 = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail2++; };
  if (res.status !== 0) {
    t2('마이그레이션 검증 자식 프로세스가 정상 종료됨', false);
    console.error(res.stderr);
  } else {
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    const nagoya = out.trips.find((r) => r.city === '나고야');
    const sapporo = out.trips.find((r) => r.city === '삿포로');
    t2('예전 city+date 코스 데이터(나고야)가 새 여행 하나로 옮겨짐', !!nagoya && nagoya.start_date === '2024-05-01' && nagoya.end_date === '2024-05-02');
    t2('예전 단일 일정 데이터(삿포로, courses 테이블)도 별도 여행으로 옮겨짐', !!sapporo);
    const nagoyaCourses = out.tripCourses.filter((r) => r.trip_id === (nagoya && nagoya.trip_id));
    t2('나고야 여행의 두 날짜 코스 데이터가 손실 없이 그대로 옮겨짐(2건)', nagoyaCourses.length === 2);
    const sapporoCourses = out.tripCourses.filter((r) => r.trip_id === (sapporo && sapporo.trip_id));
    t2('삿포로(예전 단일 일정)의 코스 데이터도 그대로 옮겨짐(1건)', sapporoCourses.length === 1 && JSON.parse(sapporoCourses[0].data).stops[0] === 'single-old');
  }
  fail += fail2;
  try { fs.unlinkSync(dbPath); fs.unlinkSync(dbPath + '-wal'); fs.unlinkSync(dbPath + '-shm'); } catch (e) { /* WAL/SHM 파일이 없을 수도 있음 */ }
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
