/**
 * src/design/ 실데이터 통합 화면 검수 — 실제 Chromium + 진짜 파일 업로드.
 *
 * scripts/test/*.mjs (jsdom)와 달리 여기는 진짜 <input type=file> 선택 흐름을
 * 실제 브라우저로 검증한다. 승인 디자인(design/handoff-v5/approved-design)에
 * 실데이터 어댑터(src/design/import-adapter.js)를 붙인 결과가 실제로
 * 동작하는지 본다.
 *
 * 사용자의 진짜 CSV는 개인정보라 저장소에 못 넣는다(01_CLAUDE_PROMPT.txt 5번:
 * "개인정보를 공개 Git 저장소·테스트 fixture·로그에 커밋하지 마라"). 그래서
 * 여기서는 구글 Takeout 이 실제로 내보내는 것과 같은 모양 — 한글 헤더
 * (제목,메모,URL,태그,댓글), 좌표 없는 URL, 빈 줄 하나 — 을 그대로 흉내 낸
 * 합성 파일로 잰다. 이 모양 자체가 실제 사용자 파일로 한 번 검증됐다
 * (docs/DESIGN_INTEGRATION_REPORT.md).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-check-'));
/* 파일 내용은 실제 한글 Takeout 형식 그대로 두되(가게 이름·URL은 지어낸 값),
   파일 '이름'은 ASCII로 둔다 — 비ASCII 파일명은 이 저장소 밖의 OS 로케일
   설정에 좌우되는 문제라(실제로 이 샌드박스에는 UTF-8 로케일이 기본으로
   없었다) 그건 이 검사가 잴 대상이 아니다. 이 샌드박스 밖(실제 아이폰 Safari
   등)에서도 항상 괜찮다는 뜻은 아니다 — 실기기 검증은 별도로 필요하고,
   아직 안 했다. */
const csvPath = path.join(tmp, 'basic-list.csv');
fs.writeFileSync(csvPath,
  '제목,메모,URL,태그,댓글\n' +
  ',,,,\n' +
  '라멘가게 1호점,,https://www.google.com/maps/place/%EB%9D%BC%EB%A9%98%EA%B0%80%EA%B2%8C/data=!4m2!3m1!1s0x0000000000000101:0x0000000000000101,,\n' +
  '이자카야 2호점,,https://www.google.com/maps/place/%EC%9D%B4%EC%9E%90%EC%B9%B4%EC%95%BC/data=!4m2!3m1!1s0x0000000000000102:0x0000000000000102,,\n' +
  'st.763,스탠드바 굴 중심,,,\n',
  'utf8');

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
p.on('dialog', (d) => d.dismiss());

let fail = 0;
const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);
t('초기 화면(데이터 없음)은 샘플로 뜸', (await p.evaluate(() => usingSample)) === true);

await p.click('[data-add]');
const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc.setFiles(csvPath);
await p.waitForTimeout(700);

const h2 = await p.textContent('#sheetContent h2').catch(() => '');
t('한글 헤더 CSV에서 이름 있는 행만(빈 줄 제외) 파싱됨', /^3곳/.test(h2));
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(300);

const state = await p.evaluate(() => ({ usingSample, spotsLen: spots.length, count: document.getElementById('count').textContent }));
t('가져온 뒤 샘플 표시가 꺼짐', state.usingSample === false);
t('배경 화면(#count)도 같이 갱신됨', state.count === '3');
t('foodMap.places 에도 저장됨', (await p.evaluate(() => foodMap.places.length)) === 3);

await p.click('.spot-open >> nth=0');
await p.waitForTimeout(200);
const detailHTML = await p.textContent('#sheetContent');
t('상세 시트에 샘플 문구가 안 남음("디자인 예시" 없음)', !detailHTML.includes('디자인 예시'));
const mapHref = await p.getAttribute('#sheetContent a', 'href');
t('지도 링크가 실제 저장 URL을 그대로 씀(검색 링크로 안 바뀜)', mapHref && mapHref.includes('/maps/place/'));
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(200);

