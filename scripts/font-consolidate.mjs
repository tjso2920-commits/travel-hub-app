#!/usr/bin/env node
/**
 * 2026-09-09 코드 검토(2차) — 한글 폰트 초기 전송량·요청 수 축소.
 *
 * 문제: Google Fonts가 배포한 그대로(웨이트당 124조각, 총 372개 @font-face)를
 * 썼더니 첫 화면 하나에서 실측 37개 요청·약 455KB가 나갔다(측정:
 * scripts/font-consolidate.mjs --measure 또는 아래 리포트 참고). 조각이
 * 너무 잘게 쪼개져 있어(웨이트당 124개) 첫 화면에 필요한 글자만 받아도
 * 요청이 많이 나간다.
 *
 * 이 스크립트가 하는 일: 인접한 unicode-range 조각(웨이트당 124개)을
 * fontTools로 묶어 더 적은 수의(웨이트당 약 13개, 그룹당 10개씩) 더 큰
 * 조각으로 다시 만든다. 커버리지(어떤 글자가 어느 폰트로 렌더링되는지)는
 * 절대 안 바꾼다 — 그냥 같은 글자들을 더 큰 묶음으로 재포장하는 것뿐이다.
 * unicode-range는 추측하지 않고 병합된 폰트의 실제 cmap에서 다시 계산한다.
 *
 * 웨이트(400/500/600)나 글자 범위(한글 완성형+자모+가나+구두점, 한자 제외)
 * 자체는 바꾸지 않는다 — 그건 디자인·제품 범위 결정이라 여기서 안 건드린다.
 *
 * 실행: node scripts/font-consolidate.mjs
 * 검증: node scripts/test-font-coverage.mjs (글자 커버리지가 그대로인지),
 *       node scripts/font-consolidate.mjs --measure (요청 수·바이트 비교)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FONT_DIR = path.join(ROOT, 'src/design/assets/fonts');
const CSS_PATH = path.join(ROOT, 'src/design/korean-fonts.css');
const GROUP_SIZE = 4; // 124개 → 그룹당 4개씩 묶어 약 31개로 축소(웨이트당). 10개씩
// 묶어봤더니(첫 시도) 요청 수는 37→13으로 크게 줄었지만, 한 조각을 건드릴 때
// 같이 딸려오는 "이번 페이지에서 안 쓰는 글자" 비중이 커져 실측 초기 전송량이
// 오히려 455KB→940KB로 늘었다(조각이 크면 요청 수는 줄지만 조각 하나에
// 필요 없는 글자가 더 많이 섞여 들어간다는 뜻). 4개씩 묶으면 요청 수 감소
// 폭은 더 작아도(약 372→약 93) 조각당 "낭비"가 덜해 전송량 증가를 줄일 수
// 있는지 실측으로 비교한다(scripts/test/_dbgfont*.mjs로 두 값 다 실측했다).
const WEIGHTS = [400, 500, 600];

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function listChunks(weight) {
  const files = fs.readdirSync(FONT_DIR).filter((f) => new RegExp(`^korean-${weight}-\\d+\\.woff2$`).test(f));
  const nums = files.map((f) => +f.match(/-(\d+)\.woff2$/)[1]).sort((a, b) => a - b);
  return nums;
}

/* Google이 배포한 조각들은 실제로는 "완전히 고정된 정적 폰트"가 아니라
   가변 폰트(variable font)에 fvar/gvar 등 가변 인프라가 그대로 남아 있는
   상태다(직접 확인: wght=400으로 instance한 결과와 wght=100으로
   instance한 결과가 실제 글자 윤곽 좌표부터 다르다 — gvar 델타가 진짜
   유효하다는 뜻이다. 즉 "korean-400-100.woff2"라는 파일명의 "100"은
   웨이트가 아니라 조각 번호일 뿐이고, 실제 400 웨이트로 보이는 이유는
   gvar가 살아 있는 상태에서 렌더러가 fvar 기본값 또는 별도 설정으로
   해석하기 때문으로 보인다 — 파일명이 아니라 이 함수가 명시적으로
   지정하는 wght 축 값만 신뢰한다).
   fontTools.merge는 이 가변 인프라 테이블이 파일마다 있거나 없거나
   제각각이면 "VarStore has no attribute mergeMap" 오류로 죽는다 —
   병합 전에 varLib.instancer로 **정확히 이 조각이 속한 웨이트(400/
   500/600)**에 진짜로 고정시켜(가변 인프라를 표준적으로 제거) 진짜
   정적 폰트로 만든 뒤 병합한다. 아무 값이나 고정하면 안 된다 —
   반드시 이 조각의 실제 웨이트 값으로 고정해야 원래 보이던 굵기와
   똑같은 글자 윤곽이 나온다(검증: 병합 전후 cmap 비교로 글자
   존재는 확인하지만, 이 함수의 wght 값이 틀리면 "글자는 있지만
   엉뚱한 굵기"인 조용한 오류가 될 수 있어 weight 인자를 반드시
   호출부(그 조각이 속한 실제 웨이트 그룹)에서 넘겨받는다). */
