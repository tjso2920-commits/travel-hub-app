/**
 * 2026-09-11 재검토(10차) 4절 — 분류 체계 세계 공통화 + 태그 레지스트리
 * 구조 검증. ChatGPT가 실제로 재현한 두 오분류(부분 문자열 겹침,
 * 부정문 오인)를 먼저 확인하고, 새로 도입한 태그 CRUD(생성·이름
 * 수정·삭제·일괄 편집)가 데이터를 파괴하지 않는지 확인한다.
 *
 * 실행: node scripts/test-classification-registry.mjs
 */
import { chromium } from 'playwright';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);

// =====================================================================
// 1) ChatGPT 재현 — 居酒屋의 부분 문자열(酒屋)이 주류샵으로 잘못 겹쳐
//    잡히던 결함이 고쳐짐. 焼鳥 居酒屋도 야키토리+이자카야만 잡히고
//    주류샵은 안 붙는다.
// =====================================================================
const r1 = await p.evaluate(() => ({
  a: A.inferTags('居酒屋'),
  b: A.inferTags('焼鳥 居酒屋'),
  stillDetectsRealLiquorShop: A.inferTags('田中酒屋'),
}));
t('1) 居酒屋는 이자카야만 잡히고 주류샵으로 잘못 안 겹침', JSON.stringify(r1.a) === JSON.stringify(['이자카야']));
t('1) 焼鳥 居酒屋도 야키토리+이자카야만 잡히고 주류샵 오탐 없음', r1.b.includes('야키토리') && r1.b.includes('이자카야') && !r1.b.includes('주류샵'));
t('1) 진짜 주류샵(居로 안 시작하는 酒屋)은 여전히 정상 인식됨(과도한 수정 아님)', r1.stillDetectsRealLiquorShop.includes('주류샵'));

// =====================================================================
// 2) ChatGPT 재현 — "스시 말고 라멘 먹기" 같은 부정·계획 문장에서 실제로
//    뺀 항목을 업종 근거로 오인하지 않음(라멘만 남고 스시는 제외).
// =====================================================================
const r2 = await p.evaluate(() => ({
  negated: A.inferTags('스시 말고 라멘 먹기'),
  reversed: A.inferTags('라멘 말고 스시 먹기'),
  noNegation: A.inferTags('스시랑 라멘 다 파는 집'),
}));
t('2) "스시 말고 라멘"은 라멘만 남고 스시는 제외됨', JSON.stringify(r2.negated) === JSON.stringify(['라멘']));
t('2) 순서를 바꿔도("라멘 말고 스시") 대칭적으로 올바르게 처리됨', JSON.stringify(r2.reversed) === JSON.stringify(['스시']));
t('2) 부정 표현이 없으면 여전히 둘 다 정상적으로 태그됨(과도한 억제 아님)', r2.noNegation.includes('스시') && r2.noNegation.includes('라멘'));

// =====================================================================
// 3) 태그 레지스트리 — 21개는 시작 어휘일 뿐 허용 목록 전체가 아니다.
//    사용자가 새 태그를 만들 수 있고, 중복 생성은 정규화돼 같은
//    태그로 합쳐진다.
// =====================================================================
const r3 = await p.evaluate(() => {
  const before = A.knownTags.length;
  const c1 = A.createTag('브런치');
  const c2 = A.createTag('  브런치  '); // 중복(공백 차이) — 새로 안 만들고 기존 걸 돌려줘야 함.
  const after = A.knownTags.length;
  return { before, after, c1, c2 };
});
t('3) 새 태그를 만들면 knownTags에 실제로 늘어남(21개 고정이 아님)', r3.after === r3.before + 1);
t('3) 같은 이름(공백 차이)으로 다시 만들면 중복 생성 안 되고 기존 태그를 돌려줌', r3.c2.created === false && r3.c2.tag.id === r3.c1.tag.id);

// =====================================================================
// 4) 태그 CRUD가 기존 장소 데이터를 파괴하지 않음 — 이름 수정은 이미
//    저장된 장소들의 tags 배열도 함께 갱신하고, 삭제는 연결만 끊을 뿐
//    장소 자체는 절대 안 지운다.
// =====================================================================
const r4 = await p.evaluate(() => {
  const places = [];
  A.merge(A.parseCsv('name\n브런치 맛집\n'), 'x', places, 'b1');
  A.setTags(places, places[0].id, ['브런치']);
  const beforeRename = places[0].tags.slice();
  const renameResult = A.renameTag('브런치', '브런치 카페', places);
  const afterRename = places[0].tags.slice();
  const customTag = A.tagEntries.find((tg) => tg.label === '브런치 카페');
  const deleteResult = A.deleteCustomTag(customTag.id, places);
  const afterDelete = places[0].tags.slice();
  const placeStillExists = places.length === 1 && places[0].name === '브런치 맛집';
  return { beforeRename, renameResult, afterRename, deleteResult, afterDelete, placeStillExists };
});
t('4) 이름 수정 전에는 원래 태그 이름으로 저장돼 있음', r4.beforeRename.includes('브런치'));
t('4) renameTag가 성공함', r4.renameResult.ok === true);
t('4) 이름을 바꾸면 이미 저장된 장소의 tags 배열도 함께 갱신됨(브런치→브런치 카페)', r4.afterRename.includes('브런치 카페') && !r4.afterRename.includes('브런치'));
t('4) 커스텀 태그를 지우면 연결이 끊김(장소의 tags에서 사라짐)', !r4.afterDelete.includes('브런치 카페'));
t('4) 태그를 지워도 장소 자체는 절대 삭제되지 않음', r4.placeStillExists);

