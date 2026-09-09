/**
 * docs/DESIGN_INTEGRATION_REPORT.md 7절용 비교 스크린샷 — 지어낸 데이터만
 * 쓴다(실제 장소명 없음). 이번에 새로 붙인 두 화면을 찍는다:
 *  1) 도시 지정 시트(cityAssignSheet) — "지역 확인 필요" 장소를 실제로
 *     쓸 수 있게 만든 화면(코드 검토 ④).
 *  2) 중복 후보 해결 안내(상세 시트의 "같은 곳이에요/다른 곳이에요") —
 *     이름만 같은 곳을 자동으로 합치지 않고 사람이 확인하게 한 화면(①).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
const csvPath = path.join(tmp, 'sample.csv');
/* 도시 확인 필요(주소 없음) 1곳 + 이름만 같은 후보 쌍(서로 다른 목록에서
   따로 들어온 것처럼) 2곳을 만든다. */
fs.writeFileSync(csvPath,
  '제목,메모,URL,주소,댓글\n' +
  '골목 카레집,,,,\n' +
  '동네 라멘집,,,,\n' +
  '동네 라멘집,,,,\n',
  'utf8');

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
p.on('dialog', (d) => d.dismiss());

await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);
await p.click('[data-add]');
const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc.setFiles(csvPath);
await p.waitForTimeout(700);
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(300);

/* 지역 확인 필요 카드 하나를 열어 도시 지정 버튼 노출 */
await p.click('.spot-open >> nth=0');
await p.waitForTimeout(200);
await p.screenshot({ path: 'docs/screenshots/after_지역확인필요_상세.png' });

/* 도시 지정 시트 자체 */
await p.click('[data-city-single]');
await p.waitForTimeout(200);
await p.screenshot({ path: 'docs/screenshots/after_도시지정시트.png' });
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(200);

/* 중복 후보(동네 라멘집 두 곳) 상세 — 합치기/다른 곳이에요 버튼 노출 */
const dupHandle = await p.evaluateHandle(() => {
  const dup = spots.find((s) => s.dupCandidateIds && s.dupCandidateIds.length);
  return dup ? dup.id : null;
});
const dupId = await dupHandle.jsonValue();
if (dupId) {
  await p.evaluate((id) => { detail(id); }, dupId);
  await p.waitForTimeout(200);
  await p.evaluate(() => { document.getElementById('sheet')?.scrollTo(0, 999); });
  await p.waitForTimeout(150);
  await p.screenshot({ path: 'docs/screenshots/after_중복후보_상세.png' });
}

await b.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('스크린샷 3장 저장 완료 (지어낸 데이터만 사용)');