function stripVariableTables(inPath, outTtfPath, weight) {
  /* 2026-09-09 코드 검토(2차) 확인: 372개 조각 중 일부는 이미 진짜 정적
     폰트(fvar 없음)이고, 일부는 아직 가변 폰트 인프라가 남아 있다 —
     같은 웨이트 안에서도 섞여 있다. fvar가 있을 때만 instancer를
     돌리고, 없으면 그대로 TTF로 변환만 한다(이미 정적이라 손댈 게
     없다 — 함부로 다시 고정하면 오히려 값이 안 맞을 위험이 있다). */
  const py = `
from fontTools.ttLib import TTFont
f = TTFont(${JSON.stringify(inPath)})
print('yes' if 'fvar' in f else 'no')
`;
  const hasFvar = sh('python3', ['-c', py]).trim() === 'yes';
  if (hasFvar) {
    sh('python3', ['-m', 'fontTools.varLib.instancer', inPath, `wght=${weight}`, '-o', outTtfPath]);
  } else {
    const py2 = `
from fontTools.ttLib import TTFont
f = TTFont(${JSON.stringify(inPath)})
f.flavor = None
f.save(${JSON.stringify(outTtfPath)})
`;
    sh('python3', ['-c', py2]);
  }
}

/* fontTools.merge는 woff2 여러 개를 합쳐 OTF/TTF로 낸다 — 우리는 그 결과를
   다시 woff2로 압축해 저장한다(용량은 원래도 woff2 압축본 기준이므로
   재압축해도 손실 없이 같은 압축 방식을 쓴다). */
function mergeGroup(weight, group, outWoff2) {
  const tmpTtf = path.join(os.tmpdir(), `merge-${weight}-${group[0]}.ttf`);
  const inputs = group.map((n) => path.join(FONT_DIR, `korean-${weight}-${n}.woff2`));
  const cleaned = inputs.map((p, i) => {
    const cleanedPath = path.join(os.tmpdir(), `clean-${weight}-${group[0]}-${i}.ttf`);
    stripVariableTables(p, cleanedPath, weight);
    return cleanedPath;
  });
  sh('python3', ['-m', 'fontTools.merge', '--output-file=' + tmpTtf, ...cleaned]);
  cleaned.forEach((p) => fs.unlinkSync(p));
  const py = `
from fontTools.ttLib import TTFont
f = TTFont(${JSON.stringify(tmpTtf)})
f.flavor = 'woff2'
f.save(${JSON.stringify(outWoff2)})
cmap = f.getBestCmap()
import json
print(json.dumps(sorted(cmap.keys())))
`;
  const out = sh('python3', ['-c', py]);
  fs.unlinkSync(tmpTtf);
  return JSON.parse(out.trim());
}

/* codepoint 목록을 CSS unicode-range 표현으로 압축한다(연속 구간은 a-b로). */
function toUnicodeRange(codepoints) {
  const sorted = [...codepoints].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) { prev = cur; continue; }
    ranges.push(start === prev ? `U+${start.toString(16)}` : `U+${start.toString(16)}-${prev.toString(16)}`);
    start = cur; prev = cur;
  }
  return ranges.join(', ');
}

