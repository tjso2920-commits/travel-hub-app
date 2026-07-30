/**
 * 판매용 생성기
 * 개인용(마스터) 1개만 수정하면 판매용이 자동으로 만들어진다.
 * 손으로 두 파일을 관리하지 않는다 — 두 파일이 갈라지는 사고를 원천 차단한다.
 *
 * 규칙
 *  - 제거: 개인 신상·신체·근무 일정·개인 경력 문장, 운동2 탭 전체
 *  - 유지: 후쿠오카 모듈 전부, 일본어 문법 교재·후리가나, 실시간 GPS, 영상 기능
 *  - 각 변환은 반드시 1회만 일치해야 하며, 아니면 즉시 실패한다(조용한 누락 방지)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'private/personal.html');
const OUT = path.join(ROOT, 'src/index.html');

let html = fs.readFileSync(SRC, 'utf8');
const log = [];

function apply(label, fn) {
  const before = html;
  html = fn(html);
  if (html === before) {
    console.error(`FAIL  변환 무효: ${label}`);
    process.exit(1);
  }
  log.push(label);
}

function rep(label, from, to) {
  apply(label, (s) => {
    const n = s.split(from).length - 1;
    if (n !== 1) {
      console.error(`FAIL  ${label}: ${n}건 일치 (1건이어야 함)`);
      process.exit(1);
    }
    return s.replace(from, to);
  });
}

function del(label, from) {
  rep(label, from, '');
}

/** startMarker 시작부터 endMarker 시작 직전까지 잘라내고 replacement 로 바꾼다 */
function cut(label, startMarker, endMarker, replacement = '') {
  apply(label, (s) => {
    const i = s.indexOf(startMarker);
    if (i < 0) {
      console.error(`FAIL  ${label}: 시작 마커 없음`);
      process.exit(1);
    }
    if (s.indexOf(startMarker, i + 1) >= 0) {
      console.error(`FAIL  ${label}: 시작 마커 2건 이상`);
      process.exit(1);
    }
    const j = s.indexOf(endMarker, i + startMarker.length);
    if (j < 0) {
      console.error(`FAIL  ${label}: 종료 마커 없음`);
      process.exit(1);
    }
    return s.slice(0, i) + replacement + s.slice(j);
  });
}

/* ── 1. 문서 정보 ───────────────────────────────── */
rep('메타 앱 이름', '<meta name="apple-mobile-web-app-title" content="커팅루틴">',
  '<meta name="apple-mobile-web-app-title" content="여행 통합앱">');
rep('문서 제목', '<title>커팅 루틴 · 트래커</title>', '<title>여행 통합앱</title>');

/* ── 2. 판매 모드 ───────────────────────────────── */
rep('SALE_MODE', 'const SALE_MODE=false;', 'const SALE_MODE=true;');

/* ── 3. 운동2 탭 전체 제거 ──────────────────────── */
del('운동2 달력 점 CSS', '  .adot.w2{background:#67C8B5;box-shadow:0 0 7px rgba(103,200,181,.55)}\n');
apply('운동2 CSS 규칙', (src) => {
  const start = src.indexOf('  /* WORKOUT 2 · 기존 운동 모듈과 분리된 개인용 90일 보완 루틴 */');
  const end = src.indexOf('@media(max-width:430px)', start);
  if (start < 0 || end < 0) { console.error('FAIL  운동2 CSS 경계'); process.exit(1); }
  const region = src.slice(start, end).replace('  /* WORKOUT 2 · 기존 운동 모듈과 분리된 개인용 90일 보완 루틴 */\n', '');
  // 중괄호 균형을 맞춰 규칙 단위로 분해한 뒤, 운동2 전용 선택자만 통째로 제거한다.
  const out = [];
  let i = 0;
  while (i < region.length) {
    const open = region.indexOf('{', i);
    if (open < 0) { out.push(region.slice(i)); break; }
    let depth = 1, j = open + 1;
    while (j < region.length && depth > 0) {
      if (region[j] === '{') depth += 1;
      else if (region[j] === '}') depth -= 1;
      j += 1;
    }
    const rule = region.slice(i, j);
    const selector = region.slice(i, open);
    if (!/#tab-train2|\.w2-|\.adot\.w2/.test(selector)) out.push(rule);
    i = j;
  }
  return src.slice(0, start) + out.join('') + src.slice(end);
});
rep('내비 열 수', 'nav{grid-template-columns:repeat(7,max-content)}', 'nav{grid-template-columns:repeat(6,max-content)}');
apply('@media 안 운동2 규칙', (src) => src.replace(/\.w2-statgrid\{[^}]*\}\.w2-volume\{[^}]*\}/, ''));
del('운동2 내비 버튼', '<button data-t="train2" onclick="showTab(\'train2\')">운동2</button>');
cut('운동2 섹션', '<section class="tab" id="tab-train2">', '<section class="tab" id="tab-log">');
del('달력 범례 운동2', '<span><i class="adot w2" style="display:inline-block"></i>운동2 기록</span>\n      ');
cut('운동2 모달', '<div class="overlay" id="ov2">', '<div class="overlay" id="ovF">');
cut('운동2 영상·개인 프리셋', '/* 운동2 전용 영상 2종. 기존 V 객체와 기존 자동 매핑은 변경하지 않는다. */',
  'const PF_GENERIC=', 'const PF_PERSONAL=[];\n');
