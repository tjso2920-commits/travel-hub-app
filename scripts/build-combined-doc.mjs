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
parts.push('# travel hub — 전달 문서 모음 (2026-09-22, 18차 + 출시 전 최종검수)\n');
parts.push('이 파일 하나에 RELEASE_STATUS·BUSINESS_DECISIONS·MARKETING_LAUNCH_PLAN·OPERATIONS_SETUP\n네 문서를 전부 이어 붙였다. 각 문서 맨 앞에 가장 최신 회차가 온다.\n');

// 2026-09-22(18차) 10절 — "통합 문서 맨 앞에: 사용자가 먼저 할 일, 된 것/
// 안 된 것/미검증, 실행 방법과 접속 환경, 결정할 것(영업시간 제공량·운영 예산)."
parts.push('## 0. 맨 앞 요약\n');
parts.push(`### 0-1. 지금 가장 먼저 할 일(하나)

**내 PC에서 켜 보기** — Node.js 24 LTS 설치 → 받은 폴더의 \`start-windows.cmd\` 더블클릭 →
브라우저에서 \`http://localhost:8787/\` → 새 앱 화면이 뜨는지 확인. 그다음 Google 로그인(4번 문서 0-E ②).
(이 주소는 사용자 PC 안의 주소다. 이번 작업은 원격 작업 환경에서 했고, 그 환경의 주소는 사용자가 열 수 없다.)

### 0-2. 된 것 / 안 된 것 / 미검증

| 구분 | 내용 |
|---|---|
| 된 것 | 날짜별 일정(날짜·요일·시간대·출발 시각·방문 시각·날짜 옮기기·빼기·되돌리기), 영업시간 확인(누를 때만·저장 안 함·기존 약속 예산 보호), 최종검수 결함 9건 재현·수정, 새 앱 진입점 정리(옛 앱 링크 제거·한 주소 구성·오프라인 대표 주소), 판매 중지 안내·대기 주문 예약·주문 조건 보존, 비용 원장 분리, 내 PC 한 번에 켜기·자동 백업 |
| 안 된 것(결정 대기) | 영업시간 제공량 약속, 운영 예산 증액, 운영 호스팅(https 주소), GitHub Pages 대표 주소 전환(master 병합 안 함), 제휴 신청 |
| 미검증 | 실제 Google(장소·경로·영업시간)·토스·Resend 호출, iPhone·Android 실기기, Windows에서의 실행, Node 24에서의 실행, 영업시간 단가($20 vs $35) |

### 0-3. 실행 방법과 접속 환경

- 실행: \`start-windows.cmd\`(Windows) 또는 \`node scripts/start-local.mjs\`(macOS·Linux). \`npm install\` 불필요.
- 접속: 같은 PC 브라우저에서 \`http://localhost:8787/\`(→ 새 앱 \`/design/\`). 기본은 이 PC 안에서만 열린다.
- 데이터: \`사용자 폴더\\travelhub\\travelhub.db\` — 켤 때마다 자동 백업(\`backups\`, 최근 10개).
- 설정: \`.env.example\`을 \`local.env\`로 복사해 키를 넣는다(저장소·ZIP에 안 들어감). 비워 두면 전부 테스트 모드.
- 기존 폴더는 지우지 말고 새 폴더에 푼다(4번 문서 0-D).

### 0-4. 사용자가 정할 것(두 가지)

1. **영업시간 제공량** — 지금 상한으로는 유료 4~11곳. 추천은 A안(약속하지 않고 남는 여유 안에서만). 2번 문서 0-4.
2. **운영 예산** — 지금 월 27,000원이면 이용권 7개까지. 베타 유료 10명이면 설정안 2(월 50,000원). 2번 문서 0-5.
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
