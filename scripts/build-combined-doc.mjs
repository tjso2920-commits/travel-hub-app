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

// 2026-09-12 재검토(15차, 2차 독립검토 후속) — "최종 답변 맨 앞에는
// ①이번 수정 결과 ②PC에서 실행할 명령과 접속 주소 ③실제 휴대폰
// 테스트를 위해 다음에 준비할 설정, 이 세 가지만 짧게" 요구를 그대로
// 반영. 자세한 근거·표는 전부 아래 1번 문서(RELEASE_STATUS -6절)·
// 4번 문서(OPERATIONS_SETUP 0-3절)에 있으므로 여기서는 반복하지 않는다.
parts.push('## 0. 요약(자세한 근거·표는 아래 1번·4번 문서 본문 참고)\n');
parts.push(`**① 이번 수정 결과**
ChatGPT의 2차 독립검토(HTTP 중심 — 실제 브라우저·공급자·휴대폰까지는
아님)가 지적한 두 가지를 처리했다: (a) \`server/index.mjs\`의
직접실행 판정이 Windows·공백 경로에서 항상 실패하던 구조적 결함을
\`pathToFileURL\` 비교로 수정하고 공백 있는 폴더에서 실제 실행해
확인(단, 실제 Windows 머신 실행 자체는 이 세션에 Windows 환경이 없어
미검증), (b) 실행 안내 문서의 부정확한 서술(Node 버전, Windows 명령
혼용, "호스팅 없음" 단정, HTTPS=도메인 필수라는 단정, development
모드 화면확인과 실제 연결의 혼동)을 정정. 새 기능은 없다.

**② PC에서 실행할 명령과 접속 주소**
Node.js **24 이상** 설치 후, 이 코드 압축을 푼 폴더에서 터미널 2개
(운영체제별 정확한 문법은 \`OPERATIONS_SETUP.md\` 0-3-1절 참고 —
Windows는 명령 프롬프트/PowerShell 중 하나만 골라 쓴다):
\`\`\`
# 터미널 1 — API 서버 (macOS/Linux 예시)
DB_PATH=./travelhub-test.db APP_ENV=development node server/index.mjs

# 터미널 2 — 프런트+API 중계 서버
node scripts/serve.mjs
\`\`\`
같은 기기 브라우저로 \`http://localhost:4173/\`을 열면 자동으로
\`/design/\`으로 이동하며 실제 화면이 뜬다. 같은 주소의 \`/api/health\`로
API 중계 여부를 확인할 수 있다. **이 상태는 development 모드라 실제
이메일 발송·실제 결제는 일어나지 않는다** — 화면·흐름 확인용이다.

**③ 실제 휴대폰 테스트를 위해 다음에 준비할 설정**
1. 같은 Wi-Fi의 HTTP로는 화면·가져오기 정도만 확인 가능 — Google
   로그인·GPS·결제 복귀까지 보려면 HTTPS 주소가 따로 필요하다
   (\`OPERATIONS_SETUP.md\` 0-3-2절). **본인 도메인 구매가 유일한
   방법은 아니다** — 이미 쓰는 호스팅이 있다면 그 서브도메인으로도
   될 수 있다(단, 그 서비스가 Node.js 프로세스 실행을 지원하는지는
   이 세션이 확인할 수 없다). 저장소의 \`.github/workflows/pages.yml\`은
   정적 파일만 배포할 뿐 API 서버는 배포하지 않으므로 그것만으로는
   백엔드 기능이 동작하지 않는다.
2. 이메일(Resend) + 토스 테스트 결제부터 실키를 연결한다(가장 급함).
3. Google Places/Routes 키, 그다음 Google 로그인(\`GOOGLE_CLIENT_ID\`)
   — 15차에서 완성한 기존 계정 연결 화면은 이 값을 넣어야 실제로 켜진다.
4. 위 과정을 \`OPERATIONS_SETUP.md\` 3-0절의 7단계 순서·성공기준
   그대로 확인하고, 실제 기기(운영자 본인 iPhone 우선, 그다음 Android)로
   확인한다 — 실제 공급자 연결과 iPhone/Android 실기기는 아직 전부
   미검증이다.
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