// 재수입 — URL 있는 곳은 자동 갱신, URL·주소·좌표가 전부 없는 곳(st.763)은
// 검증할 방법이 없어 "중복 후보"로만 남는다(2026-09-09 코드 검토 반영 —
// 증거 없이 자동으로 합치지 않는다. 이건 회귀가 아니라 의도한 동작이다).
await p.click('[data-add]');
const [fc2] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc2.setFiles(csvPath);
await p.waitForTimeout(700);
const summary = await p.textContent('.import-summary').catch(() => '');
const flat = summary.replace(/\s+/g, ' ');
t('URL 있는 2곳은 검증된 식별자로 자동 갱신', /2\s*자동 갱신/.test(flat));
t('URL·주소·좌표가 전부 없는 1곳은 중복 후보로만 남음(자동 병합 안 함)', /1\s*새로 추가/.test(flat));
await p.evaluate(() => document.getElementById('close').click());
t('중복 후보는 화면에서 사람이 합치기 전엔 별개 레코드로 남음(4곳)', (await p.evaluate(() => foodMap.places.length)) === 4);

// 중복 후보를 실제로 화면에서 "같은 곳이에요 · 합치기"로 합치기 — 이때
// 삭제되는 쪽의 URL이 별칭으로 남아, 나중에 그 URL로 다시 가져와도 새
// 레코드가 또 생기지 않아야 한다(2026-09-09 코드 검토, daResolveDup).
const dupCsvPath = path.join(tmp, 'dup-candidates.csv');
fs.writeFileSync(dupCsvPath,
  '제목,메모,URL,태그,댓글\n' +
  '두번째상호 1호점,,https://www.google.com/maps/place/dup1/data=!4m2!3m1!1s0x0000000000000201:0x0000000000000201,,\n' +
  '두번째상호 1호점,,https://www.google.com/maps/place/dup2/data=!4m2!3m1!1s0x0000000000000202:0x0000000000000202,,\n',
  'utf8');
await p.evaluate(() => document.getElementById('close').click());
await p.click('[data-add]');
const [fc3] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc3.setFiles(dupCsvPath);
await p.waitForTimeout(700);
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(200);
const beforeMergeCount = await p.evaluate(() => foodMap.places.length);
t('URL이 서로 달라 이름만 같은 두 곳은 후보로 각각 남음(자동 병합 안 함)', beforeMergeCount === 6);

const dupTarget = await p.evaluate(() => {
  const d = foodMap.places.find((x) => x.name === '두번째상호 1호점' && x.dupCandidateIds && x.dupCandidateIds.length);
  return d ? d.id : null;
});
await p.evaluate((id) => { detail(id); }, dupTarget);
await p.waitForTimeout(200);
await p.click('[data-dup-merge]');
await p.waitForTimeout(300);
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(200);
const afterMerge = await p.evaluate(() => ({
  count: foodMap.places.length,
  survivor: foodMap.places.find((x) => x.name === '두번째상호 1호점'),
}));
t('화면에서 합치기를 누르면 실제로 1곳으로 줄어듦', afterMerge.count === beforeMergeCount - 1);
t('합쳐진 레코드에 삭제된 쪽 URL이 별칭으로 남음', afterMerge.survivor && (afterMerge.survivor.aliasUrls || []).some((u) => u.includes('0x0000000000000201') || u.includes('0x0000000000000202')));

// 삭제된 쪽 URL로 다시 가져오기 — 별칭 덕분에 새 레코드가 또 생기면 안 됨
const reimportPath = path.join(tmp, 'dup-reimport.csv');
fs.writeFileSync(reimportPath,
  '제목,메모,URL,태그,댓글\n' +
  '두번째상호 1호점,,https://www.google.com/maps/place/dup2/data=!4m2!3m1!1s0x0000000000000202:0x0000000000000202,,\n',
  'utf8');
await p.click('[data-add]');
const [fc4] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc4.setFiles(reimportPath);
await p.waitForTimeout(700);
const afterReimport = await p.evaluate(() => foodMap.places.length);
t('합쳐서 없어진 쪽 URL로 재수입해도 새 레코드가 안 생김(별칭 등록 확인)', afterReimport === afterMerge.count);
await p.evaluate(() => document.getElementById('close').click());

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));

await b.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
