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
parts.push('# travel hub — 전달 문서 모음 (2026-09-23, 18차 재검토 수정본)\n');
parts.push('이 파일 하나에 RELEASE_STATUS·BUSINESS_DECISIONS·MARKETING_LAUNCH_PLAN·OPERATIONS_SETUP\n네 문서 원본을 전부 이어 붙였다. 각 문서 맨 앞에 가장 최신 회차가 온다.\n');

// 2026-09-23(18차 재검토) — "최종 문서 맨 앞: 수정 결과, 재현 근거, 미검증 항목,
// 필요한 결정, 사용자의 첫 행동." 실사용 테스트를 시작하는 짧은 순서를 맨 위에 둔다.
parts.push('## 0. 맨 앞 요약\n');
parts.push(`### 0-1. 지금 할 일 — 실사용 테스트 시작 순서(앞 단계가 되면 다음으로)

1. Windows PC에서 받은 폴더의 \`start-windows.cmd\` 더블클릭(처음이면 Node.js 24 LTS 먼저 설치).
2. 같은 PC 브라우저에서 \`http://localhost:8787/\` → **새 앱 화면**이 뜨는지 확인.
3. **Google 로그인**(4번 문서 0-E ②).
4. 실제 키를 넣고 **소량만**: 장소 위치 확인 2~3곳 → 코스 1개 만들기 → 영업시간 확인 3곳 → 도보 경로 확인.
5. 토스페이먼츠 **테스트 키**로 결제 한 번 → 결제 후 앱으로 돌아오는지.
6. https 주소(운영 호스팅)를 정한 뒤 **PC·iPhone·Android에서 같은 계정**으로 로그인해 같은 코스가 보이는지.

(\`localhost:8787\`은 사용자 PC 안의 주소다. 이번 작업은 원격 작업 환경에서 했고, 그 환경의 주소는 사용자가 열 수 없다.)

### 0-2. 이번 재검토 수정 결과와 재현 근거

| # | 오류 | 수정 전 실제 결과 | 수정 후 |
|---|---|---|---|
| 1-A | 날짜 없는 24시간 영업이 휴무로 판정 | "이 날은 휴무예요" | "24시간 영업" |
| 1-B | 폐업인데 "정보 없음" 먼저 표시 | "등록된 영업시간 정보가 없어요" | "구글 지도에 폐업으로 표시된 곳이에요" |
| 2 | 새 날짜로 옮기기→동기화→되돌리기 후에도 서버에 새 날짜가 남음 | 두 기기 테스트에서 새로고침·재로그인·다른 기기에 10-07이 되살아남(5건 실패) | 되돌리기 → 동기화 → 새로고침 → 재로그인 → 다른 기기 모두 사라짐 |
| 3 | 같은 날짜 코스를 옛 기준으로 올리면 조용히 덮어씀 | 서버가 충돌 없이 덮어씀 | 충돌로 알리고 두 기기 수정을 합침. 다른 날짜는 둘 다 보존 |
| 4 | 좌표 없을 때 옛 이동시간(9분)·0분을 확정값처럼 표시, 경도 없으면 NaN | 9분 / 0분(추정) / NaN | "이동시간 미확인 · 재계산 필요" |
| 5 | 영업시간 단가 $35(49원)로 계산 | 49원 | 공식 $20 → 28원(환율 여유 15%는 별도 값) |

자세한 재현 방법·파일은 1번 문서 -16절.

### 0-3. 미검증(모의·가짜로만 확인한 것)

실제 Google(장소·경로·영업시간)·토스·Resend 호출은 0건 — 전부 테스트 어댑터로만 확인했다. iPhone·Android 실기기,
Windows에서 실행, Node 24에서 실행, 운영 호스팅은 확인하지 않았다(화면 검사는 원격 환경의 헤드리스 Chromium).
공식 가격 페이지는 이 세션에서 직접 열어 보지 못했다(재검토에 제시된 공식 값 사용). 제휴 수익화는 완료가 아니다.

### 0-4. 정해 주실 것

1. **영업시간 제공 안** — 1(권장): 약속 없이 여유 안에서만(무료 5곳·유료 약 6곳) / 2: 유료 20곳 약속, 유료 원가 상한
   3,500 → 4,000원 / 3: 유료 40곳 약속, 상한 → 4,600원. 지금 상한 3,500원으로는 20곳도 약속할 수 없다(3,850원 필요). 2번 문서 0절.
2. **운영 예산** — 지금 월 27,000원이면 이용권 7개까지. 2번 문서 0-5.
3. **운영 호스팅(https 주소)** — 4번 문서 0절.

가격(9,900원)·기존 제공량·원가 상한·월 예산은 이번에 바꾸지 않았다.

### 0-5. 실행 방법과 접속 환경

- 실행: \`start-windows.cmd\`(Windows) 또는 \`node scripts/start-local.mjs\`(macOS·Linux). \`npm install\` 불필요.
- 접속: 같은 PC 브라우저에서 \`http://localhost:8787/\`(→ 새 앱 \`/design/\`). 기본은 이 PC 안에서만 열린다.
- 데이터: \`사용자 폴더\\travelhub\\travelhub.db\` — 켤 때마다 자동 백업(\`backups\`, 최근 10개). 이번 버전은 켤 때
  날짜별 코스 표에 버전 열을 자동으로 추가한다(기존 데이터 유지).
- 설정: \`.env.example\`을 \`local.env\`로 복사해 키를 넣는다(저장소·ZIP에 안 들어감). 비워 두면 전부 테스트 모드.
- 기존 폴더는 지우지 말고 새 폴더에 푼다(4번 문서 0-D).
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
