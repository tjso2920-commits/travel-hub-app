import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/BASELINE_MANIFEST.json'), 'utf8'));
let failures = 0;

function pass(message) {
  console.log(`PASS  ${message}`);
}

function fail(message) {
  failures += 1;
  console.error(`FAIL  ${message}`);
}

function info(message) {
  console.log(`INFO  ${message}`);
}

function check(condition, message) {
  condition ? pass(message) : fail(message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function extractRoot(source) {
  const match = source.match(/:root\s*\{[\s\S]*?\}/);
  return match ? match[0] : '';
}

function storageKeys(source) {
  return new Set(
    [...source.matchAll(/\b(?:load|save)\(\s*[`"']([^`"']+)[`"']/g)].map((match) => match[1])
  );
}

function duplicateIds(source) {
  const staticMarkup = source.replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi, '');
  const ids = [...staticMarkup.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

function compileInlineScripts(source, label) {
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  check(scripts.length > 0, `${label}: 인라인 script 존재`);
  scripts.forEach((script, index) => {
    try {
      new Function(script);
      pass(`${label}: script ${index + 1} 구문`);
    } catch (error) {
      fail(`${label}: script ${index + 1} 구문 — ${error.message}`);
    }
  });
}

function requireTokens(source, label, tokens) {
  for (const token of tokens) {
    check(source.includes(token), `${label}: ${token}`);
  }
}

function countTopRows(source, declaration, nextDeclaration) {
  const start = source.indexOf(declaration);
  const end = source.indexOf(nextDeclaration, start + declaration.length);
  if (start < 0 || end < 0) return -1;
  return (source.slice(start, end).match(/^\s*\[/gm) || []).length;
}

function verifyProtected(source, label, spec) {
  const blocks = {
    root: extractRoot(source)
  };
  for (const [name, expected] of Object.entries(spec.protected)) {
    check(Boolean(blocks[name]), `${label}: 보호 블록 ${name} 추출`);
    if (blocks[name]) check(sha256(blocks[name]) === expected, `${label}: 보호 블록 ${name} 해시`);
  }
}

function verifyStorage(source, label, expected) {
  const actual = storageKeys(source);
  for (const key of expected) {
    check(actual.has(key), `${label}: 기존 저장 키 ${key}`);
  }
}

const personal = read(manifest.personal.file);
const sales = read(manifest.sales.file);

compileInlineScripts(personal, '개인용');
compileInlineScripts(sales, '판매용');

check(duplicateIds(personal).length === 0, `개인용: 정적 ID 중복 없음${duplicateIds(personal).length ? ` (${duplicateIds(personal).join(', ')})` : ''}`);
check(duplicateIds(sales).length === 0, `판매용: 정적 ID 중복 없음${duplicateIds(sales).length ? ` (${duplicateIds(sales).join(', ')})` : ''}`);

verifyProtected(personal, '개인용', manifest.personal);
verifyProtected(sales, '판매용', manifest.sales);
verifyStorage(personal, '개인용', manifest.personal.required_storage_keys);
verifyStorage(sales, '판매용', manifest.sales.required_storage_keys);

requireTokens(personal, '개인용', [
  'const SALE_MODE=false;',
  "const PFX=SALE_MODE?'cs1_':'cp1_';",
  'id="tab-jp"',
  'id="tab-map"',
  'id="ovSet"',
  "const TRIP_DATE='2026-10-25';",
  'function showLanding()',
  'function showTab(t)',
  'function renderSettings()',
  'function fmAddVideo(',
  'function fmDeleteVideo(',
  'const JP_LIMIT=90',
  'const JP_GRAMMAR=[',
  'const JP_GRAMMAR_KANA=[',
  'const JP_GRAMMAR_MANUAL_ROWS=[',
  'const JP_GRAMMAR_GLOSS_ROWS=[',
  'function jpRuby(',
  'function jpKoSound(',
  'const JP_CHAINS=[',
  'navigator.geolocation.watchPosition',
  'enableHighAccuracy:true,maximumAge:0,timeout:15000'
]);

requireTokens(sales, '판매용', [
  'const SALE_MODE=true;',
  "const PFX=SALE_MODE?'cs1_':'cp1_';",
  'id="tab-jp"',
  'id="tab-map"',
  'id="ovSet"',
  'function fmAddVideo(',
  'function fmDeleteVideo(',
  'const JP_LIMIT=90'
]);

// 2026-07-30 운동/운동2 탭을 개인용 마스터에서 완전히 제거했다 — 회귀 방지 가드.
for (const workoutToken of [
  'id="tab-train"', 'id="tab-train2"', 'id="tab-guide"', '운동가이드', 'workout2_snap_v1',
  'function autoVid(name)', 'function personalDays()', 'const V={'
]) {
  check(!personal.includes(workoutToken), `개인용: 운동 탭 잔재 없음 ${workoutToken}`);
  check(!sales.includes(workoutToken), `판매용: 운동 탭 잔재 없음 ${workoutToken}`);
}
// 2026-07-29 사양 변경: 판매용이 본체가 되면서 실시간 GPS·문법 교재·후리가나를 유지한다.
requireTokens(sales, '판매용', [
  'navigator.geolocation.watchPosition',
  'function jpRuby(',
  'function jpGrammarBookHTML(',
  'function fm2Clusters()',
  'function fm2RenderOverview()',
  'function fmEnrichAll()',
  'function asContext()',
  'function asAsk()',
  'function bgAdd()',
  'function csBuild()',
  'function csOrder(',
  'function plBuild()',
  'function fmClosedDays(p)',
  'function fmFillHours()',
  'function fmOpenAt(',
  'const SJ_BANK=',
  'function fmPanel(',
  'function affUrl(k)',
  'function fmGuideHTML()',
  'async function fxFetch(quiet)',
  'function phRead(buf)',
  'function phNearest(',
  'function sjPick(p,limit)',
  "o['제목']",
  'function ibDetectPlatform(u)',
  'function ibAdd()',
  'async function ibGuess(id)',
  'function ibConfirm(id)',
  'function ibHTML()'
]);
for (const personalToken of ['스태프밀', '윤식', '96 → 80', 'F&B 경력자', '十年以上']) {
  check(!sales.includes(personalToken), `판매용: 개인 신상 문자열 제외 ${personalToken}`);
}
for (const privateToken of ['workout2_data_v1', 'workout2_sets_v1', '86~88kg', '170~190g', '05:30~12:00']) {
  check(!sales.includes(privateToken), `판매용: 개인 전용 문자열 제외 ${privateToken}`);
}
check(!/AIza[0-9A-Za-z_-]{25,}/.test(sales), '판매용: 하드코딩된 Google API 키 패턴 없음');

check(countTopRows(personal, 'const JP_GRAMMAR_MANUAL_ROWS=[', 'const JP_GRAMMAR_MANUAL=') === 90, '개인용: 필수 문법 교재 90개');
check(countTopRows(personal, 'const JP_GRAMMAR_GLOSS_ROWS=[', 'const JP_GRAMMAR_GLOSS=') === 90, '개인용: 필수 문법 형태별 뜻 90개');
check(countTopRows(personal, 'const JP_N3_MANUAL_ROWS=[', 'const JP_N3_GLOSS_ROWS=') === 33, '개인용: N3 선택 교재 33개');
check(countTopRows(personal, 'const JP_N3_GLOSS_ROWS=[', 'const JP_N3_GLOSS=') === 33, '개인용: N3 선택 형태별 뜻 33개');

check(personal.includes('何回来たことがありますか。'), '개인용: 방문 횟수 연계 질문');
for (const answer of ['一回来ました。', '二回来ました。', '三回来ました。', '四回来ました。', '何度も来ています。']) {
  check(personal.includes(answer), `개인용: 연계 답변 ${answer}`);
}

info(
  sha256(personal) === manifest.personal.sha256_at_handoff
    ? '개인용: 인수인계 시점 전체 파일과 동일'
    : '개인용: 승인된 수정으로 전체 파일 해시가 바뀜 — 보호 블록·저장 키 검사를 기준으로 검토'
);
info(
  sha256(sales) === manifest.sales.sha256_at_handoff
    ? '판매용: 인수인계 시점 전체 파일과 동일'
    : '판매용: 승인된 수정으로 전체 파일 해시가 바뀜 — 보호 블록·저장 키·개인정보 검사를 기준으로 검토'
);

if (failures) {
  console.error(`\n검증 실패: ${failures}개`);
  process.exit(1);
}

console.log('\n전체 검증 통과');
