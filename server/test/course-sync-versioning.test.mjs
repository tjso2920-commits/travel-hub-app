'use strict';
/**
 * 2026-09-22(18차 재검토) 2·3절 — 날짜별 코스 동기화의 되돌리기·동시 수정.
 *
 * 재현하려는 결함(재검토 원문):
 *  (a) 기존 날짜의 장소를 코스가 없던 새 날짜로 옮김 → 동기화 → 되돌리기.
 *      클라이언트는 옛 배열로 돌아가지만 서버는 upsert만 해서 새 날짜 코스가
 *      계속 남는다(레거시 account_courses, 여행 trip_courses 둘 다).
 *  (b) 여행 메타데이터가 같으면 incoming.courses가 버전 검증 없이 덮어써진다
 *      — 두 기기가 같은 날짜 코스를 읽고 A가 고친 뒤 B가 옛 코스를 올리면
 *      conflicts:[]로 A의 수정이 사라진다.
 *
 * 지켜야 할 원칙:
 *  - 삭제는 "명시적 삭제 표시(deleted:true + 기준 버전)"로만 한다. 배열에서
 *    빠졌다는 이유로 다른 기기의 코스를 지우지 않는다.
 *  - 같은 날짜의 충돌은 조용히 덮지 않고 conflicts로 알린다(서버 값 보존).
 *  - 서로 다른 날짜의 수정은 둘 다 보존한다.
 *
 * 실행: node server/test/course-sync-versioning.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';

const { openDb, uuid, nowIso } = await import('../db.mjs');
const { syncCourses, getCourses } = await import('../routes/account-data.mjs');
const { syncTrips, getTripCourses, createTrip, upsertTripCourse, putTripCourses } = await import('../routes/trips.mjs');

let fail = 0; const t = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra && !c ? ' — ' + extra : '')); if (!c) fail++; };
function account(email) {
  const id = uuid();
  openDb().prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}
const stopsOf = (...ids) => ids.map((id) => ({ id, name: id, walk: 5, at: 600, dwell: 40 }));
const byDate = (list) => Object.fromEntries(list.map((c) => [c.date, c]));

// (a-1) 레거시 코스 되돌리기
{
  const acc = account('legacy-undo@example.test');
  let r = syncCourses(acc, [{ city: '후쿠오카', date: '2026-10-05', stops: stopsOf('a', 'b') }]);
  const v1 = byDate(r.courses)['2026-10-05'].version;
  // 옮기기: 10-05에서 b를 빼 10-07(새 날짜)로
  r = syncCourses(acc, [
    { city: '후쿠오카', date: '2026-10-05', stops: stopsOf('a'), version: v1 },
    { city: '후쿠오카', date: '2026-10-07', stops: stopsOf('b') },
  ]);
  const after = byDate(r.courses);
  t('(a-1) 옮기기 동기화 후 서버에 두 날짜', !!after['2026-10-05'] && !!after['2026-10-07']);
  // 되돌리기: 원래 날짜만 재전송(예전 방식) — 배열에서 빠진 것만으로는 안 지워져야 한다
  r = syncCourses(acc, [{ city: '후쿠오카', date: '2026-10-05', stops: stopsOf('a', 'b'), version: after['2026-10-05'].version }]);
  t('(a-1) 배열에서 빠졌다는 이유만으로는 지우지 않음(다른 기기 보호)', !!byDate(r.courses)['2026-10-07']);
  // 명시적 삭제 표시로 되돌리기
  r = syncCourses(acc, [
    { city: '후쿠오카', date: '2026-10-07', deleted: true, version: after['2026-10-07'].version },
  ]);
  t('(a-1) 명시적 삭제 표시로 새 날짜 코스가 서버에서 사라짐', !byDate(r.courses)['2026-10-07'] && r.conflicts.length === 0, JSON.stringify(r.conflicts));
  t('(a-1) 새로 받아도(재로그인·다른 기기) 새 날짜 코스 없음', !byDate(getCourses(acc).courses)['2026-10-07']);
  t('(a-1) 원래 날짜는 되돌린 내용(a,b)', JSON.stringify(byDate(getCourses(acc).courses)['2026-10-05'].stops.map((s) => s.id)) === '["a","b"]');
}

// (a-2) 여행 코스 되돌리기 + (b) 동시 수정
{
  const acc = account('trip-undo@example.test');
  const trip = createTrip(acc, { city: '후쿠오카', name: '가을' }).trip;
  const base = { tripId: trip.tripId, city: '후쿠오카', version: trip.version };
  let r = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-05', city: '후쿠오카', stops: stopsOf('a', 'b') }] }]);
  t('(a-2) 여행 동기화 응답에 날짜별 코스 버전이 온다', Array.isArray(r.courses) && r.courses.some((c) => c.date === '2026-10-05' && c.version >= 1), JSON.stringify(r.courses));
  const v5 = r.courses.find((c) => c.date === '2026-10-05').version;
  r = syncTrips(acc, [{ ...base, courses: [
    { date: '2026-10-05', city: '후쿠오카', stops: stopsOf('a'), version: v5 },
    { date: '2026-10-07', city: '후쿠오카', stops: stopsOf('b') },
  ] }]);
  const moved = byDate(r.courses);
  t('(a-2) 옮기기 후 새 날짜 코스가 서버에 있음', !!moved['2026-10-07']);
  // 예전 방식 재현: 원래 날짜만 재전송
  r = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-05', city: '후쿠오카', stops: stopsOf('a', 'b'), version: moved['2026-10-05'].version }] }]);
  t('(a-2) 배열에서 빠진 날짜는 지우지 않음', !!byDate(getTripCourses(acc, trip.tripId).courses)['2026-10-07']);
  const now5 = byDate(r.courses)['2026-10-05'].version;
  r = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-07', deleted: true, version: moved['2026-10-07'].version }] }]);
  t('(a-2) 명시적 삭제 표시로 새 날짜 코스 삭제', !byDate(getTripCourses(acc, trip.tripId).courses)['2026-10-07'] && r.conflicts.length === 0, JSON.stringify(r.conflicts));
  t('(a-2) 삭제 사실(표시)이 응답에 실려 다른 기기가 지울 수 있음', Array.isArray(r.deletedCourses) && r.deletedCourses.some((d) => d.tripId === trip.tripId && d.date === '2026-10-07'));

  // (b) 같은 날짜 동시 수정 — 두 기기가 같은 버전(now5)을 읽음
  const devA = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-05', city: '후쿠오카', stops: stopsOf('a', 'b', 'c'), version: now5 }] }]);
  t('(b) 기기 A 수정 반영', devA.conflicts.length === 0 && JSON.stringify(byDate(devA.courses)['2026-10-05'].stops.map((s) => s.id)) === '["a","b","c"]');
  const devB = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-05', city: '후쿠오카', stops: stopsOf('z'), version: now5 }] }]);
  const conflict = devB.conflicts.find((c) => c.date === '2026-10-05');
  t('(b) 옛 버전 기준 B의 저장은 충돌로 보고(조용히 덮지 않음)', !!conflict && conflict.tripId === trip.tripId && conflict.serverCourse && JSON.stringify(conflict.serverCourse.stops.map((s) => s.id)) === '["a","b","c"]', JSON.stringify(devB.conflicts));
  t('(b) 서버에는 A의 수정이 그대로', JSON.stringify(byDate(getTripCourses(acc, trip.tripId).courses)['2026-10-05'].stops.map((s) => s.id)) === '["a","b","c"]');

  // 서로 다른 날짜 동시 수정은 둘 다 보존
  let r2 = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-06', city: '후쿠오카', stops: stopsOf('m') }] }]);
  const v6 = byDate(r2.courses)['2026-10-06'].version;
  const cur5 = byDate(r2.courses)['2026-10-05'].version;
  const a2 = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-05', city: '후쿠오카', stops: stopsOf('a'), version: cur5 }] }]);
  const b2 = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-06', city: '후쿠오카', stops: stopsOf('m', 'n'), version: v6 }] }]);
  const final = byDate(getTripCourses(acc, trip.tripId).courses);
  t('서로 다른 날짜 수정은 둘 다 보존(충돌 없음)', a2.conflicts.length === 0 && b2.conflicts.length === 0 && final['2026-10-05'].stops.length === 1 && final['2026-10-06'].stops.length === 2);

  // 옛 버전 기준 삭제는 충돌(다른 기기의 새 수정을 지우지 않음)
  const staleDel = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-06', deleted: true, version: v6 }] }]);
  t('옛 버전 기준 삭제 표시는 충돌로 보고하고 지우지 않음', staleDel.conflicts.some((c) => c.date === '2026-10-06') && !!byDate(getTripCourses(acc, trip.tripId).courses)['2026-10-06']);

  // 여행 메타데이터 충돌이 있어도 날짜별 코스 보호는 독립적으로 동작
  const metaStale = syncTrips(acc, [{ tripId: trip.tripId, city: '후쿠오카', name: '다른 이름', version: 0, courses: [{ date: '2026-10-05', city: '후쿠오카', stops: stopsOf('q'), version: 0 }] }]);
  t('메타 충돌 + 코스 옛 버전 → 둘 다 충돌로 보고, 서버 값 유지', metaStale.conflicts.some((c) => c.serverTrip) && metaStale.conflicts.some((c) => c.date === '2026-10-05') && byDate(getTripCourses(acc, trip.tripId).courses)['2026-10-05'].stops[0].id === 'a');

  // 코스 생성(upsertTripCourse)도 날짜 버전을 올린다 — 옛 기준 저장이 덮지 못함
  const beforeGen = byDate(getTripCourses(acc, trip.tripId).courses)['2026-10-05'].version;
  upsertTripCourse(acc, trip.tripId, '2026-10-05', { date: '2026-10-05', city: '후쿠오카', stops: stopsOf('g1', 'g2') });
  const afterGen = byDate(getTripCourses(acc, trip.tripId).courses)['2026-10-05'].version;
  t('코스 생성 저장도 날짜 버전을 올림', afterGen === beforeGen + 1);
  const staleAfterGen = syncTrips(acc, [{ ...base, courses: [{ date: '2026-10-05', city: '후쿠오카', stops: stopsOf('old'), version: beforeGen }] }]);
  t('생성 직후 옛 기준 저장은 충돌', staleAfterGen.conflicts.some((c) => c.date === '2026-10-05'));
}

// PUT /api/trips/:id/courses 도 같은 규칙(예전엔 전부 지우고 다시 넣었다)
{
  const acc = account('put-courses@example.test');
  const trip = createTrip(acc, { city: '후쿠오카' }).trip;
  putTripCourses(acc, trip.tripId, [{ date: '2026-12-01', stops: ['a'] }, { date: '2026-12-02', stops: ['b'] }]);
  const r = putTripCourses(acc, trip.tripId, [{ date: '2026-12-01', stops: ['z'], version: 0 }]);
  const now = byDate(getTripCourses(acc, trip.tripId).courses);
  t('PUT: 빠진 날짜(12-02)를 지우지 않음', !!now['2026-12-02']);
  t('PUT: 옛 기준으로 기존 날짜를 덮지 않고 충돌로 보고', now['2026-12-01'].stops[0] === 'a' && r.conflicts.some((c) => c.date === '2026-12-01'));
}

// 18차 재검토 2차 — 같은 내용을 키 순서만 바꿔 다시 보내면 버전을 올리지 않는다(거짓 충돌 방지)
{
  const acc = account('key-order@example.test');
  const trip = createTrip(acc, { city: '후쿠오카' }).trip;
  let r = syncTrips(acc, [{ tripId: trip.tripId, city: '후쿠오카', version: trip.version, courses: [{ city: '후쿠오카', date: '2026-12-05', stops: stopsOf('a'), memo: 'm' }] }]);
  const v = byDate(r.courses)['2026-12-05'].version;
  r = syncTrips(acc, [{ tripId: trip.tripId, city: '후쿠오카', version: trip.version, courses: [{ memo: 'm', stops: stopsOf('a'), date: '2026-12-05', city: '후쿠오카', version: v }] }]);
  t('여행 코스: 키 순서만 다른 재전송은 버전 그대로', byDate(r.courses)['2026-12-05'].version === v && r.conflicts.length === 0, JSON.stringify(r.conflicts));
  r = syncTrips(acc, [{ tripId: trip.tripId, city: '후쿠오카', version: trip.version, courses: [{ memo: 'm', stops: stopsOf('a'), date: '2026-12-05', city: '후쿠오카', version: v - 1 }] }]);
  t('여행 코스: 옛 기준이라도 내용이 같으면 충돌 아님', r.conflicts.length === 0);
  let l = syncCourses(acc, [{ city: '후쿠오카', date: '2026-12-06', stops: stopsOf('b'), memo: 'x' }]);
  const lv = byDate(l.courses)['2026-12-06'].version;
  l = syncCourses(acc, [{ memo: 'x', date: '2026-12-06', stops: stopsOf('b'), city: '후쿠오카', version: lv }]);
  t('레거시 코스: 키 순서만 다른 재전송은 버전 그대로', byDate(l.courses)['2026-12-06'].version === lv);
}

// 다른 계정 여행에는 아무 영향 없음
{
  const owner = account('owner@example.test');
  const other = account('other@example.test');
  const trip = createTrip(owner, { city: '후쿠오카' }).trip;
  syncTrips(owner, [{ tripId: trip.tripId, city: '후쿠오카', version: trip.version, courses: [{ date: '2026-11-01', city: '후쿠오카', stops: stopsOf('x') }] }]);
  const v = byDate(getTripCourses(owner, trip.tripId).courses)['2026-11-01'].version;
  syncTrips(other, [{ tripId: trip.tripId, city: '후쿠오카', version: 99, courses: [{ date: '2026-11-01', deleted: true, version: v }] }]);
  t('다른 계정의 삭제 표시는 무시(계정 격리)', !!byDate(getTripCourses(owner, trip.tripId).courses)['2026-11-01']);
}

if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log('\nALL PASS');