// =====================================================================
// 5) 일괄 편집 — 여러 장소에 한 번에 태그를 붙이거나 뗄 수 있음.
// =====================================================================
const r5 = await p.evaluate(() => {
  const places = [];
  A.merge(A.parseCsv('name\n가게1\n'), 'a', places, 'b1');
  A.merge(A.parseCsv('name\n가게2\n'), 'b', places, 'b1');
  A.merge(A.parseCsv('name\n가게3\n'), 'c', places, 'b1');
  const ids = places.map((x) => x.id);
  const addedCount = A.bulkSetTag(places, [ids[0], ids[1]], '꼭 가기', true);
  const afterAdd = places.map((x) => ({ id: x.id, tags: x.tags, tagsConfirmed: x.tagsConfirmed }));
  const removedCount = A.bulkSetTag(places, [ids[0]], '꼭 가기', false);
  const afterRemove = places.map((x) => x.tags);
  return { addedCount, afterAdd, removedCount, afterRemove };
});
t('5) 일괄 추가가 지정한 개수만큼 실제로 반영됨', r5.addedCount === 2);
t('5) 지정한 두 곳에만 태그가 붙고 세 번째 곳은 안 붙음', r5.afterAdd[0].tags.includes('꼭 가기') && r5.afterAdd[1].tags.includes('꼭 가기') && !r5.afterAdd[2].tags.includes('꼭 가기'));
t('5) 사용자가 직접 붙인 일괄 편집은 tagsConfirmed=true로 확정됨(자동분류가 안 덮음)', r5.afterAdd[0].tagsConfirmed === true);
t('5) 일괄 해제도 지정한 곳만 정확히 반영됨', !r5.afterRemove[0].includes('꼭 가기') && r5.afterRemove[1].includes('꼭 가기'));

// =====================================================================
// 6) '꼭 가기' 같은 개인 태그와 실제 업종 태그(예: 스시)가 같은
//    tags 배열에 섞여도 서로 구분 없이 공존할 수 있음(요구사항: "개인
//    태그는 실제 업종과 구분해" — 최소 구현은 자유 태그로 함께 담되
//    자동분류가 개인 태그를 업종으로 지어내지 않는 것으로 확인한다).
// =====================================================================
const r6 = await p.evaluate(() => A.inferTags('아무 가게 이름'));
t('6) "꼭 가기" 같은 개인 주제어는 이름 텍스트만으로 자동 추정되지 않음(사용자가 명시적으로 붙여야 함)', !r6.includes('꼭 가기'));

// =====================================================================
// 7) 자동분류 우선순위 — 사용자 확정값(catConfirmed/tagsConfirmed=true)
//    은 방금 확보한 "신뢰 가능한 장소 유형"이 들어와도 절대 안 덮인다.
//    확정 안 된 값만 확인된 유형으로 올라간다.
// =====================================================================
const r7 = await p.evaluate(() => {
  const confirmed = { cat: '숙소', catConfirmed: true, tags: ['조식포함'], tagsConfirmed: true };
  A.applyConfirmedTypes(confirmed, ['restaurant', 'food']);
  const unconfirmed = { cat: '기타', catConfirmed: false, tags: [], tagsConfirmed: false };
  A.applyConfirmedTypes(unconfirmed, ['cafe']);
  return { confirmed, unconfirmed };
});
t('7) 사용자가 확정한 상위분류는 확인된 유형이 들어와도 그대로 유지됨', r7.confirmed.cat === '숙소');
t('7) 사용자가 확정한 태그도 그대로 유지됨', JSON.stringify(r7.confirmed.tags) === JSON.stringify(['조식포함']));
t('7) 확정 안 된 상위분류는 확인된 유형으로 실제로 올라감(기타 → 카페·디저트)', r7.unconfirmed.cat === '카페·디저트');
t('7) 확정 안 된 태그도 확인된 유형에서 함께 제안됨(카페)', r7.unconfirmed.tags.includes('카페'));
t('7) 확인된 유형 자체는 근거 추적을 위해 confirmedTypes에 기록됨', JSON.stringify(r7.unconfirmed.confirmedTypes) === JSON.stringify(['cafe']));

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
process.exit(fail ? 1 : 0);
