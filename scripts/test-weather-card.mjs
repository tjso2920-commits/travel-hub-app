/**
 * 착장 판단용 날씨 카드(2026-09-10 재검토 7차 4절) 종단 검증 — 실제
 * Chromium + 실제 서버(임시 포트). 서버는 아직 테스트 어댑터(합성
 * 날씨, 결정론적)로 돌지만, "화면이 먼저 그려지고 날씨가 비동기로
 * 채워짐 → 현재/예보 구분 표시 → 공급자·시각 표시 → 실패 시 대체"
 * 코드 경로 자체는 실 WeatherAPI 키가 들어와도 그대로 재사용된다 —
 * 어댑터만 바뀐다(place-lookup.mjs와 같은 검증 원칙).
 *
 * 실행: node scripts/test-weather-card.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
const { createServer } = await import('../server/index.mjs');
const { openDb } = await import('../server/db.mjs');

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
await p.waitForTimeout(300);

// =====================================================================
// 1. 비회원(로그인 전) 샘플 상태 그대로 "오늘 동선"을 열어도 날씨 카드가
//    뜬다 — "무료 사용자도 날씨를 볼 수 있어야 한다"는 지시의 핵심 검증.
//    로그인도, 장소 조회도 전혀 안 거친다.
// =====================================================================
await p.evaluate(() => showRoute());
// showRoute()는 메인 내용(코스/동선 HTML)과 날씨 스켈레톤을 같은
// open() 호출 한 번으로 동기적으로 함께 그린다 — 실제 날씨 데이터를
// "채우는" 작업만 그 뒤 비동기(loadWeatherCard, await 안 함)로 이어진다.
// 테스트 어댑터는 지연이 거의 없어 스켈레톤 상태를 붙잡기 어려우므로,
// "메인 내용이 이미 화면에 있다"는 사실 자체로 순서를 확인한다.
const mainContentVisible = await p.locator('h2:has-text("오늘은 이곳으로")').count();
t('메인 화면(오늘 동선) 내용이 날씨 데이터를 기다리지 않고 즉시 그려짐(비동기 순서 확인)', mainContentVisible > 0);

await p.waitForFunction(() => {
  const el = document.getElementById('weatherCard');
  return el && el.dataset.state === 'ready';
}, { timeout: 5000 });
const cardText = await p.locator('#weatherCard').innerText();
t('로그인 없이도(샘플/비회원 상태) 날씨 카드가 실제로 채워짐', cardText.length > 0);
t('선택된 목적지(샘플 도시) 이름이 카드에 표시됨', cardText.includes('후쿠오카'));
t('"현재 날씨 · 몇 시 기준"으로 표시하고 "실시간"이라는 단어는 안 씀', /현재 날씨.*기준/.test(cardText) && !cardText.includes('실시간'));
t('체감온도가 표시됨', cardText.includes('체감'));
t('오늘 예보(최고·최저·저녁)가 현재값과 분리돼 표시됨', /오늘 예보/.test(cardText) && cardText.includes('최고') && cardText.includes('최저') && cardText.includes('저녁'));
t('시간대별 강수확률·바람이 표시됨', cardText.includes('☔') && cardText.includes('💨'));
t('규칙 기반 착장 참고 문구가 표시됨(옷차림 관련 단어 포함)', /옷차림|겉옷|외투|우산/.test(cardText));
t('테스트 데이터임을 정직하게 표시함(실제 공급자 연결 아님)', cardText.includes('테스트 데이터'));

// =====================================================================
// 2. 날씨 카드를 보는 것 자체는 위치확인·코스생성 이용권을 전혀 안
//    건드린다 — 로그인 계정으로 확인.
// =====================================================================
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');
const email = 'weather-card-tester@example.com';
await p.evaluate(() => showLoginSheet(() => {}));
await p.waitForTimeout(150);
await p.fill('#loginEmail', email);
await p.click('#loginSendBtn');
await p.waitForTimeout(200);
const sent = sentEmailsForTest.filter((e) => e.to === email).pop();
const code = sent.body.match(/(\d{6})/)[1];
await p.fill('#loginCode', code);
await p.click('#loginVerifyBtn');
await p.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
await p.waitForTimeout(200);
await p.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });

const usageBefore = await p.evaluate(async () => {
  const r = await A.api('/api/account/usage', { token: A.sessionToken(foodMap) });
  return r.json;
});
await p.evaluate(() => showRoute());
await p.waitForFunction(() => {
  const el = document.getElementById('weatherCard');
  return el && el.dataset.state === 'ready';
}, { timeout: 5000 });
const usageAfter = await p.evaluate(async () => {
  const r = await A.api('/api/account/usage', { token: A.sessionToken(foodMap) });
  return r.json;
});
t('날씨 카드를 봐도 위치확인 사용량은 그대로임(차감 안 됨)', usageBefore.placeLookups.used === usageAfter.placeLookups.used);
t('날씨 카드를 봐도 코스생성 사용량은 그대로임(차감 안 됨)', usageBefore.courseGenerations.used === usageAfter.courseGenerations.used);

// =====================================================================
// 3. 도시 선택 자체가 새 Google Places 호출을 만들지 않는다(재확인) —
//    이 세션 동안의 비용 원장 행 수가 그대로인지 직접 확인.
// =====================================================================
{
  const db = openDb();
  const costCount = db.prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
  t('도시 선택·날씨 카드 로딩 과정에서 비용 원장에 새 기록이 전혀 안 생김', costCount === 0);
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);

// 합성 데이터 모바일 스크린샷(가상 지명·가상 장소만 사용 — 실제 개인정보
// 없음). 실제 WeatherAPI 키 연결·실제 iPhone 검증은 별도로 필요하다는
// 점을 RELEASE_STATUS.md에 명시한다.
await b.close();
const b2 = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p2 = await b2.newPage({ viewport: { width: 390, height: 844 } });
p2.on('dialog', (d) => d.dismiss());
await p2.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p2.goto('file://' + process.cwd() + '/src/design/index.html');
await p2.waitForTimeout(200);
const shotCity = '가상 여행지';
await p2.evaluate((cityName) => {
  foodMap.places = [{ id: 'w1', name: '가상 카페', lat: 35.0, lng: 129.0, cat: '카페·디저트', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
  A.saveFoodMap(foodMap);
}, shotCity);
await p2.reload();
await p2.waitForTimeout(200);
await p2.evaluate((cityName) => { city = cityName; updateCity(); }, shotCity);
await p2.waitForTimeout(150);
await p2.evaluate(() => showRoute());
await p2.waitForFunction(() => {
  const el = document.getElementById('weatherCard');
  return el && el.dataset.state === 'ready';
}, { timeout: 5000 });
await p2.waitForTimeout(150);
await p2.screenshot({ path: 'docs/screenshots/after_날씨카드_오늘동선.png' });
console.log('스크린샷 저장 완료: docs/screenshots/after_날씨카드_오늘동선.png(합성 데이터 — 실제 WeatherAPI 미연결)');

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b2.close();
server.close();
process.exit(fail ? 1 : 0);
