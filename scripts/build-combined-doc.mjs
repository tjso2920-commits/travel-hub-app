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
parts.push('# travel hub — 전달 문서 모음 (2026-09-23, 18차 재검토 2차 수정본)\n');
parts.push('이 파일 하나에 RELEASE_STATUS·BUSINESS_DECISIONS·MARKETING_LAUNCH_PLAN·OPERATIONS_SETUP\n네 문서 원본을 전부 이어 붙였다. 각 문서 맨 앞에 가장 최신 회차가 온다.\n');

// 2026-09-23(18차 재검토 2차) — "문서 첫머리에 수정 결과·남은 미검증·사용자 PC 실행 순서."
parts.push('## 0. 맨 앞 요약\n');
parts.push(`### 0-1. 사용자 PC 실행 순서(앞 단계가 되면 다음으로)

1. Windows PC에서 받은 폴더의 \`start-windows.cmd\` 더블클릭(처음이면 Node.js 24 LTS 먼저 설치).
2. 같은 PC 브라우저에서 \`http://localhost:8787/\` → **새 앱 화면**이 뜨는지 확인.
3. **Google 로그인**(4번 문서 0-E ②).
4. 실제 키를 넣고 **소량만**: 장소 위치 확인 2~3곳 → 코스 1개 → 영업시간 확인 3곳 → 도보 경로 확인.
5. 토스페이먼츠 **테스트 키**로 결제 한 번 → 결제 후 앱으로 돌아오는지.
6. https 주소(운영 호스팅)를 정한 뒤 **PC·iPhone·Android에서 같은 계정**으로 같은 코스가 보이는지, 한 기기에서 고친 뒤 다른 기기에서 되돌리기가 어떻게 안내되는지.

(\`localhost:8787\`은 사용자 PC 안의 주소다. 이번 작업은 원격 작업 환경에서 했고, 그 환경의 주소는 사용자가 열 수 없다.)

### 0-2. 이번 수정 결과(재현 → 수정 → 회귀)

| # | 문제 | 수정 전 | 수정 후 |
|---|---|---|---|
| 1 | 되돌리기가 다른 기기의 최신 변경까지 지움 | 다른 기기가 추가한 날짜 삭제, 고친 메모가 옛 값으로(두 기기 화면 테스트 15건 실패) | 내가 바꾼 날짜만 되돌림. 그 사이 다른 기기가 바꿨으면 되돌리지 않고 알림 |
| 1-부 | 키 순서만 다른 같은 내용을 "바뀜"으로 오판 | 거짓 충돌·옛 내용 재업로드 | 순서 무관 비교 |
| 2 | 다음 날 특별 휴무 전날 밤 24시간 영업 체류 | "24시간 영업" | "다음날 00:00에 영업 종료(다음 날 특별 휴무)" |
| 3 | 이동시간 미확인 뒤 장소 | "영업 중 도착"으로 확정 | "도착 시각 미확인 — 방문 가능 여부 판단 보류" |
| 4 | 유료 영업시간 40회 안 | — | 2번 문서 0절: 조회 횟수·실패 차감·상한(4,600/4,800원)·하루 한도에 걸리는 경우를 지금 코드로 계산. **운영 설정은 안 바꿈** |

자세한 재현 근거는 1번 문서 -17절(그 전 수정은 -16절).

### 0-3. 남은 미검증(모의·가짜로만 확인한 것)

실제 Google(장소·경로·영업시간)·토스·Resend 호출은 0건 — 전부 테스트 어댑터. Windows·iPhone·Android 실기기, 운영 호스팅,
공식 가격 페이지 직접 열람, 무료 구간 실제 적용은 확인하지 않았다(화면 검사는 원격 환경의 헤드리스 Chromium, Node 22.22.2).
제휴 수익화는 완료가 아니다.

### 0-4. 정해 주실 것

1. **유료 영업시간 40회** — 안 a(실패도 1회 차감, 유료 원가 상한 4,600원) / 안 b(실패 미차감 + 재시도 4회, 4,800원 + 코드 변경) / 보류.
   어느 안이든 하루 한도(계정 30회·서비스 전체 3,000원) 때문에 "하루에 몰아서 40회"는 안 된다. 2번 문서 0절.
2. **운영 예산** — 상한을 올리면 월 27,000원으로 동시에 팔 수 있는 이용권이 7개 → 5개. 2번 문서 0-5.
3. **운영 호스팅(https 주소)** — 4번 문서 0절.

가격(9,900원)·기존 제공량·기존 구매자 조건·월 예산은 이번에 바꾸지 않았다.

### 0-5. 실행 방법과 접속 환경

- 실행: \`start-windows.cmd\`(Windows) 또는 \`node scripts/start-local.mjs\`(macOS·Linux). \`npm install\` 불필요.
- 접속: 같은 PC 브라우저에서 \`http://localhost:8787/\`(→ 새 앱 \`/design/\`). 기본은 이 PC 안에서만 열린다.
- 데이터: \`사용자 폴더\\travelhub\\travelhub.db\` — 켤 때마다 자동 백업(\`backups\`, 최근 10개). 날짜별 코스 표의 버전 열은
  켤 때 자동으로 추가된다(기존 데이터 유지).
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
