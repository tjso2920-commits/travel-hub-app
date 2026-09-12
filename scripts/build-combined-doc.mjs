/**
 * 전달문서_통합본.md를 4개 원본 문서(RELEASE_STATUS/BUSINESS_DECISIONS/
 * MARKETING_LAUNCH_PLAN/OPERATIONS_SETUP)로부터 기계적으로 재생성한다.
 * 각 원본의 첫 H1 줄만 제거하고(통합본의 "## N. 원제목" 감싸기 헤더가
 * 그 역할을 대신함) 본문은 그대로 이어 붙인다 — 사람이 손으로 옮기다
 * 생기는 누락·오타를 막기 위해서다.
 *
 * 실행: node scripts/build-combined-doc.mjs
 */
import fs from 'node:fs';

const DOCS_DIR = 'docs';
const sources = [
  { file: 'RELEASE_STATUS.md', num: 1, title: '출시 상태 (RELEASE_STATUS)' },
  { file: 'BUSINESS_DECISIONS.md', num: 2, title: '사업 결정 정리 (travel hub) — ChatGPT 판단용' },
  { file: 'MARKETING_LAUNCH_PLAN.md', num: 3, title: '사전 출시 마케팅 계획 (travel hub)' },
  { file: 'OPERATIONS_SETUP.md', num: 4, title: '운영 서버 설정 순서 (OPERATIONS_SETUP)' },
];

function bodyWithoutH1(text) {
  const lines = text.split('\n');
  // 첫 줄이 그 문서의 H1('# ...')이라고 가정하고 제거, 그 다음 빈 줄도 하나 제거.
  if (lines[0].startsWith('# ')) lines.shift();
  while (lines[0] === '') lines.shift();
  return lines.join('\n').replace(/\n+$/, '\n');
}

const parts = [];
parts.push('# travel hub — 전달 문서 모음 (2026-09-12, 15차 재검토)\n');
parts.push('이 파일 하나에 RELEASE_STATUS·BUSINESS_DECISIONS·MARKETING_LAUNCH_PLAN·OPERATIONS_SETUP\n네 문서를 전부 이어 붙였다(다운로드 편의 + ChatGPT가 한 번에 읽을 수 있게).\n앞으로도 문서 전달은 이 방식(파일 하나)으로 한다.\n각 원본 문서 맨 앞에는 그 문서의 가장 최신 회차 갱신 요약이 오도록\n이미 정렬돼 있다 — 이 통합본도 그 순서를 그대로 이어 붙이므로 최신 내용이\n항상 먼저 보인다.\n');

// 2026-09-12 재검토(15차, 4차 후속) — "이제 코드 재검토 반복이 아니라
// 실제 연결·휴대폰 테스트로 넘어가라, 문서 분량 증가가 목표가
// 아니다"라는 지시 반영. 요약을 다시 늘리지 않고, 이번에 실제로
// 완성한 코드(백업 스크립트·테스트모드 배너)와 사용자가 지금 할
// 최대 3단계만 짧게 적는다. 자세한 근거는 1번 문서(-7절)·4번 문서
// (6절 우선순위, 3-0절 7단계)에 있다.
parts.push('## 0. 요약(자세한 근거는 아래 1번·4번 문서 본문 참고)\n');
parts.push(`이번 라운드는 문서가 아니라 **실행 가능한 코드**를 완성하는 데
집중했다: (a) \`scripts/backup-db.mjs\` 신규 — 외부 CLI 없이
node:sqlite만으로 DB 온라인 백업, (b) 서버가 테스트 모드(실키 없음)로
떠 있으면 화면에 경고 배너가 뜨도록 신규 — 베타 참가자가 가짜
응답을 실제 서비스로 착각하지 않게 함. 우선순위도 재정렬했다 —
**Google 로그인(+이메일 대체 경로)을 최우선**으로, 그다음
Places/Routes → 토스 테스트결제 → 날씨 → 베타 배포 → AI(그대로
최후) 순. 휴대폰 테스트 절차는 가져오기→분류·검색→테스트 위치
(후쿠오카)→장소확인·코스생성→저장·재로그인→테스트결제 한 흐름으로
통합했다(가격·이용권 수량·승인 디자인은 그대로).

**사용자가 지금 할 일(최대 3단계)**은 이 답변 맨 앞에 적혀 있다 —
여기서 반복하지 않는다.
`);

parts.push('---\n');
parts.push('## 차례\n');
parts.push(sources.map((s) => `- ${s.num}. ${s.title}`).join('\n') + '\n');
parts.push('---\n');

for (const s of sources) {
  const raw = fs.readFileSync(`${DOCS_DIR}/${s.file}`, 'utf8');
  parts.push(`## ${s.num}. ${s.title}\n`);
  parts.push(bodyWithoutH1(raw));
}

const combined = parts.join('\n').replace(/\n{4,}/g, '\n\n\n');
fs.writeFileSync(`${DOCS_DIR}/전달문서_통합본.md`, combined, 'utf8');
console.log('재생성 완료: docs/전달문서_통합본.md (' + combined.split('\n').length + ' 줄)');