cut('운동2 상태 로드', "let workout2Data=load('workout2_data_v1',null);", "let sets=load('sets',{});");
del('운동2 편집 상태', "let workout2EditMode=false,workout2Ctx=null,workout2OpenDays=null,workout2OpenVid=new Set();\n");
del('운동2 탭 전환', " if(t==='train2')renderWorkout2();\n");
cut('운동2 모듈', '/* ── 운동2: 기존 운동 데이터·함수를 건드리지 않는 독립 모듈 ── */',
  'function presets(){return (SALE_MODE?PF_GENERIC:PF_PERSONAL);}');
del('운동2 모달 리스너', "document.getElementById('ov2').addEventListener('click',e=>{if(e.target.id==='ov2')closeOv('ov2');});\n");

/* ── 4. 달력에서 운동2 흔적 제거 ────────────────── */
rep('달력 셀 변수', ",jp=jpDoneFor(k),w2=workout2Snap[k];", ",jp=jpDoneFor(k);");
rep('달력 점 표기', "${w2?'<i class=\"adot w2\"></i>':''}", '');
rep('달력 상세 변수', 'const ws=wsnap[k],w2=workout2Snap[k],jp=jpDoneFor(k);', 'const ws=wsnap[k],jp=jpDoneFor(k);');
apply('달력 운동2 상세 블록', (s) => {
  const lines = s.split('\n');
  const kept = lines.filter((l) => !/w2Day|w2HTML|w2Label|clearWorkout2Day/.test(l));
  return kept.join('\n');
});

/* ── 5. 백업에서 운동2 필드 제거 ────────────────── */
rep('백업 내보내기 필드', ',workout2Data,workout2Sets,workout2Snap,jpState:', ',jpState:');
rep('백업 복원 필드', "\t  if(j.workout2Data)save('workout2_data_v1',j.workout2Data);if(j.workout2Sets)save('workout2_sets_v1',j.workout2Sets);if(j.workout2Snap)save('workout2_snap_v1',j.workout2Snap);\n", '');

/* ── 6. 개인 신상·신체·일정 제거 ────────────────── */
rep('프로필 기본값', "if(!SALE_MODE&&!prof){prof={name:'',sex:'m',age:35,height:0,activity:'high',cur:96,goal:80,target:'2026-10-25',kcal:2400,prot:170};save('prof',prof);}",
  'if(!SALE_MODE&&!prof){prof=null;}');
rep('D-day 기본 목표일', "const t=new Date((prof.target||'2026-10-25')+'T00:00:00')", "const t=new Date((prof.target||'2099-12-31')+'T00:00:00')");
rep('체중 입력 예시', "placeholder=\"${lastW||'96.0'}\"", "placeholder=\"${lastW||'75.0'}\"");
rep('온보딩 현재 체중', '<label>현재 체중 (kg)</label><input id="obC" type="number" step="0.1" placeholder="96">',
  '<label>현재 체중 (kg)</label><input id="obC" type="number" step="0.1" placeholder="75">');
rep('온보딩 목표 체중', '<label>목표 체중 (kg)</label><input id="obG" type="number" step="0.1" placeholder="80">',
  '<label>목표 체중 (kg)</label><input id="obG" type="number" step="0.1" placeholder="68">');
rep('푸터 문구', "(SALE_MODE?'CUT TRACKER':'96 → 80 · CUTTING PROTOCOL')", "'TRAVEL ROUTINE'");
rep('근무 시간표 슬롯', '<div class="time">16:00–16:30 · 메인식</div><div class="what">스태프밀 = 탄수 몰빵 자리</div>',
  '<div class="time">일정에 맞춘 메인 식사</div><div class="what">하루 탄수화물의 중심 식사</div>');

