/* 날짜별 일정 계산 + 영업시간 판정(2026-09-22, 18차 3절).
 *
 * 화면(spots.js)과 분리한 순수 계산 모듈이다 — 브라우저에서는
 * window.DaySchedule / window.BusinessHours로, Node 테스트에서는
 * vm으로 그대로 불러 같은 코드를 검증한다.
 *
 * 원칙:
 * - 날짜는 'YYYY-MM-DD' 문자열 그대로 다룬다. 요일·날짜 더하기는 전부
 *   Date.UTC로 계산해 이 기기(브라우저)의 시간대와 무관하다 — 한국에서
 *   해외 일정을 짜도 하루 밀리지 않는다.
 * - 시각은 "그 날짜 현지 0시부터 몇 분"이다(1440 이상 = 다음날).
 * - 영업시간 판정은 공급자(Google)가 준 기간(periods)만 쓴다. 업종·
 *   이름으로 추측하지 않는다("이자카야는 저녁" 같은 규칙 없음).
 * - 정보 없음·조회 실패·한도 초과는 절대 "휴무"로 바꿔 말하지 않는다.
 * - 영업 종료 시각은 마지막 주문 시각이 아니다(화면 문구에서 구분).
 */
(function (root) {
  'use strict';
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  const DEFAULT_DWELL_MIN = 40;

  function parseYmd(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function utcOf(ymd) { const p = parseYmd(ymd); return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN; }
  function weekdayOf(ymd) { const t = utcOf(ymd); return Number.isFinite(t) ? new Date(t).getUTCDay() : null; }
  function addDaysYmd(ymd, n) {
    const p = parseYmd(ymd); if (!p) return null;
    return new Date(Date.UTC(p.y, p.m - 1, p.d + n)).toISOString().slice(0, 10);
  }
  function dayDiff(fromYmd, toYmd) { return Math.round((utcOf(toYmd) - utcOf(fromYmd)) / 86400000); }
  function dateLabel(ymd) {
    const p = parseYmd(ymd); if (!p) return '날짜 미정';
    return `${p.m}월 ${p.d}일 (${WD[weekdayOf(ymd)]})`;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function clock(min) {
    if (!Number.isFinite(min)) return '--:--';
    const off = Math.floor(min / 1440);
    const m = ((min % 1440) + 1440) % 1440;
    const s = `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
    return off > 0 ? `다음날 ${s}` : off < 0 ? `전날 ${s}` : s;
  }
  function parseClock(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  /* 코스 생성 화면의 출발 시각 기본값: 오늘(현지)이면 지금 시각을 10분
     단위로 올린 값, 미래 날짜면 09:00. 미래 날짜를 "지금 시각"으로
     강제하던 예전 동작(밤에 내일 코스를 짜면 내일 밤 11시 출발)을 고친다. */
  function defaultDepartureFor(dateYmd, destNow) {
    if (destNow && dateYmd === destNow.ymd) {
      const now = destNow.hour * 60 + destNow.minute;
      return Math.min(23 * 60 + 50, Math.ceil(now / 10) * 10);
    }
    return 9 * 60;
  }

  /* ---------------- 일정 계산 ---------------- */
  function departureOf(c) {
    if (c && Number.isFinite(c.departureMinutes)) return c.departureMinutes;
    if (c && Number.isFinite(c.startMinutes) && c.startMinutes > 0) return c.startMinutes;
    const s0 = c && c.stops && c.stops[0];
    return s0 && Number.isFinite(s0.at) ? Math.max(0, s0.at - (s0.walk || 0)) : 9 * 60;
  }
  /* 출발 시각·이동·머무는 시간·사용자가 정한 방문 시각(fixedAt)으로
     도착 시각을 다시 계산한다. 새 객체를 돌려준다(원본 불변 — 저장
     실패 시 되돌리기 쉽게). fixedAt보다 늦게 도착할 수밖에 없으면
     몰래 앞당기지 않고 lateForFixed로 알린다. */
  function recompute(c) {
    const out = JSON.parse(JSON.stringify(c));
    let t = departureOf(out);
    out.departureMinutes = t;
    // 2026-09-23(18차 재검토 2차) 3절 — 이동시간 미확인 구간이 있으면 그 장소와
    // 뒤 장소들의 도착 시각은 "가장 이른 값"일 뿐 확정이 아니다. 끝까지 추적한다.
    let uncertain = false;
    (out.stops || []).forEach((s) => {
      if (s.walkUnknown) uncertain = true;
      if (uncertain) s.arrivalUncertain = true; else delete s.arrivalUncertain;
      // 이동시간 미확인(walkUnknown)은 0분으로 "확정"하지 않는다 — 계산에는 0을
      // 넣되(가장 이른 도착) 화면이 "미확인·재계산 필요"로 표시한다.
      const arrive = t + (s.walkUnknown ? 0 : (s.walk || 0));
      if (Number.isFinite(s.fixedAt) && s.fixedAt >= arrive) { s.at = s.fixedAt; s.lateForFixed = false; }
      else { s.at = arrive; s.lateForFixed = Number.isFinite(s.fixedAt); }
      s.wait = s.at - arrive;
      const dwell = Number.isFinite(s.dwell) && s.dwell > 0 ? s.dwell : DEFAULT_DWELL_MIN;
      t = s.at + dwell;
    });
    out.endAt = t;
    out.walkTotal = (out.stops || []).reduce((a, s) => a + (s.walkUnknown ? 0 : (s.walk || 0)), 0);
    out.walkUnknownCount = (out.stops || []).filter((s) => s.walkUnknown).length;
    return out;
  }
  function gpsMeters(a, b) {
    const r = Math.PI / 180, a1 = a.lat * r, a2 = b.lat * r, da = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
    const z = Math.sin(da / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dl / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(z), Math.sqrt(1 - z));
  }
  /* 직선거리 × 1.3(길 굴곡 보정) ÷ 분당 75m(시속 4.5km). 유료 경로 계산을
     새로 부르지 않고 "추정"으로 표시한다. */
  function validLatLng(p) {
    return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  }
  function estimateWalk(a, b) {
    // 2026-09-22(18차 재검토) 4절 — 위도만 보던 검사를 위도·경도 둘 다로(경도가
    // 없으면 NaN 분이 나왔다).
    if (!validLatLng(a) || !validLatLng(b)) return null;
    return Math.max(1, Math.round((gpsMeters(a, b) * 1.3) / 75));
  }
  /* 18차 재검토 4절 — 이동시간을 새로 정할 수 없을 때(앞뒤 장소 좌표 없음)
     예전 구간의 시간(예: B→C)이나 0분을 확정값처럼 남기지 않는다. walk는
     비우고 walkUnknown으로 "미확인·재계산 필요"를 표시한다. 유료 경로 계산은
     자동으로 부르지 않는다(사용자가 "새로 만들기"를 눌러야 이용권 1회로 다시 계산). */
  function setWalk(stop, est) {
    if (est != null) { stop.walk = est; stop.walkEstimated = true; delete stop.walkUnknown; }
    else { stop.walk = null; stop.walkUnknown = true; delete stop.walkEstimated; }
  }
  function removeStop(c, stopId, coordsOf) {
    const out = JSON.parse(JSON.stringify(c));
    const idx = out.stops.findIndex((s) => s.id === stopId);
    if (idx < 0) return { ok: false, reason: 'not-in-course' };
    const removed = out.stops[idx];
    const next = out.stops[idx + 1];
    if (next) {
      const from = idx > 0 ? coordsOf(out.stops[idx - 1].id) : out.origin;
      setWalk(next, estimateWalk(from, coordsOf(next.id)));
    }
    out.stops.splice(idx, 1);
    out.edited = true;
    return { ok: true, course: recompute(out), removed };
  }
  /* 다른 날짜로 옮기기 — 도착 날짜의 기존 코스(순서·시각 설정)는 그대로
     두고 맨 뒤에만 붙인다. 도착 날짜에 코스가 없으면 그 장소 하나짜리
     새 코스를 만든다. 사용자가 정한 방문 시각(fixedAt)은 다른 날짜에서
     의미가 없어 옮기지 않는다(메모는 옮긴다). */
  function moveStop(src, stopId, target, targetDate, coordsOf, extras) {
    if (!targetDate || targetDate === src.date) return { ok: false, reason: 'same-date' };
    if (target && (target.stops || []).some((s) => s.id === stopId)) return { ok: false, reason: 'already-in-target' };
    const rem = removeStop(src, stopId, coordsOf);
    if (!rem.ok) return rem;
    const moved = { id: rem.removed.id, name: rem.removed.name, dwell: rem.removed.dwell || DEFAULT_DWELL_MIN, walk: 0, walkEstimated: true };
    if (rem.removed.userHoursNote) moved.userHoursNote = rem.removed.userHoursNote;
    let t;
    if (target) {
      t = JSON.parse(JSON.stringify(target));
      const last = t.stops[t.stops.length - 1];
      const from = last ? coordsOf(last.id) : t.origin;
      setWalk(moved, estimateWalk(from, coordsOf(moved.id)));
      t.stops.push(moved);
      if (Array.isArray(t.excludedIds)) t.excludedIds = t.excludedIds.filter((x) => x !== moved.id);
      t.edited = true;
    } else {
      const here = coordsOf(moved.id);
      // 새 코스: 출발점을 이 장소로 두면 이동 0분이 사실이다. 좌표가 없어 옛
      // 출발점을 쓰면 그 거리는 모르므로 미확인.
      if (validLatLng(here)) { moved.walk = 0; moved.walkEstimated = true; } else setWalk(moved, null);
      t = {
        made: (extras && extras.today) || null,
        date: targetDate, city: src.city, tripId: src.tripId,
        origin: here || src.origin || null, mode: 'walking',
        departureMinutes: departureOf(src), startMinutes: departureOf(src),
        stops: [moved], excludedIds: [], excludedReasons: {},
        routedReal: false, edited: true, source: 'user-edit', totalMeters: 0,
      };
    }
    return { ok: true, source: rem.course, target: recompute(t) };
  }

  /* ---------------- 영업시간 판정 ---------------- */
  function pointMin(p) { return (p.hour || 0) * 60 + (p.minute || 0); }
  function is24hPeriods(periods) {
    return Array.isArray(periods) && periods.length === 1 && periods[0].open && !periods[0].close && periods[0].open.day === 0 && pointMin(periods[0].open) === 0;
  }
  function closeOffsetDays(p) {
    let d = (p.close.day - p.open.day + 7) % 7;
    if (d === 0 && pointMin(p.close) <= pointMin(p.open)) d = 1;
    return d;
  }
  function localFetchYmd(hours) {
    if (hours.fetchedAt && Number.isFinite(hours.utcOffsetMinutes)) {
      const t = Date.parse(hours.fetchedAt);
      if (Number.isFinite(t)) return new Date(t + hours.utcOffsetMinutes * 60000).toISOString().slice(0, 10);
    }
    const cur = hours.current || {};
    const dates = (cur.periods || []).map((p) => p.open && p.open.date).concat(cur.specialDays || []).filter(Boolean).sort();
    return dates[0] || null;
  }
  function currentUsable(hours) {
    const cur = hours.current;
    return !!(cur && ((cur.periods && cur.periods.length) || (cur.specialDays && cur.specialDays.length)));
  }
  /* 2026-09-22(18차 재검토) — 재현된 오류: 공급자는 24시간 영업을 이번 주
     정보(current)에서도 "날짜 없는 일요일 0시 열림·닫힘 없음" 하나로 줄 수
     있다. 예전 코드는 current가 "쓸 수 있다"고 본 뒤 날짜가 일치하는 구간만
     골라 그 날을 통째로 휴무로 판정했다. 이제 current를 세 경우로 나눈다:
       - dated: 날짜가 붙은 구간이 있다 → 그 날짜 범위 안에서만 current로 판정.
       - always: 날짜 없는 24시간 표현 → 특별일이 아닌 날은 24시간.
       - 그 외(날짜 없는 일반 구간 등): current로 날짜를 확정할 수 없음 → 정규로.
     날짜 범위 밖이나 판단 근거가 없는 날은 "휴무"로 확정하지 않고 정규
     영업시간 + "방문 전 재확인"으로 떨어진다. */
  function currentShape(hours) {
    if (!currentUsable(hours)) return { kind: 'none' };
    const cur = hours.current;
    const periods = cur.periods || [];
    const dated = periods.filter((p) => p.open && p.open.date);
    const specials = cur.specialDays || [];
    if (dated.length) {
      // 범위는 여는 날짜뿐 아니라 닫는 날짜까지(여러 날 이어지는 영업).
      const dates = dated.map((p) => p.open.date).concat(dated.map((p) => p.close && p.close.date).filter(Boolean), specials).sort();
      return { kind: 'dated', dated, from: dates[0], to: dates[dates.length - 1] };
    }
    if (is24hPeriods(periods)) return { kind: 'always' };
    if (!periods.length && specials.length) return { kind: 'specials-only' };
    return { kind: 'none' };
  }
  function closeMin(p, ymd, off) {
    if (!p.close) return null;
    if (p.close.date) return dayDiff(ymd, p.close.date) * 1440 + pointMin(p.close);
    const openDayOff = p.open.date ? dayDiff(ymd, p.open.date) : off;
    return openDayOff * 1440 + closeOffsetDays(p) * 1440 + pointMin(p.close);
  }
  /* 방문일 기준 전날·당일·다음날의 영업 구간(분, 방문일 0시 기준). 날짜별로
     "이번 주 정보(current)"로 판정할 수 있으면 그걸, 아니면 정규(regular)를 쓴다.
     여러 날에 걸친 구간(전날부터 이어지는 영업 포함)은 날짜로 직접 계산한다. */
  function intervalsAround(hours, ymd) {
    const out = [];
    const basisByOff = {};
    const start = currentUsable(hours) ? localFetchYmd(hours) : null;
    const shape = currentShape(hours);
    const specials = (hours.current && hours.current.specialDays) || [];
    const regular = (hours.regular && hours.regular.periods) || [];
    const inWindow = (date) => start && dayDiff(start, date) >= 0 && dayDiff(start, date) <= 6;
    const currentOffs = new Set();
    for (const off of [-1, 0, 1]) {
      const date = addDaysYmd(ymd, off);
      const special = specials.includes(date);
      let useCurrent = false;
      if (shape.kind === 'dated') useCurrent = (inWindow(date) || special) && ((date >= shape.from && date <= shape.to) || special);
      else if (shape.kind === 'always') useCurrent = inWindow(date) || special;
      else if (shape.kind === 'specials-only') useCurrent = special;
      if (useCurrent) {
        basisByOff[off] = special ? 'special' : 'current';
        currentOffs.add(off);
        if (shape.kind === 'always' && !special) {
          out.push({ o: off * 1440, c: off * 1440 + 1440, basis: 'current', always: true });
        }
        continue;
      }
      basisByOff[off] = 'regular';
      if (is24hPeriods(regular)) { out.push({ o: off * 1440, c: off * 1440 + 1440, basis: 'regular', always: true }); continue; }
      const wd = weekdayOf(date);
      regular.forEach((p) => {
        if (!p.open || p.open.day !== wd) return;
        const o = off * 1440 + pointMin(p.open);
        const c = p.close ? off * 1440 + closeOffsetDays(p) * 1440 + pointMin(p.close) : null;
        if (c == null) out.push({ o, c: o + 1440 * 7, basis: 'regular', closeUnknown: true });
        else out.push({ o, c, basis: 'regular' });
      });
    }
    // 날짜 붙은 current 구간 — 전날 이전에 시작해 오늘로 이어지는 것도 포함.
    if (shape.kind === 'dated') {
      shape.dated.forEach((p) => {
        const openOff = dayDiff(ymd, p.open.date);
        const o = openOff * 1440 + pointMin(p.open);
        const c0 = closeMin(p, ymd, openOff);
        const closeUnknown = c0 == null || !!(p.close && p.close.truncated);
        const c = c0 == null ? o + 1440 * 7 : c0;
        if (c <= -1440 || o >= 2880) return; // 판정 창(전날~다음날) 밖
        // 구간이 걸친 날 중 current로 판정하는 날이 하나라도 있어야 쓴다.
        const touches = [-1, 0, 1].some((off) => currentOffs.has(off) && o < (off + 1) * 1440 && c > off * 1440);
        if (!touches) return;
        out.push({ o, c, basis: 'current', openTruncated: !!p.open.truncated, closeUnknown });
      });
    }
    // 정규 구간 중 current로 판정하는 날에 걸친 것은 뺀다(같은 날 이중 판정 방지).
    const merged = out.filter((x) => x.basis !== 'regular' || ![-1, 0, 1].some((off) => currentOffs.has(off) && Math.floor(x.o / 1440) === off));
    // 24시간(하루 단위) 조각은 이어 붙여 하나의 구간으로.
    merged.sort((a, b) => a.o - b.o);
    const joined = [];
    for (const x of merged) {
      const last = joined[joined.length - 1];
      if (last && last.always && x.always && last.c >= x.o) { last.c = Math.max(last.c, x.c); continue; }
      joined.push(Object.assign({}, x));
    }
    return { intervals: joined, basisByOff };
  }
  const BASIS_LABEL = {
    special: '특별 영업시간(그날 기준)',
    current: '이번 주 영업시간 기준',
    regular: '정규 영업시간 기준 · 방문 전 재확인',
  };
  function sourceLabel(hours) {
    if (!hours) return '';
    if (hours.source === 'google-places') return 'Google 지도 정보';
    if (hours.source === 'test-adapter') return '합성 테스트 데이터(실제 가게 정보 아님)';
    return '출처 미상';
  }
  /* 그날(방문일 0시~24시에 여는 구간)의 영업시간을 사람이 읽는 한 줄로. */
  function describeDay(hours, ymd) {
    if (!hours || hours.status !== 'ok') return null;
    const { intervals, basisByOff } = intervalsAround(hours, ymd);
    if (intervals.some((x) => x.always && x.o <= 0 && x.c >= 1440)) return '24시간 영업';
    const today = intervals.filter((x) => x.o < 1440 && x.c > 0);
    if (!today.length) return basisByOff[0] === 'special' ? '특별 휴무' : '휴무';
    return today.map((x) => `${x.o < 0 ? '전날부터' : clock(x.o)}–${x.closeUnknown ? '종료 미확인' : clock(x.c)}`).join(', ');
  }
  function evaluateVisit(hours, ymd, at, dwell) {
    const stay = Number.isFinite(dwell) && dwell > 0 ? dwell : DEFAULT_DWELL_MIN;
    if (!hours) return { state: 'not-checked', level: 'none', text: '' };
    if (hours.status === 'unverified-place') return { state: 'unverified', level: 'info', text: '위치 확인이 안 된 곳이라 영업시간을 불러올 수 없어요(휴무라는 뜻이 아니에요)' };
    if (hours.status === 'failed') return { state: 'failed', level: 'info', text: '영업시간을 불러오지 못했어요(휴무라는 뜻이 아니에요)' };
    if (hours.status === 'not-requested') return { state: 'limited', level: 'info', text: '이번에는 영업시간을 확인하지 못했어요(휴무라는 뜻이 아니에요)' };
    // 2026-09-22(18차 재검토) — 폐업·임시 휴업은 시간표 유무와 별개 정보다.
    // 시간표가 없어도(no-hours) 먼저 알린다(예전엔 "정보 없음"이 가렸다).
    if (hours.status === 'ok' || hours.status === 'no-hours') {
      if (hours.businessStatus === 'CLOSED_PERMANENTLY') return { state: 'closed-permanently', level: 'warn', text: '구글 지도에 폐업으로 표시된 곳이에요' };
      if (hours.businessStatus === 'CLOSED_TEMPORARILY') return { state: 'closed-temporarily', level: 'warn', text: '구글 지도에 임시 휴업으로 표시된 곳이에요' };
    }
    if (hours.status === 'no-hours') return { state: 'no-info', level: 'info', text: '등록된 영업시간 정보가 없어요(휴무라는 뜻이 아니에요)' };
    if (hours.status !== 'ok') return { state: 'no-info', level: 'info', text: '영업시간 정보가 없어요' };
    const { intervals, basisByOff } = intervalsAround(hours, ymd);
    const dayOff = Math.max(-1, Math.min(1, Math.floor(at / 1440)));
    const basis = basisByOff[dayOff] || 'regular';
    const base = { basis, basisLabel: BASIS_LABEL[basis], recheck: basis === 'regular' };
    const leave = at + stay;
    const inside = intervals.find((x) => x.o <= at && at < x.c);
    if (inside) {
      // 2026-09-23(18차 재검토 2차) — 도착한 구간에 바로 이어지는 구간(자정에 끊겨
      // 들어온 다음 날 구간 등)까지 이어 "실제로 문이 닫히는 시각"을 구한다.
      // 예전엔 24시간 구간이면 끝을 안 보고 곧바로 "24시간 영업"을 돌려줘,
      // 다음 날 특별 휴무로 자정에 끝나는데도 23:50 도착·40분 체류를 통과시켰다.
      let end = inside.c, closeUnknown = !!inside.closeUnknown, allAlways = !!inside.always;
      for (;;) {
        const next = intervals.find((x) => x !== inside && x.o <= end && x.c > end);
        if (!next) break;
        end = next.c; closeUnknown = closeUnknown || !!next.closeUnknown; allAlways = allAlways && !!next.always;
      }
      const WINDOW_END = 2880; // 판정 창(전날~다음날) 끝 — 그 뒤는 모른다.
      const endOff = Math.floor((end - 1) / 1440) + 1; // 닫힌 뒤 날(휴무 사유 안내용)
      const nextDayNote = basisByOff[endOff] === 'special' ? '(다음 날 특별 휴무)' : '';
      // 닫는 시각이 확인 범위 밖(잘림)이거나 없으면 "시간 부족"을 단정하지 않는다.
      if (closeUnknown) return Object.assign(base, { state: 'open', level: 'ok', text: '영업 중 도착 · 종료 시각은 확인 범위 밖이에요' });
      if (leave > end && end < WINDOW_END) {
        return Object.assign(base, { state: 'closes-during', level: 'warn', text: `도착 ${end - at}분 뒤 ${clock(end)}에 영업 종료${nextDayNote} — 머무는 ${stay}분보다 짧아요` });
      }
      if (allAlways) {
        const endsSoon = end < WINDOW_END && end <= (dayOff + 1) * 1440;
        return Object.assign(base, { state: 'open-24h', level: 'ok', text: endsSoon ? `24시간 영업 · ${clock(end)}까지${nextDayNote}` : '24시간 영업' });
      }
      return Object.assign(base, { state: 'open', level: 'ok', text: `영업 중 도착 · ${clock(end)} 영업 종료` });
    }
    const dayStart = dayOff * 1440, dayEnd = dayStart + 1440;
    const sameDay = intervals.filter((x) => x.o < dayEnd && x.c > dayStart);
    if (!sameDay.length) {
      return Object.assign(base, { state: 'closed-day', level: 'warn', text: basis === 'special' ? '이 날은 특별 휴무로 표시돼 있어요' : '이 날은 휴무예요' });
    }
    const later = sameDay.filter((x) => x.o > at).sort((a, b) => a.o - b.o)[0];
    const earlier = sameDay.filter((x) => x.c <= at).sort((a, b) => b.c - a.c)[0];
    if (later && earlier) return Object.assign(base, { state: 'break', level: 'warn', text: `쉬는 시간이에요 — ${clock(later.o)}에 다시 열어요` });
    if (later) return Object.assign(base, { state: 'before-open', level: 'warn', text: `${clock(later.o)}에 문을 열어요 — ${later.o - at}분 일찍 도착해요` });
    return Object.assign(base, { state: 'after-close', level: 'warn', text: `${clock(earlier.c)}에 영업이 끝나요 — 도착이 늦어요` });
  }
  /* 코스의 한 장소 판정 — 도착 시각이 확정되지 않았으면(앞 구간 이동시간 미확인)
     시각에 따라 달라지는 판정(영업 중·종료 전·쉬는 시간 등)은 보류한다. 그날
     휴무·폐업·정보 없음처럼 시각과 무관한 판정은 그대로 알린다. */
  const TIME_DEPENDENT = new Set(['open', 'open-24h', 'closes-during', 'break', 'before-open', 'after-close']);
  function evaluateStop(hours, ymd, stop) {
    const ev = evaluateVisit(hours, ymd, stop.at, stop.dwell);
    if (!stop.arrivalUncertain || !TIME_DEPENDENT.has(ev.state)) return ev;
    return Object.assign({}, ev, { state: 'arrival-unknown', level: 'info', decided: ev.state,
      text: '도착 시각 미확인(앞 구간 이동시간을 몰라요) — 방문 가능 여부 판단 보류' });
  }
  function googleMapsUrl(name, placeId) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name || '') + (placeId ? '&query_place_id=' + encodeURIComponent(placeId) : '');
  }

  root.DaySchedule = {
    WD, DEFAULT_DWELL_MIN, parseYmd, weekdayOf, addDaysYmd, dayDiff, dateLabel, clock, parseClock,
    defaultDepartureFor, departureOf, recompute, estimateWalk, removeStop, moveStop,
  };
  root.BusinessHours = { evaluateVisit, evaluateStop, describeDay, sourceLabel, googleMapsUrl, BASIS_LABEL, intervalsAround };
})(typeof window !== 'undefined' ? window : globalThis);
