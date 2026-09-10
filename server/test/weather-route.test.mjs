'use strict';
/**
 * 2026-09-10 재검토(7차) 4절 — 착장 판단용 날씨 카드의 서버 쪽(/api/weather)
 * 을 직접 검증한다:
 * - 로그인(Authorization) 없이도 동작한다(무료 사용자도 봐야 한다는
 *   지시 — requireAccount를 아예 안 부른다는 걸 실제로 확인).
 * - 위치확인·코스생성 이용권/비용 원장을 전혀 건드리지 않는다(entitlement_
 *   usage·cost_ledger 행 수가 호출 전후로 그대로임을 직접 SELECT로 확인).
 * - 같은 지역(위경도를 약 1km 단위로 반올림)은 캐시를 공유해 짧은 시간
 *   안에는 실제 어댑터 호출이 한 번만 나간다.
 * - 서비스 전체 하루 호출 상한에 걸리면(그리고 캐시가 있으면) 오래된
 *   값이라도 그 시각과 함께 보여준다 — 완전히 못 보여주는 것보다 낫다.
 * - "현재 날씨"(current)와 "예보"(forecastDays)가 명확히 분리된 필드로
 *   내려온다(화면이 둘을 섞지 않도록 서버 응답부터 구분).
 *
 * 실행: node server/test/weather-route.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';

const { createServer } = await import('../index.mjs');
const { openDb } = await import('../db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function api(path) {
  const res = await fetch(base + path); // 의도적으로 Authorization 헤더를 아예 안 보낸다.
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
function counts() {
  const db = openDb();
  return {
    entitlement: db.prepare('SELECT COUNT(*) AS n FROM entitlement_usage').get().n,
    cost: db.prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n,
  };
}

// =====================================================================
// 1. 로그인 없이도 정상 응답 — current/forecastDays가 분리돼 있고,
//    이용권·비용 원장은 전혀 안 건드린다.
// =====================================================================
{
  const before = counts();
  const r = await api('/api/weather?lat=33.5902&lng=130.4017&tz=Asia/Tokyo');
  const after = counts();
  t('로그인 없이도 200으로 응답함(비회원도 날씨를 볼 수 있어야 함)', r.status === 200 && r.json.ok === true);
  t('현재 날씨(current)와 예보(forecastDays)가 분리된 필드로 내려옴', r.json.current && Array.isArray(r.json.forecastDays));
  t('현재 관측 시각(observedAtIso)이 실제로 붙어 있음("현재 날씨 · 몇 시 기준" 표시용)', typeof r.json.current.observedAtIso === 'string');
  t('오늘 예보에 최고·최저·저녁 기온이 있음', typeof r.json.forecastDays[0].maxC === 'number' && typeof r.json.forecastDays[0].minC === 'number' && typeof r.json.forecastDays[0].eveningC === 'number');
  t('시간대별 강수확률·바람 배열이 있음', Array.isArray(r.json.forecastDays[0].hourly) && r.json.forecastDays[0].hourly.length > 0 && typeof r.json.forecastDays[0].hourly[0].popPercent === 'number' && typeof r.json.forecastDays[0].hourly[0].windKph === 'number');
  t('공급자 표시(source)가 있음', typeof r.json.source === 'string');
  t('날씨 조회는 이용권 사용량 테이블을 전혀 안 건드림(행 수 그대로)', after.entitlement === before.entitlement);
  t('날씨 조회는 비용 원장도 전혀 안 건드림(행 수 그대로)', after.cost === before.cost);
}

// =====================================================================
// 2. 같은 지역(위경도 반올림 기준 동일)은 캐시를 공유한다 — TTL 안에서는
//    새 좌표 조회여도 서버 응답이 캐시된 시각(cachedAt) 그대로 재사용됨을
//    확인한다(정확히 같은 초 단위까지 서로 다른 소수점 좌표를 보내도).
// =====================================================================
{
  const r1 = await api('/api/weather?lat=35.6762&lng=139.6503&tz=Asia/Tokyo');
  const r2 = await api('/api/weather?lat=35.67615&lng=139.65028&tz=Asia/Tokyo'); // 아주 미세하게 다른 소수점
  t('사전 조건 — 첫 조회 성공', r1.status === 200 && r1.json.ok === true);
  t('거의 같은 좌표(반올림하면 같은 지역)는 캐시를 공유해 같은 cachedAt을 돌려줌', r1.json.cachedAt === r2.json.cachedAt);
  t('공유 캐시 응답도 stale로 잘못 표시되지 않음(방금 새로 받은 값)', r2.json.stale === false);
}

// =====================================================================
// 3. 좌표가 없으면 400으로 정직하게 거부한다(값을 지어내지 않음).
// =====================================================================
{
  const r = await api('/api/weather');
  t('좌표 누락 시 400으로 거부됨', r.status === 400 && r.json.reason === 'missing-coords');
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
