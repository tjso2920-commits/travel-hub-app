/**
 * 최소 제휴 준비(2026-09-11 재검토 9차) 종단 검증 — 실제 Chromium +
 * 실제 서버. 배포 기본 상태(등록된 제휴 없음)에서 섹션이 실제로
 * 숨겨지는지, 그리고 서버에 합성 데이터를 주입했을 때 화면에 뜨고
 * 클릭이 실제로 기록되는지를 확인한다.
 *
 * 실행: node scripts/test-affiliates.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
const { createServer } = await import('../server/index.mjs');
const { openDb } = await import('../server/db.mjs');
const affiliatesModule = await import('../server/affiliates.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());
await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);

// =====================================================================
// 1. 배포 기본 상태 — 실제 등록된 제휴가 없으니 "코스 결과" 화면에
//    제휴 섹션이 전혀 안 보여야 한다(가짜 "곧 열립니다" 자리도 없음).
// =====================================================================
// showSavedCourse()가 제휴 섹션을 실제로 붙이는지만 확인하면 되므로,
// 로그인·실제 경로 계산을 전부 거치는 무거운 "코스 만들기" 흐름
// 대신 이미 완성된 코스 하나를 직접 채워 넣고 그 결과 화면(showSavedCourse)
// 을 곧바로 연다(실제 코스 생성 자체는 scripts/test-course-generation.mjs
// 가 이미 검증한다 — 이 테스트의 관심사는 제휴 섹션 배선뿐이다).
await p.evaluate(() => {
  const cityName = '후쿠오카';
  foodMap.places = [{ id: 'w1', name: '가상 장소', lat: 33.5902, lng: 130.4017, cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
  foodMap.course = {
    city: cityName, date: '2026-09-11', stops: [{ id: 'w1', at: 600, walk: 0, dwell: 60 }],
    excludedIds: [], excludedReasons: {}, totalMeters: 0, walkTotal: 0, endAt: 660, routedReal: false,
  };
  foodMap.courses = [foodMap.course];
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(200);
await p.evaluate(() => { city = '후쿠오카'; showSavedCourse(); });
await p.waitForTimeout(300);
const sectionBefore = await p.locator('#affiliateSection').isHidden().catch(() => true);
t('1) 실제 등록된 제휴가 없는 기본 배포 상태에서는 섹션이 숨겨짐', sectionBefore === true);
t('1) 숨겨진 상태에서도 안내 문구를 안 지어냄(내용이 비어 있음)', (await p.locator('#affiliateSection').innerHTML()) === '');

// =====================================================================
// 2. 서버에 합성(테스트 전용) 제휴 데이터를 주입하면 실제로 뜬다.
// =====================================================================
affiliatesModule.ALLOWED_AFFILIATE_DOMAINS.push('esim.example.com');
affiliatesModule.AFFILIATE_OFFERS.push({
  id: 'test-esim-1', type: 'esim', city: '후쿠오카', label: '(테스트) 일본 eSIM 7일권', url: 'https://esim.example.com/jp-7d', active: true,
});
await p.evaluate(() => { sheet.close(); showSavedCourse(); });
await p.waitForTimeout(300);
t('2) 합성 데이터 주입 후 섹션이 실제로 나타남', await p.locator('#affiliateSection').isVisible());
const rowHref = await p.locator('.affiliate-row').getAttribute('href');
t('2) 등록한 링크가 그대로 노출됨', rowHref === 'https://esim.example.com/jp-7d');
const rel = await p.locator('.affiliate-row').getAttribute('rel');
const target = await p.locator('.affiliate-row').getAttribute('target');
t('2) 새 창(target=_blank)+안전한 rel(noopener noreferrer)로 열림', target === '_blank' && rel.includes('noopener') && rel.includes('noreferrer'));
t('2) "제휴 링크" 표시가 붙어 있음', (await p.locator('.affiliate-tag').innerText()).includes('제휴'));

// =====================================================================
// 3. 클릭 사실만 기록된다(예약/매출 아님) — events 테이블에 실제로
//    쌓이는지 서버 DB로 직접 확인한다.
// =====================================================================
const beforeCount = openDb().prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'affiliate_click'").get().n;
// 실제로 새 창이 열리는 걸 막기 위해 클릭 직전 target을 잠깐 제거하고
// 클릭 후 복원한다(테스트 환경에서 새 탭 관리가 불필요하게 복잡해지는
// 것을 피하기 위함 — 실제 배포 코드는 그대로 target=_blank를 쓴다).
await p.evaluate(() => { document.querySelector('.affiliate-row').removeAttribute('target'); });
await p.evaluate(() => { document.querySelector('.affiliate-row').addEventListener('click', (e) => e.preventDefault(), { once: true, capture: true }); });
await p.click('.affiliate-row');
await p.waitForTimeout(200);
const afterCount = openDb().prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'affiliate_click'").get().n;
t('3) 클릭 시 affiliate_click 이벤트가 실제로 기록됨', afterCount === beforeCount + 1);
const lastEvent = JSON.parse(openDb().prepare("SELECT props FROM events WHERE name = 'affiliate_click' ORDER BY occurred_at DESC LIMIT 1").get().props);
t('3) 기록된 속성에 도시명·URL 등 개인/위치 정보 없이 offer_type만 있음', Object.keys(lastEvent).join(',') === 'offer_type' && lastEvent.offer_type === 'esim');

// =====================================================================
// 4. 제휴 유무와 코스 생성 로직이 완전히 분리돼 있음을 정적으로도
//    확인한다 — affiliates.js가 코스 계산 코드를 아예 참조하지 않음.
// =====================================================================
const fs = await import('node:fs');
const affiliatesSrc = fs.readFileSync('src/design/affiliates.js', 'utf8');
t('4) 클라이언트 제휴 모듈이 코스 생성 코드(CourseGen)를 전혀 참조하지 않음', !affiliatesSrc.includes('CourseGen'));
const affiliatesServerSrc = fs.readFileSync('server/affiliates.mjs', 'utf8');
const importLines = affiliatesServerSrc.split('\n').filter((l) => /^\s*import\s/.test(l));
t('4) 서버 제휴 모듈에 import 문 자체가 없음(코스 생성 서버 코드를 참조할 방법이 없음)', importLines.length === 0);

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
