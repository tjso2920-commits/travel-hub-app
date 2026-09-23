/**
 * 2026-09-22(18차) 3절 — 날짜별 일정·영업시간 판정 순수 계산 검증
 * (src/design/day-schedule.js를 vm으로 그대로 불러 같은 코드를 시험한다).
 *
 * 기기 시간대가 달라도(한국·미국 서부·UTC) 날짜·요일이 밀리지 않는지 보기
 * 위해 TZ를 바꿔 자기 자신을 다시 실행한다.
 *
 * 실행: node scripts/test-day-schedule.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'src', 'design', 'day-schedule.js'), 'utf8');

if (!process.env.__DS_CHILD) {
  let failed = 0;
  for (const tz of ['Asia/Seoul', 'America/Los_Angeles', 'UTC']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: tz, __DS_CHILD: '1' }, encoding: 'utf8' });
    process.stdout.write(`\n=== 기기 시간대 ${tz} ===\n` + r.stdout + (r.stderr || ''));
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `\n${failed}개 시간대에서 FAIL` : '\nALL PASS (3개 시간대)');
  process.exit(failed ? 1 : 0);
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const DS = ctx.DaySchedule, BH = ctx.BusinessHours;
let fail = 0; const t = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra != null ? ' — ' + extra : '')); if (!c) fail++; };

// ---- 날짜·요일
t('2026-09-24는 목요일', DS.dateLabel('2026-09-24') === '9월 24일 (목)', DS.dateLabel('2026-09-24'));
t('다음날(월말) 09-30 → 10-01', DS.addDaysYmd('2026-09-30', 1) === '2026-10-01');
t('다음날(연말) 12-31 → 01-01', DS.addDaysYmd('2026-12-31', 1) === '2027-01-01');
t('다음날 09-24 → 09-25(기기 시간대 무관)', DS.addDaysYmd('2026-09-24', 1) === '2026-09-25');
t('출발 기본값: 미래 날짜는 09:00(지금 시각 강제 안 함)', DS.defaultDepartureFor('2026-10-02', { ymd: '2026-09-22', hour: 23, minute: 5 }) === 540);
t('출발 기본값: 오늘이면 지금을 10분 단위 올림', DS.defaultDepartureFor('2026-09-22', { ymd: '2026-09-22', hour: 13, minute: 4 }) === 13 * 60 + 10);
t('시각 표기: 다음날', DS.clock(1440 + 90) === '다음날 01:30');
t('시각 입력 해석', DS.parseClock('09:30') === 570 && DS.parseClock('24:00') === null);

// ---- 일정 재계산
const coords = { a: { lat: 33.590, lng: 130.420 }, b: { lat: 33.593, lng: 130.425 }, c: { lat: 33.600, lng: 130.430 }, d: { lat: 33.58, lng: 130.40 } };
const coordsOf = (id) => coords[id] || null;
const course = {
  date: '2026-09-24', city: '후쿠오카', tripId: 'trip-1', origin: { lat: 33.589, lng: 130.419 }, startMinutes: 600,
  stops: [{ id: 'a', name: 'A', walk: 5, at: 605, dwell: 40 }, { id: 'b', name: 'B', walk: 10, at: 655, dwell: 60 }, { id: 'c', name: 'C', walk: 8, at: 723, dwell: 40 }],
};
const moved = DS.recompute(Object.assign({}, course, { departureMinutes: 540 }));
t('출발 09:00으로 바꾸면 도착이 1시간씩 당겨짐', moved.stops[0].at === 545 && moved.stops[1].at === 595 && moved.stops[2].at === 663, JSON.stringify(moved.stops.map((s) => s.at)));
t('원본 코스는 그대로(되돌리기 가능)', course.stops[0].at === 605);
const fixed = JSON.parse(JSON.stringify(course)); fixed.stops[1].fixedAt = 720;
const fx = DS.recompute(fixed);
t('방문 시각 12:00 지정 → 기다림 반영, 뒤 일정도 밀림', fx.stops[1].at === 720 && fx.stops[1].wait === 65 && fx.stops[2].at === 720 + 60 + 8);
const late = JSON.parse(JSON.stringify(course)); late.stops[1].fixedAt = 600;
const lt = DS.recompute(late);
t('지정 시각보다 늦게 도착할 수밖에 없으면 몰래 앞당기지 않고 알림', lt.stops[1].at === 655 && lt.stops[1].lateForFixed === true);

const rm = DS.removeStop(course, 'b', coordsOf);
t('코스에서 빼기: 한 곳 빠지고 다음 구간은 직선 추정', rm.ok && rm.course.stops.length === 2 && rm.course.stops[1].id === 'c' && rm.course.stops[1].walkEstimated === true);
t('코스에서 빼기: 뺀 장소 정보 반환(장소 자체는 안 지움)', rm.removed.id === 'b');

const target = { date: '2026-09-25', city: '후쿠오카', tripId: 'trip-1', origin: coords.d, departureMinutes: 600, stops: [{ id: 'd', name: 'D', walk: 3, at: 603, dwell: 30, fixedAt: 603 }] };
const mv = DS.moveStop(course, 'c', target, '2026-09-25', coordsOf, { today: '2026-09-22' });
t('다른 날짜로 옮기기: 출발 날짜에서 빠짐', mv.ok && mv.source.stops.map((s) => s.id).join() === 'a,b');
t('다른 날짜로 옮기기: 도착 날짜 기존 코스 그대로 + 맨 뒤에 추가', mv.target.stops.map((s) => s.id).join() === 'd,c' && mv.target.stops[0].at === 603 && mv.target.stops[0].fixedAt === 603);
t('다른 날짜로 옮기기: 옮긴 곳 이동시간은 추정 표시', mv.target.stops[1].walkEstimated === true);
const mvNew = DS.moveStop(course, 'a', null, '2026-09-27', coordsOf, { today: '2026-09-22' });
t('코스가 없는 날짜로 옮기면 한 곳짜리 새 코스', mvNew.ok && mvNew.target.date === '2026-09-27' && mvNew.target.stops.length === 1 && mvNew.target.tripId === 'trip-1');
t('같은 날짜로 옮기기는 거부', DS.moveStop(course, 'a', course, '2026-09-24', coordsOf).ok === false);
t('이미 있는 곳을 그 날짜로 옮기기는 거부(중복 방지)', DS.moveStop(course, 'a', { date: '2026-09-25', stops: [{ id: 'a' }] }, '2026-09-25', coordsOf).reason === 'already-in-target');

// ---- 18차 재검토 4절 — 좌표가 없어 이동시간을 정할 수 없을 때
{
  const cs = { A: null, B: { lat: 33.59, lng: 130.42 }, C: { lat: 33.6, lng: 130.43 } };
  const co = (id) => cs[id];
  const base = { date: '2026-10-05', departureMinutes: 600, origin: { lat: 33.58, lng: 130.41 }, stops: [{ id: 'A', walk: 5, dwell: 30 }, { id: 'B', walk: 12, dwell: 30 }, { id: 'C', walk: 9, dwell: 30 }] };
  const r = DS.removeStop(base, 'B', co);
  const c2 = r.course.stops[1];
  t('4) A 좌표 없음 → B 빼기: C에 옛 B→C 9분을 남기지 않음', c2.walk !== 9 && c2.walkUnknown === true && !c2.walkEstimated, JSON.stringify(c2));
  t('4) 미확인 구간은 합계에 0분으로 확정하지 않고 개수로 알림', r.course.walkUnknownCount === 1 && r.course.walkTotal === 5);
  const tg = { date: '2026-10-06', departureMinutes: 600, stops: [{ id: 'A', walk: 5, dwell: 30 }] };
  const m = DS.moveStop(base, 'C', tg, '2026-10-06', co);
  t('4) 도착 날짜 마지막 장소 좌표 없음 → 옮긴 곳 0분 추정이 아니라 미확인', m.target.stops[1].walkUnknown === true && m.target.stops[1].walk == null, JSON.stringify(m.target.stops[1]));
  const m2 = DS.moveStop(base, 'A', null, '2026-10-07', co);
  t('4) 좌표 없는 곳을 새 날짜로 → 미확인(옛 출발점과의 거리 모름)', m2.target.stops[0].walkUnknown === true);
  const m3 = DS.moveStop(base, 'C', null, '2026-10-08', co);
  t('4) 좌표 있는 곳을 새 날짜로 → 그곳에서 출발(0분, 사실)', m3.target.stops[0].walk === 0 && !m3.target.stops[0].walkUnknown);
  t('4) estimateWalk: 경도 없음·범위 밖은 null(NaN 금지)', DS.estimateWalk({ lat: 1, lng: NaN }, { lat: 1, lng: 2 }) === null && DS.estimateWalk({ lat: 91, lng: 0 }, { lat: 1, lng: 2 }) === null && DS.estimateWalk({ lat: 33.59, lng: 130.42 }, { lat: 33.6, lng: 130.43 }) > 0);
  // 다시 좌표가 생기면(추정 가능) 미확인 표시가 풀린다
  const fixedC = DS.removeStop({ ...base, stops: [{ id: 'B', walk: 5, dwell: 30 }, { id: 'A', walk: 3, dwell: 30 }, { id: 'C', walk: null, walkUnknown: true, dwell: 30 }] }, 'A', co);
  t('4) 앞뒤 좌표가 있으면 추정으로 바뀌고 미확인 해제', fixedC.course.stops[1].walkEstimated === true && !fixedC.course.stops[1].walkUnknown);
}

// ---- 영업시간 판정
const P = (day, h, m, date) => (date ? { day, hour: h, minute: m, date } : { day, hour: h, minute: m });
const every = (fn) => { const o = []; for (let d = 0; d < 7; d++) o.push(...fn(d)); return o; };
const hoursOf = (periods, extra) => Object.assign({ status: 'ok', source: 'google-places', fetchedAt: '2026-01-01T00:00:00Z', utcOffsetMinutes: 540, regular: { periods, specialDays: [], weekdayDescriptions: [] }, current: null }, extra || {});
const thu = '2026-09-24', mon = '2026-09-28', tue = '2026-09-29';

const lunch = hoursOf(every((d) => [{ open: P(d, 11, 0), close: P(d, 15, 0) }]));
t('점심 영업: 12:00 도착 → 영업 중', BH.evaluateVisit(lunch, thu, 720, 40).state === 'open');
t('점심 영업: 14:40 도착·40분 → 종료 전 시간 부족', BH.evaluateVisit(lunch, thu, 880, 40).state === 'closes-during');
t('점심 영업: 10:00 도착 → 오픈 전', BH.evaluateVisit(lunch, thu, 600, 40).state === 'before-open');
t('점심 영업: 16:00 도착 → 영업 종료 후', BH.evaluateVisit(lunch, thu, 960, 40).state === 'after-close');
t('범위 밖 날짜(정규 기준)는 방문 전 재확인 표시', BH.evaluateVisit(lunch, thu, 720, 40).recheck === true && /재확인/.test(BH.evaluateVisit(lunch, thu, 720, 40).basisLabel));
t('영업 종료는 마지막 주문과 구분(문구에 "영업 종료")', /영업 종료/.test(BH.evaluateVisit(lunch, thu, 720, 40).text));

const brk = hoursOf(every((d) => [{ open: P(d, 11, 30), close: P(d, 14, 0) }, { open: P(d, 17, 0), close: P(d, 22, 0) }]));
t('브레이크타임: 15:00 도착 → 쉬는 시간', BH.evaluateVisit(brk, thu, 900, 40).state === 'break');
t('여러 구간 표시', BH.describeDay(brk, thu) === '11:30–14:00, 17:00–22:00', BH.describeDay(brk, thu));

const closedMon = hoursOf(every((d) => (d === 1 ? [] : [{ open: P(d, 10, 0), close: P(d, 19, 0) }])));
t('정기 휴무(월): 월요일 → 휴무', BH.evaluateVisit(closedMon, mon, 720, 40).state === 'closed-day' && BH.describeDay(closedMon, mon) === '휴무');
t('정기 휴무(월): 화요일은 영업', BH.evaluateVisit(closedMon, tue, 720, 40).state === 'open');

const night = hoursOf(every((d) => [{ open: P(d, 18, 0), close: P((d + 1) % 7, 2, 0) }]));
t('자정 넘김: 새벽 01:00 도착(전날 밤 영업분) → 영업 중', BH.evaluateVisit(night, tue, 60, 40).state === 'open');
t('자정 넘김: 당일 23:30 도착·40분 → 영업 중(다음날 02:00 종료)', BH.evaluateVisit(night, tue, 23 * 60 + 30, 40).state === 'open');
t('자정 넘김: 다음날 01:50 도착·40분 → 종료 전 시간 부족', BH.evaluateVisit(night, tue, 1440 + 110, 40).state === 'closes-during');
t('자정 넘김 표기(전날부터 이어지는 영업 포함)', BH.describeDay(night, tue) === '전날부터–02:00, 18:00–다음날 02:00', BH.describeDay(night, tue));

const h24 = hoursOf([{ open: P(0, 0, 0) }]);
t('24시간: 새벽 03:00도 영업', BH.evaluateVisit(h24, thu, 180, 40).state === 'open-24h' && BH.describeDay(h24, thu) === '24시간 영업');

t('정보 없음 ≠ 휴무', BH.evaluateVisit({ status: 'no-hours' }, thu, 720, 40).level === 'info' && !/휴무예요/.test(BH.evaluateVisit({ status: 'no-hours' }, thu, 720, 40).text));
t('조회 실패 ≠ 휴무', BH.evaluateVisit({ status: 'failed' }, thu, 720, 40).state === 'failed');
t('한도로 조회 안 함 ≠ 휴무', BH.evaluateVisit({ status: 'not-requested' }, thu, 720, 40).state === 'limited');
t('위치 미확인 ≠ 휴무', BH.evaluateVisit({ status: 'unverified-place' }, thu, 720, 40).state === 'unverified');
t('조회 전에는 아무 판정도 안 함(업종 추측 없음)', BH.evaluateVisit(null, thu, 720, 40).state === 'not-checked');
t('임시 휴업 표시', BH.evaluateVisit(Object.assign({}, lunch, { businessStatus: 'CLOSED_TEMPORARILY' }), thu, 720, 40).state === 'closed-temporarily');

// 이번 주 정보(current) — 조회 시각 2026-09-22(화) 현지. 목요일 09-24은 특별 휴무.
const cur = hoursOf(every((d) => [{ open: P(d, 11, 0), close: P(d, 15, 0) }]), {
  fetchedAt: '2026-09-22T01:00:00Z', utcOffsetMinutes: 540,
  current: {
    periods: ['2026-09-22', '2026-09-23', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'].map((date) => {
      const wd = DS.weekdayOf(date);
      return { open: P(wd, 12, 0, date), close: P(wd, 14, 0, date) };
    }),
    specialDays: ['2026-09-24'], weekdayDescriptions: [],
  },
});
t('특별 휴무일(목) → 특별 휴무', BH.evaluateVisit(cur, '2026-09-24', 720, 40).state === 'closed-day' && BH.evaluateVisit(cur, '2026-09-24', 720, 40).basis === 'special');
t('이번 주 범위 안(금) → 이번 주 정보 우선(12–14시)', BH.evaluateVisit(cur, '2026-09-25', 11 * 60 + 30, 40).state === 'before-open' && BH.evaluateVisit(cur, '2026-09-25', 11 * 60 + 30, 40).basis === 'current');
t('이번 주 범위 밖(10월) → 정규 기준·재확인', BH.evaluateVisit(cur, '2026-10-08', 11 * 60 + 30, 40).basis === 'regular' && BH.evaluateVisit(cur, '2026-10-08', 11 * 60 + 30, 40).state === 'open');
t('구글 지도 확인 링크는 장소 ID 포함', /query_place_id=ChIJabc/.test(BH.googleMapsUrl('가게', 'ChIJabc')));
t('출처 표시', BH.sourceLabel({ source: 'google-places' }) === 'Google 지도 정보' && /합성/.test(BH.sourceLabel({ source: 'test-adapter' })));

// ---- 18차 재검토: 어댑터가 실제로 돌려주는 current+regular 조합으로 검증
process.env.DB_PATH = ':memory:'; process.env.APP_ENV = 'development';
const { fetchBusinessHours, normalizePlaceDetails } = await import('../server/adapters/business-hours.mjs');
const tokyoToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const nowIso = new Date().toISOString();
async function adapterHours(id) { const r = await fetchBusinessHours(id); return Object.assign({}, r.result, { fetchedAt: nowIso, source: r.source }); }
{
  // 재현 A(지적 원문): 24시간 + fetchedAt 2026-09-22T03:00Z → 09-23 12:00
  const r = await fetchBusinessHours('test-hours-24h');
  const h = Object.assign({}, r.result, { fetchedAt: '2026-09-22T03:00:00Z', source: r.source });
  const ev = BH.evaluateVisit(h, '2026-09-23', 720, 40);
  t('재현A) 어댑터 24시간(current 날짜 없음) → 24시간 영업(휴무 아님)', ev.state === 'open-24h', JSON.stringify(ev));
  t('재현A) describeDay도 24시간', BH.describeDay(h, '2026-09-23') === '24시간 영업', BH.describeDay(h, '2026-09-23'));
  const special = JSON.parse(JSON.stringify(h)); special.current.specialDays = ['2026-09-24'];
  t('재현A-2) 24시간이라도 특별 휴무일은 특별 휴무(무조건 24시간 처리 안 함)', BH.evaluateVisit(special, '2026-09-24', 720, 40).state === 'closed-day' && BH.evaluateVisit(special, '2026-09-24', 720, 40).basis === 'special');
  t('재현A-2) 특별 휴무 다음날은 다시 24시간', BH.evaluateVisit(special, '2026-09-25', 720, 40).state === 'open-24h');
  t('재현A-3) 이번 주 범위 밖 날짜는 정규 24시간 + 재확인 표시', BH.evaluateVisit(h, '2026-10-20', 720, 40).state === 'open-24h' && BH.evaluateVisit(h, '2026-10-20', 720, 40).recheck === true);
}
{
  const b = normalizePlaceDetails('closed', { businessStatus: 'CLOSED_PERMANENTLY' });
  t('재현B) 시간표 없는 폐업 → 폐업 경고가 "정보 없음"보다 먼저', BH.evaluateVisit(b, '2026-09-23', 720, 40).state === 'closed-permanently');
  const tmp = normalizePlaceDetails('tmp', { businessStatus: 'CLOSED_TEMPORARILY', regularOpeningHours: { periods: [{ open: { day: 3, hour: 9, minute: 0 }, close: { day: 3, hour: 18, minute: 0 } }] } });
  t('재현B) 시간표 있는 임시 휴업 → 임시 휴업 경고(영업 중이라고 안 함)', BH.evaluateVisit(tmp, '2026-09-23', 720, 40).state === 'closed-temporarily');
  const op = normalizePlaceDetails('op', { businessStatus: 'OPERATIONAL' });
  t('재현B) 영업 중 표시인데 시간표 없음 → 정보 없음(휴무 아님)', BH.evaluateVisit(op, '2026-09-23', 720, 40).state === 'no-info');
}
{
  const d = (n) => DS.addDaysYmd(tokyoToday, n);
  const ov = await adapterHours('test-hours-overnight');
  t('어댑터 자정넘김) 오늘 새벽 01:00은 전날 밤 영업분으로 영업 중(이번 주 기준)', BH.evaluateVisit(ov, d(1), 60, 30).state === 'open' && BH.evaluateVisit(ov, d(1), 60, 30).basis === 'current', JSON.stringify(BH.evaluateVisit(ov, d(1), 60, 30)));
  const sp = await adapterHours('test-hours-special');
  t('어댑터 특별휴무) 오늘은 특별 휴무', BH.evaluateVisit(sp, d(0), 720, 40).state === 'closed-day' && BH.evaluateVisit(sp, d(0), 720, 40).basis === 'special');
  t('어댑터 특별휴무) 내일은 점심 영업', BH.evaluateVisit(sp, d(1), 720, 40).state === 'open');
  const cm = await adapterHours('test-hours-closed-mon');
  const monOff = [0, 1, 2, 3, 4, 5, 6].find((i) => DS.weekdayOf(d(i)) === 1);
  t('어댑터 정기휴무) 이번 주 월요일은 휴무', BH.evaluateVisit(cm, d(monOff), 720, 40).state === 'closed-day');
}
{
  const reg = { periods: [{ open: { day: 3, hour: 10, minute: 0 }, close: { day: 3, hour: 20, minute: 0 } }] };
  const empty = { status: 'ok', fetchedAt: '2026-09-22T03:00:00Z', utcOffsetMinutes: 540, regular: reg, current: { periods: [], specialDays: [] } };
  const ev = BH.evaluateVisit(empty, '2026-09-23', 720, 40);
  t('빈 current periods → 휴무로 단정하지 않고 정규 기준·재확인', ev.state === 'open' && ev.recheck === true, JSON.stringify(ev));
  // current가 23~24일만 있고 25일은 범위 안이지만 자료 없음 → 휴무 단정 금지
  const partial = { status: 'ok', fetchedAt: '2026-09-22T03:00:00Z', utcOffsetMinutes: 540, regular: { periods: [4, 5].map((wd) => ({ open: { day: wd, hour: 10, minute: 0 }, close: { day: wd, hour: 20, minute: 0 } })) },
    current: { periods: ['2026-09-23', '2026-09-24'].map((dt) => ({ open: { day: DS.weekdayOf(dt), hour: 10, minute: 0, date: dt }, close: { day: DS.weekdayOf(dt), hour: 20, minute: 0, date: dt } })), specialDays: [] } };
  const e25 = BH.evaluateVisit(partial, '2026-09-25', 720, 40);
  t('current 자료가 끝난 뒤 날짜 → 정규 기준·재확인(휴무 단정 안 함)', e25.state === 'open' && e25.recheck === true, JSON.stringify(e25));
  // 확인 범위 끝에서 잘린 구간: 닫는 시각이 잘림 → "시간 부족" 단정 안 함
  const trunc = { status: 'ok', fetchedAt: '2026-09-22T03:00:00Z', utcOffsetMinutes: 540, regular: null,
    current: { periods: [{ open: { day: 1, hour: 22, minute: 0, date: '2026-09-28' }, close: { day: 2, hour: 0, minute: 0, date: '2026-09-29', truncated: true } }], specialDays: [] } };
  const et = BH.evaluateVisit(trunc, '2026-09-28', 23 * 60 + 30, 90);
  t('잘린 구간(닫는 시각 확인 범위 밖) → 종료 시각 미확인, 시간 부족 단정 안 함', et.state === 'open' && /확인 범위 밖/.test(et.text), JSON.stringify(et));
  // 여러 날 이어지는 영업(이틀 전 열어 내일 닫음)
  const multi = { status: 'ok', fetchedAt: '2026-09-22T03:00:00Z', utcOffsetMinutes: 540, regular: null,
    current: { periods: [{ open: { day: 2, hour: 9, minute: 0, date: '2026-09-22' }, close: { day: 5, hour: 18, minute: 0, date: '2026-09-25' } }], specialDays: [] } };
  t('전날 이전부터 이어지는 영업 → 영업 중', BH.evaluateVisit(multi, '2026-09-24', 720, 40).state === 'open');
}

if (fail) { console.log(`${fail} FAIL`); process.exit(1); }
console.log('ok');
