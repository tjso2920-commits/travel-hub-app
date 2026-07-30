/**
 * 판매용 생성기
 * 개인용(마스터) 1개만 수정하면 판매용이 자동으로 만들어진다.
 * 손으로 두 파일을 관리하지 않는다 — 두 파일이 갈라지는 사고를 원천 차단한다.
 *
 * 규칙
 *  - 제거: 개인 경력이 드러나는 일본어 문장·화자 이름·AI 프롬프트 표현
 *  - 유지: 후쿠오카 모듈 전부, 일본어 문법 교재·후리가나, 실시간 GPS, 영상 기능
 *  - 각 변환은 반드시 1회만 일치해야 하며, 아니면 즉시 실패한다(조용한 누락 방지)
 *
 * 운동/운동2 탭은 개인용 마스터 자체에서 완전히 제거됐다(2026-07-30).
 * 따라서 이 생성기는 더 이상 운동 관련 내용을 잘라내지 않는다 — 잘라낼 대상이 없다.
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

/* ── 1. 판매 모드 ───────────────────────────────── */
rep('SALE_MODE', 'const SALE_MODE=false;', 'const SALE_MODE=true;');

/* ── 2. 개인 경력이 드러나는 일본어 문장 교체 ───── */
rep('경력 문장 1', "JL('韓国でも魚を扱う仕事をしていました。','かんこくでも さかなを あつかう しごとを していました。','한국에서도 생선을 다루는 일을 했어요.')",
  "JL('魚料理と職人の技に興味があります。','さかなりょうりと しょくにんの わざに きょうみが あります。','생선 요리와 장인의 기술에 관심이 있어요.')");
rep('경력 문장 2', "JL('仕事で魚をおろしていたので、すごく興味があります。','しごとで さかなを おろしていたので、すごく きょうみが あります。','일로 생선을 손질했어서 정말 관심이 있어요.')",
  "JL('魚のさばき方を詳しく見てみたいです。','さかなの さばきかたを くわしく みてみたいです。','생선 손질법을 자세히 보고 싶어요.')");
rep('경력 문장 3', "JL('実は飲食の仕事を十年以上していました。','じつは いんしょくの しごとを じゅうねんいじょう していました。','사실 요식업 일을 10년 넘게 했어요.')",
  "JL('料理の話を聞くのが好きです。','りょうりの はなしを きくのが すきです。','요리 이야기를 듣는 것을 좋아해요.')");
rep('주차 소제목', "'혼자 여행','경력 소개','다음 방문'", "'혼자 여행','관심 소개','다음 방문'");
rep('대화 화자 이름', "(i%2?'店主':'윤식')", "(i%2?'店主':'학습자')");
rep('AI 역할 프롬프트', '사용자는 일본어 회화를 연습하는 한국인 F&B 경력자다.', '사용자는 일본어 회화를 연습하며 음식과 술에 관심이 많은 한국인 여행자다.');

/* ── 3. 최종 안전 검사 ─────────────────────────── */
const BANNED = ['윤식', 'F&B 경력자', '경력 소개', '十年以上'];
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
  'const SALE_MODE=true;', 'id="tab-jp"', 'id="tab-map"', 'id="ovSet"',
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
  "o['제목']", 'function fmAddVideo(', 'function fmDeleteVideo(',
  'function renderSettings()', 'function showLanding()', 'function landingOpen(',
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