/* ── 7. 개인 경력이 드러나는 일본어 문장 교체 ───── */
rep('경력 문장 1', "JL('韓国でも魚を扱う仕事をしていました。','かんこくでも さかなを あつかう しごとを していました。','한국에서도 생선을 다루는 일을 했어요.')",
  "JL('魚料理と職人の技に興味があります。','さかなりょうりと しょくにんの わざに きょうみが あります。','생선 요리와 장인의 기술에 관심이 있어요.')");
rep('경력 문장 2', "JL('仕事で魚をおろしていたので、すごく興味があります。','しごとで さかなを おろしていたので、すごく きょうみが あります。','일로 생선을 손질했어서 정말 관심이 있어요.')",
  "JL('魚のさばき方を詳しく見てみたいです。','さかなの さばきかたを くわしく みてみたいです。','생선 손질법을 자세히 보고 싶어요.')");
rep('경력 문장 3', "JL('実は飲食の仕事を十年以上していました。','じつは いんしょくの しごとを じゅうねんいじょう していました。','사실 요식업 일을 10년 넘게 했어요.')",
  "JL('料理の話を聞くのが好きです。','りょうりの はなしを きくのが すきです。','요리 이야기를 듣는 것을 좋아해요.')");
rep('주차 소제목', "'혼자 여행','경력 소개','다음 방문'", "'혼자 여행','관심 소개','다음 방문'");
rep('대화 화자 이름', "(i%2?'店主':'윤식')", "(i%2?'店主':'학습자')");
rep('AI 역할 프롬프트', '사용자는 일본어 회화를 연습하는 한국인 F&B 경력자다.', '사용자는 일본어 회화를 연습하며 음식과 술에 관심이 많은 한국인 여행자다.');

/* ── 8. 최종 안전 검사 ─────────────────────────── */
const BANNED = [
  'workout2_data_v1', 'workout2_sets_v1', 'workout2_snap_v1', 'id="tab-train2"',
  '86~88kg', '170~190g', '05:30~12:00', '스태프밀', '윤식', '96 → 80',
  'F&B 경력자', '경력 소개', '十年以上'
];
let bad = 0;
for (const token of BANNED) {
  if (html.includes(token)) {
    console.error(`FAIL  판매용에 남으면 안 되는 문자열: ${token}`);
    bad += 1;
  }
}
if (/AIza[0-9A-Za-z_-]{25,}/.test(html)) {
  console.error('FAIL  하드코딩된 Google API 키 패턴');
  bad += 1;
}
for (const must of [
  'const SALE_MODE=true;', 'id="tab-train"', 'id="tab-jp"', 'id="tab-map"', 'id="tab-guide"',
  'const JP_LIMIT=90', 'function jpRuby(', 'function jpGrammarBookHTML(',
  'function fm2Clusters()', 'function fm2RenderOverview()', 'function fmEnrichAll()',
  'function asContext()', 'function asAsk()', 'const AS_RULES=',
  'function bgAdd()', 'function bgHTML()',
  'function csBuild()', 'function csOrder(', 'const CS_GOALS=',
  'function plBuild()', 'function fmClosedDays(p)',
  'function fmFillHours()', 'function fmOpenAt(', 'places.regularOpeningHours',
  'const SJ_BANK=', 'function sjTags(p)', 'function sjPick(p,limit)',
  'function fmPanel(', 'function fmPanelOpen(k)',
  'function affUrl(k)', 'const AFF_DEFAULT=',
  'function fmGuideHTML()', 'const GUIDE_STEPS=',
  'async function fxFetch(quiet)', 'function fxHomeTxt(amount)',
  'function phRead(buf)', 'function phNearest(', 'function phAnalyze(kind)',
  "o['제목']", 'function autoVid(name)'
]) {
  if (!html.includes(must)) {
    console.error(`FAIL  판매용에 있어야 하는 기능 누락: ${must}`);
    bad += 1;
  }
}
try {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  scripts.forEach((code) => new Function(code));
} catch (error) {
  console.error(`FAIL  생성된 판매용 구문 오류 — ${error.message}`);
  bad += 1;
}
if (bad) process.exit(1);

fs.writeFileSync(OUT, html, 'utf8');
console.log(`적용된 변환 ${log.length}건`);
log.forEach((l) => console.log(`  · ${l}`));
console.log(`\n판매용 생성 완료 → ${path.relative(ROOT, OUT)}`);
