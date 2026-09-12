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

// 2026-09-12 재검토(15차, 후속 지시) 5절 — "맨 앞에는 사용자가
// PC에서 실행할 명령, 접속 주소, 그다음 필요한 HTTPS·키 설정만
// 짧게 정리하세요." 이전 갱신에서 썼던 5묶음 요약(마무리/남은필수/
// 첫행동/설정순서/미검증)보다 더 짧게, 실행 순서 중심으로 다시 썼다.
// 자세한 근거·표는 전부 아래 1번 문서(RELEASE_STATUS -5절)·4번
// 문서(OPERATIONS_SETUP 0-3절)에 있으므로 여기서는 반복하지 않는다.
parts.push('## 0. 지금 바로 할 일(자세한 근거·표는 아래 1번·4번 문서 본문 참고)\n');
parts.push(`**PC에서 실행할 명령** (Node.js 설치 후, 이 코드 압축을 푼 폴더에서
터미널 2개— 운영체제별 표현 차이는 \`OPERATIONS_SETUP.md\` 0-3-1절 참고):
\`\`\`
# 터미널 1 — API 서버
DB_PATH=./travelhub-test.db APP_ENV=development node server/index.mjs

# 터미널 2 — 프런트+API 중계 서버
node scripts/serve.mjs
\`\`\`

**접속 주소**: 같은 기기 브라우저로 \`http://localhost:4173/\`을 열면
자동으로 \`/design/\`으로 이동하며 실제 화면이 뜬다(예전
\`npm run preview\`는 지금은 없는 옛 파일을 가리키던 죽은 명령이었는데
이번에 고쳤다 — 루트 경로 정적 자산 404 버그도 함께 수정됨).
같은 주소의 \`/api/health\`로 API 중계가 되는지 확인할 수 있다.
**폰에서 열려면**: 같은 Wi-Fi면 PC의 사설 IP로 열 수 있지만(제한된
확인만 가능), Google 로그인·GPS·결제 복귀까지 보려면 HTTPS 주소가
따로 필요하다 — 아래 참고.

**그다음 필요한 HTTPS·키 설정** (전부 사용자가 실제로 결정·실행해야
하는 단계 — 이 세션이 대신 계약·배포하지 않음):
1. **HTTPS 테스트 주소**: 본인 도메인 + 그 도메인이 가리키는 서버(위
   PC를 계속 켜 둬도 됨) + 그 앞의 리버스 프록시(HTTPS 종단) 세 가지가
   필요하다(\`OPERATIONS_SETUP.md\` 0-3-2절). 정적 파일 호스팅(예:
   GitHub Pages)만으로는 로그인·결제 등 어떤 백엔드 기능도 동작하지
   않는다.
2. **이메일(Resend) + 토스 테스트 결제**부터 실키를 연결한다(가장
   급함).
3. **Google Places/Routes 키**, 그다음 **Google 로그인**
   (\`GOOGLE_CLIENT_ID\`) — 이번에 완성한 기존 계정 연결 화면은 이
   값을 넣어야 실제로 켜진다.
4. 위 과정을 \`OPERATIONS_SETUP.md\` 3-0절의 7단계 순서·성공기준
   그대로 확인하고, 실제 기기(운영자 본인 iPhone 우선)로도 확인한다.
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
