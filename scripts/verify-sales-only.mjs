/**
 * 배포 전 판매용 무결성 검사.
 * CI 에서는 private/ 가 없으므로 개인용을 읽지 않고 판매용만 본다.
 * 개인용까지 함께 보려면 로컬에서 `npm run verify` 를 쓴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'src/index.html');

if (!fs.existsSync(file)) {
  console.error('FAIL  src/index.html 이 없다. `npm run build` 로 생성한다.');
  process.exit(1);
}
const html = fs.readFileSync(file, 'utf8');

let failed = 0;
const check = (ok, label) => {
  if (!ok) { console.error(`FAIL  ${label}`); failed += 1; }
};

const BANNED = [
  'workout2_data_v1', 'workout2_sets_v1', 'workout2_snap_v1', 'id="tab-train2"',
  '86~88kg', '170~190g', '05:30~12:00', '스태프밀', '윤식', '96 → 80',
  'F&B 경력자', '경력 소개', '十年以上'
];
BANNED.forEach((token) => check(!html.includes(token), `개인 정보·개인 전용 기능 잔존: ${token}`));
check(!/AIza[0-9A-Za-z_-]{25,}/.test(html), '하드코딩된 Google API 키 패턴');

const REQUIRED = [
  'const SALE_MODE=true;',
  'id="tab-jp"', 'id="tab-collect"', 'id="tab-plan"', 'id="tab-now"', 'id="ovSet"',
  'const JP_LIMIT=90', 'function jpRuby(', 'function jpGrammarBookHTML(',
  'function fm2Clusters()', 'function fm2RenderOverview()', 'function fmEnrichAll()',
  'function fmFillHours()', 'function fmOpenAt(', 'function fmClosedDays(p)',
  'function csBuild()', 'function csOrder(', 'function plBuild()',
  'function bgAdd()', 'function asContext()', 'function asAsk()',
  'const SJ_BANK=', 'function fmPanel(', 'function affUrl(k)', 'function fmGuideHTML()', 'async function fxFetch(quiet)', 'function phRead(buf)',
  "o['제목']", 'function ibDetectPlatform(u)', 'function ibAdd()', 'function ibConfirm(id)', 'function tjHTML()', 'function spSummarize(id)', 'function spCardHTML(p)', 'function wxHTML()', 'async function wxFetch(quiet)', 'function shHandle()',
];
REQUIRED.forEach((token) => check(html.includes(token), `필수 기능 누락: ${token}`));

['sw.js', 'manifest.webmanifest'].forEach((name) => {
  check(fs.existsSync(path.join(ROOT, 'src', name)), `배포 파일 누락: src/${name}`);
});
check(html.includes('serviceWorker'), '서비스 워커 등록 코드 누락');
check(html.includes('manifest.webmanifest'), '매니페스트 링크 누락');
try {
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/manifest.webmanifest'), 'utf8'));
  check(!!(mf.share_target && mf.share_target.params && mf.share_target.params.url), '매니페스트 공유 대상 선언 누락');
} catch (e) {
  check(false, `매니페스트 파싱 실패 — ${e.message}`);
}

try {
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].forEach(([, code]) => {
    new Function(code);
  });
} catch (error) {
  check(false, `인라인 스크립트 구문 오류 — ${error.message}`);
}

if (failed) {
  console.error(`\n판매용 검사 실패 ${failed}건 — 배포를 중단한다.`);
  process.exit(1);
}
console.log('판매용 검사 통과');
