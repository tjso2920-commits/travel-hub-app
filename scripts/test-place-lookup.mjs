/**
 * 실제 위치 확인(로드맵 ⑦) 종단 검증 — 실제 Chromium + 실제 서버(임시 포트).
 *
 * 2026-09-10: "실제 장소 위치 조회와 불확실한 후보 확인"을 화면에서
 * 실제로 눌러 확인한다. 서버는 아직 테스트 어댑터(가짜 좌표, 결정론적)
 * 로 돌지만, 요청→응답→"사람이 직접 확인 후에만 반영" 코드 경로는
 * 실 Google Places 키가 들어와도 그대로 재사용된다 — 어댑터만 바뀐다.
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

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

// 테스트 어댑터는 질의 문자열의 해시로 결정론적 성공/실패를 정한다
// (server/adapters/place-lookup.mjs) — 미리 계산해 둔 값으로 두 경우를
// 각각 재현한다.
await p.evaluate(() => {
  foodMap.lic = { name: 'q', date: '2026-01-01' };
  foodMap.places = [
    // 링크·좌표가 전혀 없어 needsLookup=true, lookupState='no-evidence' —
    // 그래도 이름만으로 서버 조회를 시도할 수 있어야 한다.
    { id: 'nf1', name: '테스트카페', address: '후쿠오카', cat: '카페·디저트', sourceLists: [] },
    { id: 'nf2', name: '이상한장소', address: '어딘가', cat: '기타', sourceLists: [] },
  ];
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);

// --- 서버 조회는 이제 로그인이 필요하다(비용 보호 — 로그인 없이는
// /api/places/lookup을 아예 호출할 수 없다). 로그인 화면을 거친 뒤에는
// 원래 하려던 동작(후보 조회)을 곧바로 이어가야 한다(다른 로그인
// 게이트들과 같은 패턴 — daGateThenBuildCourseSheet 등). ---
await p.evaluate(() => detail('nf1'));
await p.waitForTimeout(150);
const beforeLookupHtml = await p.textContent('#sheetContent');
t('위치 미확인 장소 상세에 "서버로 위치 후보 찾아보기" 버튼이 있음', beforeLookupHtml.includes('서버로 위치 후보 찾아보기'));
await p.click('[data-lookup-place="nf1"]');
await p.waitForTimeout(200);
const loginPromptTitle = await p.textContent('#sheetLabel');
t('로그인 전에는 위치 후보 조회 대신 로그인 화면이 뜸', loginPromptTitle === '로그인');
const testEmail = 'place-lookup-tester@example.com';
await p.fill('#loginEmail', testEmail);
await p.click('#loginSendBtn');
await p.waitForTimeout(200);
const emailSent = sentEmailsForTest.filter((e) => e.to === testEmail).pop();
const code = emailSent.body.match(/(\d{6})/)[1];
await p.fill('#loginCode', code);
await p.click('#loginVerifyBtn');
await p.waitForFunction(() => document.getElementById('sheetLabel').textContent !== '코드 확인', { timeout: 5000 });
await p.waitForTimeout(300);

// --- 후보를 찾는 경우 — 로그인 성공 직후 원래 하려던 조회가 곧바로
// 이어져 별도 재클릭 없이 후보 화면으로 넘어가야 한다. ---
const candTitle = await p.textContent('#sheetLabel');
t('로그인 성공 뒤 원래 하려던 위치 후보 조회로 곧바로 이어짐', candTitle === '위치 확인');
const candHtml = await p.textContent('#sheetContent');
t('후보 화면에 위도/경도가 표시되고, 확정이 아니라는 안내가 함께 있음', /위도 .* 경도/.test(candHtml) && candHtml.includes('확정된 위치가 아닙니다'));
t('"맞아요"를 누르기 전까지는 아직 장소에 좌표가 반영 안 됨', (await p.evaluate(() => foodMap.places.find((x) => x.id === 'nf1').lat)) == null);

await p.click('[data-lookup-confirm^="nf1|"]');
await p.waitForTimeout(200);
const afterConfirm = await p.evaluate(() => foodMap.places.find((x) => x.id === 'nf1'));
t('"맞아요"를 눌러야만 실제로 좌표가 저장됨(자동 반영 아님)', typeof afterConfirm.lat === 'number' && typeof afterConfirm.lng === 'number');
// 2026-09-11 재검토(10차) 5절 — 자동분류 우선순위: 이 확인으로 얻은
// "신뢰 가능한 장소 유형"(테스트 어댑터가 준 ['restaurant','food'])이
// 아직 사용자가 확정하지 않은 이름 기반 짐작(카페·디저트)보다 우선
// 반영돼야 한다.
t('10차 5절) 확인된 유형(공급자 types)이 확정 안 된 이름 기반 짐작보다 우선 반영됨', afterConfirm.cat === '맛집·식당' && Array.isArray(afterConfirm.confirmedTypes) && afterConfirm.confirmedTypes.includes('restaurant'));
const afterConfirmTitle = await p.textContent('#sheetLabel');
t('확인 후 다시 장소 상세로 돌아가 반영된 걸 바로 볼 수 있음', afterConfirmTitle === '내 장소');
const detailHtmlAfter = await p.textContent('#sheetContent');
t('반영 후에는 더 이상 "위치 미확인" 안내가 안 뜸(needsLookup이 실제로 풀림)', !detailHtmlAfter.includes('서버로 위치 후보 찾아보기'));

// --- 후보를 못 찾는 경우 ---
await p.evaluate(() => document.getElementById('close').click());
await p.evaluate(() => detail('nf2'));
await p.waitForTimeout(150);
await p.click('[data-lookup-place="nf2"]');
await p.waitForTimeout(400);
const notFoundHtml = await p.textContent('#sheetContent');
t('후보를 못 찾으면 못 찾았다고 정직하게 안내함(가짜로 지어내지 않음)', notFoundHtml.includes('찾지 못했'));
const nf2After = await p.evaluate(() => foodMap.places.find((x) => x.id === 'nf2').lat);
t('후보를 못 찾은 경우 좌표는 그대로 비어 있음', nf2After == null);
await p.evaluate(() => document.getElementById('close').click());

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));

await b.close();
server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
