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
    (out.stops || []).forEach((s) => {
      const arrive = t + (s.walk || 0);
      if (Number.isFinite(s.fixedAt) && s.fixedAt >= arrive) { s.at = s.fixedAt; s.lateForFixed = false; }
      else { s.at = arrive; s.lateForFixed = Number.isFinite(s.fixedAt); }
      s.wait = s.at - arrive;
      const dwell = Number.isFinite(s.dwell) && s.dwell > 0 ? s.dwell : DEFAULT_DWELL_MIN;
      t = s.at + dwell;
    });
    out.endAt = t;
    out.walkTotal = (out.stops || []).reduce((a, s) => a + (s.walk || 0), 0);
    return out;
  }
  function gpsMeters(a, b) {
    const r = Math.PI / 180, a1 = a.lat * r, a2 = b.lat * r, da = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
    const z = Math.sin(da / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dl / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(z), Math.sqrt(1 - z));
  }
  /* 직선거리 × 1.3(길 굴곡 보정) ÷ 분당 75m(시속 4.5km). 유료 경로 계산을
     새로 부르지 않고 "추정"으로 표시한다. */
  function estimateWalk(a, b) {
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return null;
    return Math.max(1, Math.round((gpsMeters(a, b) * 1.3) / 75));
  }
  function removeStop(c, stopId, coordsOf) {
    const out = JSON.parse(JSON.stringify(c));
    const idx = out.stops.findIndex((s) => s.id === stopId);
    if (idx < 0) return { ok: false, reason: 'not-in-course' };
    const removed = out.stops[idx];
    const next = out.stops[idx + 1];
    if (next) {
      const from = idx > 0 ? coordsOf(out.stops[idx - 1].id) : out.origin;
      const est = estimateWalk(from, coordsOf(next.id));
      if (est != null) { next.walk = est; next.walkEstimated = true; }
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
      const est = estimateWalk(from, coordsOf(moved.id));
      moved.walk = est != null ? est : 0;
      t.stops.push(moved);
      if (Array.isArray(t.excludedIds)) t.excludedIds = t.excludedIds.filter((x) => x !== moved.id);
      t.edited = true;
    } else {
      const here = coordsOf(moved.id);
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
  /* 방문일 기준 전날·당일·다음날의 영업 구간(분, 방문일 0시 기준). 날짜별로
     "이번 주 정보(current)" 범위 안이면 그걸, 밖이면 정규(regular)를 쓴다. */
  function intervalsAround(hours, ymd) {
    const out = [];
    const basisByOff = {};
    const start = currentUsable(hours) ? localFetchYmd(hours) : null;
    const regular = (hours.regular && hours.regular.periods) || [];
    for (const off of [-1, 0, 1]) {
      const date = addDaysYmd(ymd, off);
      const inCurrent = start && dayDiff(start, date) >= 0 && dayDiff(start, date) <= 6;
      if (inCurrent) {
        const special = (hours.current.specialDays || []).includes(date);
        basisByOff[off] = special ? 'special' : 'current';
        (hours.current.periods || []).forEach((p) => {
          if (!p.open || p.open.date !== date) return;
          const o = off * 1440 + pointMin(p.open);
          let c;
          if (!p.close) c = o + 1440 * 7; // 닫는 시각이 없는 구간 = 계속 영업
          else if (p.close.date) c = dayDiff(ymd, p.close.date) * 1440 + pointMin(p.close);
          else c = off * 1440 + closeOffsetDays(p) * 1440 + pointMin(p.close);
          out.push({ o, c, basis: basisByOff[off], truncated: !!(p.open.truncated || (p.close && p.close.truncated)) });
        });
      } else {
        basisByOff[off] = 'regular';
        // 24시간 영업은 공급자가 "일요일 0시에 열고 닫는 시각 없음" 하나로
        // 준다 — 요일 일치로 거르면 일요일 말고는 전부 빠진다.
        if (is24hPeriods(regular)) { out.push({ o: off * 1440, c: off * 1440 + 1440 * 7, basis: 'regular', truncated: false }); continue; }
        const wd = weekdayOf(date);
        regular.forEach((p) => {
          if (!p.open || p.open.day !== wd) return;
          const o = off * 1440 + pointMin(p.open);
          const c = p.close ? off * 1440 + closeOffsetDays(p) * 1440 + pointMin(p.close) : o + 1440 * 7;
          out.push({ o, c, basis: 'regular', truncated: false });
        });
      }
    }
    out.sort((a, b) => a.o - b.o);
    return { intervals: out, basisByOff };
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
    if (is24hPeriods(hours.regular && hours.regular.periods) && !currentUsable(hours)) return '24시간 영업';
    const { intervals, basisByOff } = intervalsAround(hours, ymd);
    const today = intervals.filter((x) => x.o >= 0 && x.o < 1440);
    const always = intervals.some((x) => x.c - x.o >= 1440 * 7);
    if (always) return '24시간 영업';
    if (!today.length) return basisByOff[0] === 'special' ? '특별 휴무' : '휴무';
    return today.map((x) => `${clock(x.o)}–${clock(x.c)}`).join(', ');
  }
  function evaluateVisit(hours, ymd, at, dwell) {
    const stay = Number.isFinite(dwell) && dwell > 0 ? dwell : DEFAULT_DWELL_MIN;
    if (!hours) return { state: 'not-checked', level: 'none', text: '' };
    if (hours.status === 'unverified-place') return { state: 'unverified', level: 'info', text: '위치 확인이 안 된 곳이라 영업시간을 불러올 수 없어요(휴무라는 뜻이 아니에요)' };
    if (hours.status === 'failed') return { state: 'failed', level: 'info', text: '영업시간을 불러오지 못했어요(휴무라는 뜻이 아니에요)' };
    if (hours.status === 'not-requested') return { state: 'limited', level: 'info', text: '이번에는 영업시간을 확인하지 못했어요(휴무라는 뜻이 아니에요)' };
    if (hours.status === 'no-hours') return { state: 'no-info', level: 'info', text: '등록된 영업시간 정보가 없어요(휴무라는 뜻이 아니에요)' };
    if (hours.status !== 'ok') return { state: 'no-info', level: 'info', text: '영업시간 정보가 없어요' };
    if (hours.businessStatus === 'CLOSED_PERMANENTLY') return { state: 'closed-permanently', level: 'warn', text: '구글 지도에 폐업으로 표시된 곳이에요' };
    if (hours.businessStatus === 'CLOSED_TEMPORARILY') return { state: 'closed-temporarily', level: 'warn', text: '구글 지도에 임시 휴업으로 표시된 곳이에요' };
    const { intervals, basisByOff } = intervalsAround(hours, ymd);
    const dayOff = Math.max(-1, Math.min(1, Math.floor(at / 1440)));
    const basis = basisByOff[dayOff] || 'regular';
    const base = { basis, basisLabel: BASIS_LABEL[basis], recheck: basis === 'regular' };
    const leave = at + stay;
    const inside = intervals.find((x) => x.o <= at && at < x.c);
    if (inside) {
      if (inside.c - inside.o >= 1440 * 7) return Object.assign(base, { state: 'open-24h', level: 'ok', text: '24시간 영업' });
      if (leave > inside.c) {
        return Object.assign(base, { state: 'closes-during', level: 'warn', text: `도착 ${inside.c - at}분 뒤 ${clock(inside.c)}에 영업 종료 — 머무는 ${stay}분보다 짧아요` });
      }
      return Object.assign(base, { state: 'open', level: 'ok', text: `영업 중 도착 · ${clock(inside.c)} 영업 종료` });
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
  function googleMapsUrl(name, placeId) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name || '') + (placeId ? '&query_place_id=' + encodeURIComponent(placeId) : '');
  }

  root.DaySchedule = {
    WD, DEFAULT_DWELL_MIN, parseYmd, weekdayOf, addDaysYmd, dayDiff, dateLabel, clock, parseClock,
    defaultDepartureFor, departureOf, recompute, estimateWalk, removeStop, moveStop,
  };
  root.BusinessHours = { evaluateVisit, describeDay, sourceLabel, googleMapsUrl, BASIS_LABEL, intervalsAround };
})(typeof window !== 'undefined' ? window : globalThis);
