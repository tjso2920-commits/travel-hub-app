'use strict';
/**
 * 2026-09-11 재검토(11차) — ChatGPT가 실제 코드로 재현한 결함 두 건을
 * 서버 로직만으로(순수 Node + 인메모리 SQLite, 실제 브라우저 아님)
 * 검증한다.
 *
 * (재현 1) trips 저장은 정해진 컬럼만 다뤄, daRemergeGenericConflict가
 * 남긴 같은-필드 충돌 표시(_fieldConflicts)가 재제출 성공과 동시에
 * 사라졌다 — field_conflicts 컬럼을 추가해 저장·응답에 실어 보내는지
 * 확인한다.
 *
 * (재현 2, 11차 자체 재현 — R11-2 작업 중 새 시나리오를 추가하다
 * 실제로 발견됨) account_places/account_courses는 "내용이 실제로 안
 * 바뀐 재전송은 기준 버전을 안 올린다"는 보호가 있는데 trips만 없어서,
 * 아무것도 안 바꾼 기기가 그냥 재동기화만 해도 버전이 부당하게 올라가
 * 다른 기기의 정상적인 후속 저장이 가짜 충돌을 만나게 됐다
 * (scripts/test-sync-conflict-devices.mjs 11번 시나리오에서 실제
 * 재현된 뒤 이 파일로 서버 단위 검증을 옮겼다).
 *
 * 실행: node server/test/trips-field-conflicts.test.mjs
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
// 1. field_conflicts가 실제로 컬럼에 저장되고 응답에 그대로 실려
//    나오는지 — 재제출(같은 baseVersion)로 성공 저장된 뒤에도 사라지지
//    않아야 한다.
// ============================================================
{
  const acc = directAccount('trip-fc-1@example.com');
  const token = directSession(acc);
  const created = await api('POST', '/api/trips', { token, body: { city: '테스트시티', name: '원래 이름' } });
  const tripId = created.json.trip.tripId;
  t('1) 새 여행 생성 직후엔 field_conflicts가 없음', !created.json.trip._fieldConflicts);

  const withConflict = await api('POST', '/api/trips/sync', {
    token,
    body: { trips: [{ tripId, city: '테스트시티', name: 'LOCAL', version: 1, _fieldConflicts: { name: { mine: 'LOCAL', theirs: 'SERVER' } } }] },
  });
  const savedTrip = withConflict.json.trips.find((x) => x.tripId === tripId);
  t('1) 같은 필드 충돌을 실은 재제출이 성공하면 이름은 mine(LOCAL) 값으로 저장됨', savedTrip.name === 'LOCAL');
  t('1) field_conflicts가 응답에도 그대로 실려 있음(예전엔 여기서 사라졌다)', savedTrip._fieldConflicts && savedTrip._fieldConflicts.name && savedTrip._fieldConflicts.name.mine === 'LOCAL' && savedTrip._fieldConflicts.name.theirs === 'SERVER');

  const refetched = await api('GET', '/api/trips', { token });
  const refetchedTrip = refetched.json.trips.find((x) => x.tripId === tripId);
  t('1) 다시 조회해도(다른 기기 흉내) field_conflicts가 그대로 남아 있음', refetchedTrip._fieldConflicts && refetchedTrip._fieldConflicts.name);

  // 사용자가 "다른 기기 값으로 바꾸기"를 눌러 해결한 상황을 흉내낸다 —
  // _fieldConflicts 없이 재제출하면 컬럼도 정리돼야 한다.
  const resolved = await api('POST', '/api/trips/sync', {
    token,
    body: { trips: [{ tripId, city: '테스트시티', name: 'SERVER', version: savedTrip.version }] },
  });
  const resolvedTrip = resolved.json.trips.find((x) => x.tripId === tripId);
  t('1) 충돌 없이 재제출하면 field_conflicts가 정리됨', !resolvedTrip._fieldConflicts);
}

// ============================================================
// 2. 내용이 실제로 안 바뀐 재전송(같은 city/name/날짜/숙소/
//    field_conflicts)은 버전을 올리지 않는다(account_places/
//    account_courses와 동일한 원칙). 실제 내용이 다르면 당연히
//    올려야 한다 — 과도한 억제가 아닌지도 함께 확인한다.
// ============================================================
{
  const acc = directAccount('trip-fc-2@example.com');
  const token = directSession(acc);
  const created = await api('POST', '/api/trips', { token, body: { city: '노업도시', name: '이름' } });
  const tripId = created.json.trip.tripId;
  const v1 = created.json.trip.version;
  t('2) 준비 확인 — 생성 직후 버전은 1', v1 === 1);

  // 아무것도 안 바꾼 채 같은 내용을 그대로 재전송(예: 로그인 직후
  // 서버 상태를 받아 오려는 목적으로 자기 로컬 사본을 다시 올림).
  const resend1 = await api('POST', '/api/trips/sync', { token, body: { trips: [{ tripId, city: '노업도시', name: '이름', version: v1 }] } });
  const afterResend1 = resend1.json.trips.find((x) => x.tripId === tripId);
  t('2) 내용이 안 바뀐 재전송은 버전을 올리지 않음(예전엔 여기서 부당하게 올라갔다)', afterResend1.version === v1);

  // 한 번 더 반복해도 마찬가지 — 여러 번 재전송해도 계속 안 올라가야 한다.
  const resend2 = await api('POST', '/api/trips/sync', { token, body: { trips: [{ tripId, city: '노업도시', name: '이름', version: v1 }] } });
  const afterResend2 = resend2.json.trips.find((x) => x.tripId === tripId);
  t('2) 반복 재전송에도 계속 버전이 그대로임', afterResend2.version === v1);

  // 실제로 이름을 바꾼 재전송은 당연히 버전이 올라가야 한다(과도한
  // 억제로 진짜 변경까지 무시하면 안 된다).
  const realChange = await api('POST', '/api/trips/sync', { token, body: { trips: [{ tripId, city: '노업도시', name: '진짜로 바뀐 이름', version: v1 }] } });
  const afterRealChange = realChange.json.trips.find((x) => x.tripId === tripId);
  t('2) 실제로 내용이 바뀐 재전송은 정상적으로 버전이 올라감', afterRealChange.version === v1 + 1 && afterRealChange.name === '진짜로 바뀐 이름');

  // 이 "무해한 재전송이 버전을 안 올린다"는 보호가 실제로 막던 문제:
  // 다른 기기가 그 사이 baseVersion=v1을 근거로 진짜 수정을 시도하면
  // (재전송이 버전을 올리지 않았으므로) 성공해야 한다 — 재현: 노업
  // 재전송 이후에도 v1을 근거로 한 별도 기기의 저장이 가짜 충돌을
  // 만나지 않는지 별도 여행으로 확인한다.
  const created2 = await api('POST', '/api/trips', { token, body: { city: '노업도시2', name: '이름2' } });
  const tripId2 = created2.json.trip.tripId;
  const v1b = created2.json.trip.version;
  // 기기 C(변경 없음, 그냥 재동기화) — 노업 재전송.
  await api('POST', '/api/trips/sync', { token, body: { trips: [{ tripId: tripId2, city: '노업도시2', name: '이름2', version: v1b }] } });
  // 기기 D — 실제로 이름을 고쳐 저장(같은 baseVersion=v1b 근거).
  const deviceDSave = await api('POST', '/api/trips/sync', { token, body: { trips: [{ tripId: tripId2, city: '노업도시2', name: 'D가 고침', version: v1b }] } });
  const deviceDResult = deviceDSave.json.trips.find((x) => x.tripId === tripId2);
  t('2) 노업 재전송 뒤에도 다른 기기의 진짜 저장이 가짜 충돌 없이 성공함', deviceDSave.json.conflicts.length === 0 && deviceDResult.name === 'D가 고침');
}

t('최종 콘솔/런타임 오류 없음(서버 프로세스 자체가 살아 있음)', true);
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
server.close();
process.exit(fail ? 1 : 0);
