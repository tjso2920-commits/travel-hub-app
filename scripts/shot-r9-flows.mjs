/**
 * 2026-09-11 재검토(9차) — 이번 라운드에서 새로 화면에 연결한 것들만
 * 합성 데이터로 찍는다(실제 장소명·개인정보 없음). 이 스크린샷은
 * 화면 자체가 실제 데이터로 그려지는지만 보여줄 뿐, 실제 iPhone
 * 기기·실제 공급자 연결·실제 방송 검증이 아니다(docs/RELEASE_STATUS.md
 * 참고).
 *
 * 실행: node scripts/shot-r9-flows.mjs
 * 출력: docs/screenshots/after_9차_*.png (모바일 390x844)
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
const { createServer } = await import('../server/index.mjs');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
p.on('dialog', (d) => d.dismiss());
await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);

// =====================================================================
// 1. 정렬 + 세부 태그 필터가 붙은 저장 목록 화면(6-1/6-2절).
// =====================================================================
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);
await p.evaluate(() => {
  const cityName = '가상 여행지';
  foodMap.places = [
    { id: 'v1', name: '(합성) 스미비 야키토리', cat: '바·이자카야', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: ['야키토리', '이자카야'], tagsConfirmed: true, firstAddedAt: '2024-06-01T00:00:00.000Z' },
    { id: 'v2', name: '(합성) 스시 마사', cat: '맛집·식당', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: ['스시'], tagsConfirmed: true, firstAddedAt: '2024-06-02T00:00:00.000Z' },
    { id: 'v3', name: '(합성) 이름만있는가게', cat: '기타', catConfirmed: false, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [], tagsConfirmed: false, firstAddedAt: '2024-01-01T00:00:00.000Z' },
  ];
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(200);
await p.evaluate(() => { city = '가상 여행지'; updateCity(); });
await p.waitForTimeout(200);
await p.click('#tagFilters button:has-text("야키토리")').catch(() => {});
await p.waitForTimeout(150);
await p.screenshot({ path: 'docs/screenshots/after_9차_정렬및태그.png' });
console.log('저장 완료: docs/screenshots/after_9차_정렬및태그.png');
await p.evaluate(() => { document.querySelectorAll('#tagFilters button.active').forEach((b) => b.click()); }); // 필터 해제.

// =====================================================================
// 2. "불편함 보내기" 시트(6-4절).
// =====================================================================
await p.evaluate(() => { profile(); });
await p.waitForTimeout(150);
await p.click('[data-feedback-open]');
await p.waitForTimeout(150);
await p.selectOption('#fbType', 'import');
await p.fill('#fbDesc', '(합성 데이터) ZIP 가져오기가 중간에 멈춰요');
await p.screenshot({ path: 'docs/screenshots/after_9차_불편함보내기.png' });
console.log('저장 완료: docs/screenshots/after_9차_불편함보내기.png');
await p.evaluate(() => { sheet.close(); });

// =====================================================================
// 3. 테스트 위치 배너 + 프로필 화면(6-3절).
// =====================================================================
await p.goto('file://' + process.cwd() + '/src/design/index.html?testmode=1');
await p.waitForTimeout(200);
await p.evaluate(() => { A.setTestLocation({ lat: 33.5904, lng: 130.4207, label: '하카타역(테스트)' }); });
await p.reload();
await p.waitForTimeout(200);
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(50);
await p.screenshot({ path: 'docs/screenshots/after_9차_테스트위치_배너.png' });
console.log('저장 완료: docs/screenshots/after_9차_테스트위치_배너.png');
await p.evaluate(() => { profile(); });
await p.waitForTimeout(150);
await p.screenshot({ path: 'docs/screenshots/after_9차_테스트위치.png' });
console.log('저장 완료: docs/screenshots/after_9차_테스트위치.png');

await b.close();
server.close();
console.log('\n※ 전부 합성 데이터 화면입니다 — 실제 iPhone 기기·실제 공급자 연결·실제 방송 검증이 아닙니다.');