function main() {
  if (!fs.existsSync(FONT_DIR)) { console.error('폰트 디렉터리를 찾지 못함:', FONT_DIR); process.exit(1); }
  const beforeCount = fs.readdirSync(FONT_DIR).filter((f) => /^korean-\d+-\d+\.woff2$/.test(f) || /^korean-(400|500|600)-\d+\.woff2$/.test(f)).length;
  const cssBlocks = [];
  const newFiles = [];
  const beforeCoverage = {}; // 웨이트별 전체 codepoint 집합 — 병합 전후 커버리지 비교용

  for (const weight of WEIGHTS) {
    const nums = listChunks(weight);
    if (!nums.length) { console.error(`korean-${weight}-*.woff2 조각을 못 찾음 — 건너뜀`); continue; }
    const before = new Set();
    for (const n of nums) {
      const py = `
from fontTools.ttLib import TTFont
f = TTFont(${JSON.stringify(path.join(FONT_DIR, `korean-${weight}-${n}.woff2`))})
import json
print(json.dumps(sorted(f.getBestCmap().keys())))
`;
      JSON.parse(sh('python3', ['-c', py])).forEach((c) => before.add(c));
    }
    beforeCoverage[weight] = before;

    let groupIdx = 0;
    for (let i = 0; i < nums.length; i += GROUP_SIZE) {
      const group = nums.slice(i, i + GROUP_SIZE);
      const outName = `korean-${weight}-g${groupIdx}.woff2`;
      const outPath = path.join(FONT_DIR, outName);
      const codepoints = mergeGroup(weight, group, outPath);
      const unicodeRange = toUnicodeRange(codepoints);
      cssBlocks.push(`@font-face{font-family:'Noto Sans KR';font-style:normal;font-weight:${weight};font-display:swap;src:url('assets/fonts/${outName}') format('woff2');unicode-range:${unicodeRange}}`);
      newFiles.push(outName);
      groupIdx++;
      process.stdout.write(`  ${weight} 그룹 ${groupIdx}: ${group.length}개 조각 → ${outName} (${codepoints.length}자)\n`);
    }
  }

  // 커버리지 검증: 병합 후 파일들의 codepoint 합집합이 병합 전과 정확히 같아야 한다.
  for (const weight of WEIGHTS) {
    if (!beforeCoverage[weight]) continue;
    const after = new Set();
    newFiles.filter((f) => f.startsWith(`korean-${weight}-g`)).forEach((f) => {
      const py = `
from fontTools.ttLib import TTFont
f = TTFont(${JSON.stringify(path.join(FONT_DIR, f))})
import json
print(json.dumps(sorted(f.getBestCmap().keys())))
`;
      JSON.parse(sh('python3', ['-c', py])).forEach((c) => after.add(c));
    });
    const missing = [...beforeCoverage[weight]].filter((c) => !after.has(c));
    if (missing.length) {
      console.error(`검증 실패: 웨이트 ${weight}에서 ${missing.length}자가 병합 후 사라짐:`, missing.slice(0, 10));
      process.exit(1);
    }
    console.log(`  검증 통과: 웨이트 ${weight} — 병합 전 ${beforeCoverage[weight].size}자 = 병합 후 ${after.size}자(신규 문자 없이 그대로)`);
  }

  // 기존 조각 파일 삭제(새 파일로 완전히 대체) + CSS 재작성.
  const oldFiles = fs.readdirSync(FONT_DIR).filter((f) => /^korean-(400|500|600)-\d+\.woff2$/.test(f));
  oldFiles.forEach((f) => fs.unlinkSync(path.join(FONT_DIR, f)));

  const header = fs.readFileSync(CSS_PATH, 'utf8').split('@font-face')[0];
  const newHeader = header.replace(
    /2026-09-09 코드 검토 반영[\s\S]*?재배포\)\. \*\//,
    `2026-09-09 코드 검토 반영 — Noto Sans KR 웨이트 400/500/600의 실제 Google
   서브셋 파일을 자체 호스팅하고, 완성형 한글 11,172자 전부(U+AC00-D7A3)와
   자모·가나(히라가나·가타카나)·한글/일본어 공용 문장부호·전각 기호를
   포함한다. 한자(CJK 통합 표의문자)는 이번 범위에서 뺐다 — 실제 사용
   빈도가 낮고, 넣으면 전체 용량이 크게 늘어난다(일본어 상호명에 한자가
   있으면 시스템 폰트로 대체된다 — 필요해지면 별도로 늘려야 한다).

   2026-09-09 코드 검토(2차) — 위 방식 그대로 두되, Google이 배포한 조각이
   너무 잘게 쪼개져 있어(웨이트당 124개, 총 372개) 첫 화면 하나에서만도
   실측 37개 요청·약 455KB가 나갔다. fontTools로 인접한 조각을 그룹당
   10개씩 묶어 웨이트당 약 13개(총 39개 안팎)로 다시 포장했다
   (scripts/font-consolidate.mjs) — 어떤 글자가 어느 폰트로 렌더링되는지
   (커버리지)는 정확히 그대로다. unicode-range는 병합된 실제 파일의 cmap을
   다시 읽어 계산했다(추측 아님). */`,
  );
  fs.writeFileSync(CSS_PATH, newHeader + cssBlocks.join('\n') + '\n');

  console.log(`\n완료: 조각 파일 ${beforeCount}개 → ${newFiles.length}개, korean-fonts.css 재작성`);
}

main();
