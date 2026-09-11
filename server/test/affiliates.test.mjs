'use strict';
/**
 * 최소 제휴 준비(2026-09-11 재검토 9차 — docs/BUSINESS_DECISIONS.md
 * 7절) 서버 쪽 검증.
 *
 * 실행: node server/test/affiliates.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';

const { AFFILIATE_OFFERS, ALLOWED_AFFILIATE_DOMAINS, activeOffersForCity } = await import('../affiliates.mjs');
const { createServer } = await import('../index.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

// =====================================================================
// 1) 배포 기본 상태 — 실제 승인된 제휴가 없으므로 항상 빈 배열.
// =====================================================================
t('1) 배포 기본 상태에서는 AFFILIATE_OFFERS가 빈 배열임(실제 제휴 미등록)', Array.isArray(AFFILIATE_OFFERS) && AFFILIATE_OFFERS.length === 0);
t('1) 등록된 도시가 없으니 어떤 도시를 물어도 빈 배열이 옴', activeOffersForCity('후쿠오카').length === 0);

// =====================================================================
// 2) 합성(테스트 전용) 항목을 직접 주입해 필터링 로직을 검증한다.
// =====================================================================
{
  ALLOWED_AFFILIATE_DOMAINS.push('esim.example.com');
  AFFILIATE_OFFERS.push(
    { id: 'ok-1', type: 'esim', city: '테스트도시', label: '(테스트) eSIM', url: 'https://esim.example.com/plan', active: true },
    { id: 'inactive-1', type: 'esim', city: '테스트도시', label: '(테스트) 비활성', url: 'https://esim.example.com/off', active: false },
    { id: 'wrong-city-1', type: 'esim', city: '다른도시', label: '(테스트) 다른도시', url: 'https://esim.example.com/x', active: true },
    { id: 'bad-domain-1', type: 'esim', city: '테스트도시', label: '(테스트) 미승인도메인', url: 'https://not-allowed.example.com/x', active: true },
    { id: 'bad-protocol-1', type: 'esim', city: '테스트도시', label: '(테스트) http', url: 'http://esim.example.com/x', active: true },
    { id: 'bad-type-1', type: 'not-a-real-type', city: '테스트도시', label: '(테스트) 잘못된유형', url: 'https://esim.example.com/y', active: true },
  );

  const offers = activeOffersForCity('테스트도시');
  t('2) 활성+허용도메인+정확한 도시인 항목만 통과함', offers.length === 1 && offers[0].id === 'ok-1');
  t('2) 비활성 항목은 제외됨', !offers.some((o) => o.id === 'inactive-1'));
  t('2) 다른 도시 항목은 제외됨', !offers.some((o) => o.id === 'wrong-city-1'));
  t('2) 화이트리스트에 없는 도메인은 제외됨(임의 URL 노출 방지)', !offers.some((o) => o.id === 'bad-domain-1'));
  t('2) https가 아닌 링크는 제외됨', !offers.some((o) => o.id === 'bad-protocol-1'));
  t('2) 허용된 유형(esim/transit/ticket/lodging) 밖은 제외됨', !offers.some((o) => o.id === 'bad-type-1'));
  t('2) 소비자 화면에 필요한 최소 필드만 노출됨(내부 city/active 필드 없음)', Object.keys(offers[0]).sort().join(',') === 'id,label,type,url');
}

// =====================================================================
// 3) /api/affiliates 엔드포인트 — 로그인 불필요, 이용권/비용 원장과
//    무관.
// =====================================================================
{
  const { openDb } = await import('../db.mjs');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const before = { ent: openDb().prepare('SELECT COUNT(*) AS n FROM entitlement_usage').get().n, cost: openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n };
  const res = await fetch(`${base}/api/affiliates?city=${encodeURIComponent('테스트도시')}`); // 의도적으로 Authorization 헤더 없음.
  const json = await res.json();
  const after = { ent: openDb().prepare('SELECT COUNT(*) AS n FROM entitlement_usage').get().n, cost: openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n };

  t('3) 로그인 없이도 200으로 응답함', res.status === 200 && json.ok === true);
  t('3) 주입해 둔 활성 제휴가 실제로 내려옴', Array.isArray(json.offers) && json.offers.length === 1 && json.offers[0].id === 'ok-1');
  t('3) 이용권 사용량 테이블을 전혀 안 건드림', after.ent === before.ent);
  t('3) 비용 원장도 전혀 안 건드림', after.cost === before.cost);

  const empty = await fetch(`${base}/api/affiliates?city=${encodeURIComponent('제휴없는도시')}`).then((r) => r.json());
  t('3) 등록된 제휴가 없는 도시는 정직하게 빈 배열', Array.isArray(empty.offers) && empty.offers.length === 0);

  server.close();
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
