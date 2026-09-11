/**
 * 2026-09-11 재검토(10차) 8절 — 영어 지원 "구조만" 검증(번역 자체는
 * 범위 밖). 내부 키와 표시 문구 분리, 날짜/시간대와 로케일의 완전한
 * 무관함, 사전 없는 로케일 요청 시 안전하게 무시되는지 확인한다.
 *
 * 실행: node scripts/test-i18n-structure.mjs
 */
import { chromium } from 'playwright';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);

// =====================================================================
// 1) 내부 키와 표시 문구가 분리됨 — 키로 조회하면 문구가 나오고,
//    없는 키는 키 자체(또는 지정한 fallback)를 안전하게 돌려준다.
// =====================================================================
const r1 = await p.evaluate(() => ({
  known: A.t('tags.more'),
  unknownNoFallback: A.t('no.such.key'),
  unknownWithFallback: A.t('no.such.key', '기본값'),
  currentLocale: A.locale,
}));
t('1) 등록된 키는 실제 한국어 문구를 돌려줌', r1.known === '더 보기');
t('1) 등록 안 된 키는 fallback 없이 부르면 키 자체를 안전하게 돌려줌(깨진 화면 방지)', r1.unknownNoFallback === 'no.such.key');
t('1) fallback을 주면 그 값을 돌려줌', r1.unknownWithFallback === '기본값');
t('1) 기본 로케일은 ko', r1.currentLocale === 'ko');

// =====================================================================
// 2) 사전이 없는 로케일로 바꾸려 하면 조용히 실패하고(깨진 화면 방지),
//    기존 로케일이 그대로 유지된다 — "실제 영어 사전이 아직 없다"는
//    사실을 코드가 스스로 인정하는 구조.
// =====================================================================
const r2 = await p.evaluate(() => {
  const setResult = A.setLocale('en'); // 아직 en 사전이 없음(구조만 준비, 번역은 범위 밖).
  return { setResult, localeAfter: A.locale, tagsMoreAfter: A.t('tags.more') };
});
t('2) 사전이 없는 로케일(en) 전환 시도는 실패로 보고됨', r2.setResult === false);
t('2) 전환 실패 후에도 로케일은 그대로 ko로 남음(깨진 화면 방지)', r2.localeAfter === 'ko');
t('2) 문구 조회도 계속 정상 동작함', r2.tagsMoreAfter === '더 보기');

// =====================================================================
// 3) 날짜·시간대는 로케일과 완전히 무관하다 — daSetLocale을 호출해도
//    (설령 성공했더라도) 목적지 시간대 계산 결과는 절대 안 바뀐다.
//    "영어를 고르면 목적지 시간대가 바뀌면 안 된다"는 요구사항의 핵심
//    재현: 로케일 조작 전후로 같은 도시의 destNow 결과가 완전히 같아야
//    한다.
// =====================================================================
const r3 = await p.evaluate(() => {
  const before = A.destNow('도쿄');
  A.setLocale('ko'); // 성공하는 호출이어도(현재 유일한 사전) 시간대엔 전혀 영향이 없어야 한다.
  const after = A.destNow('도쿄');
  return { before, after };
});
t('3) 로케일 재설정 전후로 목적지(도쿄) 날짜·시간이 완전히 동일함(시간대는 로케일과 무관)', JSON.stringify(r3.before) === JSON.stringify(r3.after));

// =====================================================================
// 4) 태그 레지스트리의 id/label 분리(10차 4절)와 동일한 원칙이 화면
//    문구에도 적용됨 — 태그 편집 화면이 실제로 A.t() 키 기반 문구를
//    쓰는지 화면에서 직접 확인한다(하드코딩 문자열이 아니라 사전
//    조회 결과가 그대로 나타나는지).
// =====================================================================
await p.evaluate(() => {
  foodMap.places = [{ id: 'p1', name: '아무 가게', cat: '기타', catConfirmed: false, city: '테스트시티', cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [], tagsConfirmed: false }];
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(200);
await p.evaluate(() => { tagsEditSheet('p1'); });
await p.waitForTimeout(100);
const newInputPlaceholder = await p.locator('#tagsNewInput').getAttribute('placeholder');
const newBtnText = await p.locator('#tagsNewBtn').innerText();
t('4) 태그 편집 화면 입력칸이 사전 조회 문구를 그대로 씀(placeholder)', newInputPlaceholder === '목록에 없으면 새 태그 이름 입력');
t('4) 태그 편집 화면 버튼도 사전 조회 문구를 그대로 씀', newBtnText === '추가');

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
process.exit(fail ? 1 : 0);
