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

// 2026-09-12 재검토(15차) 7절 — "통합문서 맨 앞에 (1)이번에 마무리한
// Google 연결 화면, (2)폰 테스트 전 남은 필수 항목, (3)지금 당장 할
// 첫 행동, (4)테스트 환경을 여는 데 필요한 설정 순서, (5)실제
// 연결·실기기로 아직 확인 못한 항목 — 이 5묶음만 간단히" 요구를
// 그대로 반영. 13~14차의 4묶음 구조(①해결②남은 항목③설정단계④개선
// 가능)와 항목 구성이 달라 재사용하지 않고 새로 썼다.
parts.push('## 0. 요약 — 지금 상태를 한눈에(자세한 근거는 아래 각 문서 본문 참고)\n');
parts.push(`**(1) 이번(15차)에 마무리한 것 — Google 기존 계정 연결 화면**
14차까지는 서버가 이미 "이 이메일로 다른 방식으로 가입된 계정이
있다"는 거절(409, ownership-verification-required)을 돌려주고
있었는데, 화면 쪽에는 그 거절을 받아서 사용자에게 보여줄 화면이
아예 없었다(그냥 실패 메시지만 뜨고 끝). 이번에 (a) "이미 가입된
계정이 있어요" 안내 화면, (b) 그 계정 이메일로 인증 코드를 보내
소유를 확인하는 화면, (c) 확인되면 기존 계정(저장 장소·이용권 상태
그대로)으로 로그인 완료, (d) 취소·코드 만료·틀린 코드·재전송·초대코드
필요 베타 구성까지 전부 화면으로 이어지도록 완성했다. Google
자격 증명(idToken)은 메모리에서만 오가고 localStorage 등에 저장되지
않음을 테스트로 확인했다(\`server/test/google-auth.test.mjs\`,
\`scripts/test-google-signin-configured.mjs\`).

**(2) 폰 테스트를 시작하기 전 아직 남은 필수 항목**
- 실제로 쓸 수 있는 서버·호스팅이 아직 없다(저장소 전체 확인 결과 —
  \`OPERATIONS_SETUP.md\` 0-0절). 지금 갖고 있는 서버·PC 위에
  아래 (4)의 두 프로세스를 실제로 띄우는 것이 먼저다.
- 이메일(Resend)·토스페이먼츠 실키 미연결 — 로그인도 결제도 아직
  실제로 동작 확인이 안 됐다.
- Google Places/Routes 실키 미연결 — 실제 장소·경로 확인 전.
- Google 로그인은 \`GOOGLE_CLIENT_ID\`를 아직 안 넣어서 서비스에서
  꺼져 있는 상태 — (1)에서 완성한 화면도 이 값을 넣어야 실제로 켜진다.
- 실제 아이폰·안드로이드 기기로는 아직 한 번도 확인하지 못했다(전부
  에뮬레이션·모의응답 기반 검증).

**(3) 사용자가 지금 당장 할 첫 행동**
지금 갖고 있는 서버/PC에서 아래 두 줄을 각각 다른 터미널에 실행해
프런트+API가 한 주소로 뜨는지부터 확인한다(새 계약·배포 필요 없음):
\`\`\`
DB_PATH=/data/travelhub.db APP_ENV=development node server/index.mjs
node scripts/serve.mjs
\`\`\`
그 뒤 같은 기기 브라우저로 \`http://localhost:4173/\`을 열어 실제
화면이 뜨는지 본다(\`OPERATIONS_SETUP.md\` 0-3절, 이번에 새로 고침 —
예전 \`npm run preview\`는 존재하지도 않는 옛 파일을 가리키던 죽은
명령이었다).

**(4) 테스트 환경을 여는 데 필요한 설정 순서**
\`OPERATIONS_SETUP.md\` 3-0절에 7단계로 정리했다: ① 위 (3)의 서버·
영구 DB(재시작해도 데이터가 남는지 확인) → ② 이메일 로그인(Resend
키) → ③ Google 로그인과 (1)에서 완성한 기존 계정 연결 화면 실제
확인 → ④ Google Places/Routes로 실제 장소·코스 확인 → ⑤ WeatherAPI +
실제 기기로 일본어 음성 확인 → ⑥ 토스 테스트 결제 → ⑦ 실제 AI는
예상 견적·usage·확정 비용·남은 예산이 맞는지 본 뒤 가장 마지막에
소량만 제한적으로 켜본다. 각 단계는 "키가 설정됨"이 아니라 실제
화면 조작 결과로만 통과를 판단한다.

**(5) 실제 연결·실기기로 아직 확인 못한 항목**
- (2)에 적은 이메일·결제·Places/Routes·Google 로그인 실키 연결 전부.
- 실제 Google 계정으로 (1)의 화면을 끝까지 통과하는 것 — 지금까지는
  브라우저의 네트워크 응답을 흉내 낸 모의(mock) 테스트로만 검증했다
  (실제 Google 서버와의 왕복은 이 환경에서 원천적으로 불가능해서다).
- 실제 iPhone Safari·Android Chrome/Samsung Internet 실기기 확인
  (\`RELEASE_STATUS.md\`의 재정리된 베타 확인 절차 — 운영자 본인
  iPhone 우선 → 한국-후쿠오카 가상위치 테스트 → 베타 참가자 Android).
- 실제 AI 공급자 청구 비용 대조(구조·모의 검증까지만 끝남).
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
