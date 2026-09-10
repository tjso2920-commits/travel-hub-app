'use strict';
/**
 * 2026-09-10 재검토(7차) 1절 — "/api/places 전체치환으로 오래된 기기가
 * 최신 장소 수정을 덮어쓰는 문제"를 실제로 고친 것(account-data.mjs의
 * syncPlaces/syncCourses)을 서버 단위로 직접 검증한다. 실제 화면
 * 시나리오는 scripts/test-sync-protection-screens.mjs (a)가 이미
 * 검증하지만, 여기서는 버전 비교·삭제 무덤 표시·필드 보존을 더
 * 세밀하게(경계 조건까지) 확인한다.
 *
 * 실행: node server/test/places-courses-sync.test.mjs
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

// =====================================================================
// 1. 버전이 최신인 수정은 실제로 반영되고, 그 다음 뒤처진(오래된)
//    버전으로 오는 수정은 조용히 덮어쓰지 않고 conflicts로 보고된다 —
//    이름·메모·좌표·분류가 전부 최신 값 그대로 남는다.
// =====================================================================
{
  const acc = directAccount('places-version@example.com');
  const token = directSession(acc);

  const v1 = { id: 'p1', name: '원래 이름', note: '원래 메모', lat: 33.5, lng: 130.4, cat: '카페·디저트', version: 1 };
  const r1 = await api('PUT', '/api/places', { token, body: { places: [v1] } });
  t('첫 저장은 성공(새 장소)', r1.status === 200 && r1.json.places.length === 1);
  const storedV1 = r1.json.places[0];
  t('저장된 장소의 버전이 서버에서 매겨짐', storedV1.version >= 1);

  const v2 = { ...v1, name: '최신 이름', note: '최신 메모', lat: 33.6, lng: 130.5, cat: '맛집·식당', version: storedV1.version };
  const r2 = await api('PUT', '/api/places', { token, body: { places: [v2] } });
  const stored2 = r2.json.places.find((p) => p.id === 'p1');
  t('최신 버전으로 보낸 수정은 실제로 반영됨(이름·메모·좌표·분류 전부)',
    stored2.name === '최신 이름' && stored2.note === '최신 메모' && stored2.lat === 33.6 && stored2.lng === 130.5 && stored2.cat === '맛집·식당');
  const newerVersion = stored2.version;

  // 오래된 기기가 v1(뒤처진 기준 버전)을 그대로 다시 올린다.
  const staleAttempt = { ...v1, name: '오래된 기기가 우기는 이름', version: storedV1.version };
  const r3 = await api('PUT', '/api/places', { token, body: { places: [staleAttempt] } });
  t('뒤처진 버전의 수정은 conflicts로 보고됨(조용히 무시되지 않음)',
    r3.json.conflicts.some((c) => c.placeId === 'p1' && c.reason === 'stale-base-version'));
  const stored3 = r3.json.places.find((p) => p.id === 'p1');
  t('뒤처진 기기의 수정이 최신 값을 덮어쓰지 않음(이름·메모·좌표·분류 전부 그대로 보존)',
    stored3.name === '최신 이름' && stored3.note === '최신 메모' && stored3.lat === 33.6 && stored3.lng === 130.5 && stored3.cat === '맛집·식당');
  t('충돌이 나도 버전은 그대로 유지됨(충돌 자체로 버전이 안 올라감)', stored3.version === newerVersion);
}

// =====================================================================
// 2. 삭제(중복 병합 등)는 deletedIds로 명시된 것만 지운다 — 배열에
//    없다고 추측해서 지우지 않는다. 지운 뒤 오래된 기기가 그 id를
//    다시 들고 나타나도 되살아나지 않는다(무덤 표시).
// =====================================================================
{
  const acc = directAccount('places-delete@example.com');
  const token = directSession(acc);
  const rInit = await api('PUT', '/api/places', { token, body: { places: [{ id: 'keep1', name: '남는 곳', version: 0 }, { id: 'gone1', name: '합쳐져 사라질 곳', version: 0 }] } });
  const gone1Version = rInit.json.places.find((p) => p.id === 'gone1').version;

  // 배열에서 그냥 빠뜨리는 것("전체 치환"의 옛 방식)만으로는 안 지워진다
  // — deletedIds 없이 keep1만 다시 보내도 gone1이 그대로 남아 있어야
  // 한다(배열에 없다고 추측해서 지우면 안 된다는 원칙 확인).
  const rOmit = await api('PUT', '/api/places', { token, body: { places: [{ id: 'keep1', name: '남는 곳', version: rInit.json.places.find((p) => p.id === 'keep1').version }] } });
  t('배열에서 빠뜨리기만 해서는 지워지지 않음(추측 삭제 금지)', rOmit.json.places.some((p) => p.id === 'gone1'));

  // 실제로 deletedIds로 명시해서 지운다(예: 중복 병합) — 8차부터
  // 삭제도 기준 버전을 함께 보낸다({id, baseVersion}).
  const rDelete = await api('PUT', '/api/places', { token, body: { places: [], deletedIds: [{ id: 'gone1', baseVersion: gone1Version }] } });
  t('deletedIds로 명시하면 실제로 지워짐', !rDelete.json.places.some((p) => p.id === 'gone1'));
  t('명시적으로 지운 뒤에도 남은 장소는 그대로 있음', rDelete.json.places.some((p) => p.id === 'keep1'));

  // 이 사실을 모르는 오래된 기기가 gone1을 여전히 들고(옛 기준 버전으로) 다시 저장한다.
  const rResurrect = await api('PUT', '/api/places', { token, body: { places: [{ id: 'gone1', name: '되살아나려는 시도', version: gone1Version }] } });
  t('지워진 장소는 오래된 기기가 다시 들고 나타나도 되살아나지 않음', !rResurrect.json.places.some((p) => p.id === 'gone1'));
  t('되살리려는 시도는 conflicts로 보고됨', rResurrect.json.conflicts.some((c) => c.placeId === 'gone1' && c.reason === 'deleted-elsewhere'));

  const view = await api('GET', '/api/places', { token });
  t('GET으로 조회해도 지워진 장소는 안 보임', !view.json.places.some((p) => p.id === 'gone1'));
}

// =====================================================================
// 3. account_courses(레거시, tripId 없는 코스)도 같은 버전 보호를
//    받는다 — 같은 (city, date) 자리를 두 기기가 다투는 경우.
// =====================================================================
{
  const acc = directAccount('courses-version@example.com');
  const token = directSession(acc);
  const c1 = { city: '테스트시티', date: '2026-01-01', stops: [{ id: 'x' }], version: 0 };
  const r1 = await api('PUT', '/api/courses', { token, body: { courses: [c1] } });
  const stored1 = r1.json.courses[0];
  t('첫 코스 저장 성공', r1.status === 200 && stored1.stops.length === 1);

  const c2 = { ...c1, stops: [{ id: 'x' }, { id: 'y' }], version: stored1.version };
  const r2 = await api('PUT', '/api/courses', { token, body: { courses: [c2] } });
  const stored2 = r2.json.courses.find((c) => c.date === '2026-01-01');
  t('최신 버전 코스 수정은 반영됨(스톱 2개)', stored2.stops.length === 2);

  const staleC = { ...c1, stops: [{ id: 'z' }], version: stored1.version };
  const r3 = await api('PUT', '/api/courses', { token, body: { courses: [staleC] } });
  t('뒤처진 버전의 코스 수정은 conflicts로 보고됨', r3.json.conflicts.some((c) => c.city === '테스트시티' && c.date === '2026-01-01'));
  const stored3 = r3.json.courses.find((c) => c.date === '2026-01-01');
  t('뒤처진 코스 수정이 최신 코스를 덮어쓰지 않음(스톱 2개 그대로)', stored3.stops.length === 2);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
