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
parts.push('# travel hub — 전달 문서 모음 (2026-09-11, 14차 재검토)\n');
parts.push('이 파일 하나에 RELEASE_STATUS·BUSINESS_DECISIONS·MARKETING_LAUNCH_PLAN·OPERATIONS_SETUP\n네 문서를 전부 이어 붙였다(다운로드 편의 + ChatGPT가 한 번에 읽을 수 있게).\n앞으로도 문서 전달은 이 방식(파일 하나)으로 한다.\n각 원본 문서 맨 앞에는 그 문서의 가장 최신 회차 갱신 요약이 오도록\n이미 정렬돼 있다(RELEASE_STATUS.md는 "-4. 14차 재검토 갱신 요약"이\n맨 앞) — 이 통합본도 그 순서를 그대로 이어 붙이므로 최신 내용이\n항상 먼저 보인다.\n');

// 2026-09-11 재검토(13차) 9절 — "통합 문서 맨 앞에 다음만 간단히
// 정리하라": 해결한 결함, 구현-실제연결 차이, 베타공개 차단 항목,
// 이후 개선 가능한 항목, 사용자의 다음 최소 행동. 아래 4개 소스
// 문서 전문과는 별개로, 여기서 딱 이 5묶음만 간단히 요약한다(자세한
// 근거는 각 문서 본문 참고). 14차 재검토 8절 — "① 이번에 해결한
// 문제, ② 베타 전 남은 필수 항목, ③ 1단계부터 순서대로 사용자
// 설정 단계, ④ 이후 개선 가능 항목"을 그대로 이 구조에 맞춰 갱신.
parts.push('## 0. 요약 — 지금 상태를 한눈에(자세한 근거는 아래 각 문서 본문 참고)\n');
parts.push(`**① 이번(14차)에 해결한 문제(재현·검증 근거 포함) — 새 기능 없이 결함 수정만**
- Google 로그인 계정 탈취 취약점 — 이메일만 보고 계정을 연결하던 것을 Google의 안정 식별자(sub) 기준으로 재설계. 기존 계정과 같은 이메일·처음 보는 sub인 토큰이 추가 확인 없이 로그인되던 결함을 실제로 재현·차단(기존 세션 또는 이메일 인증 코드로 소유확인 필요)(\`server/test/google-auth.test.mjs\`).
- 지도 링크 추가 — "@lat,lng"(지도 화면 중심)를 장소의 확정 좌표로 잘못 저장하던 버그 수정, 저장 실패 시 롤백·복구 안내 추가, 축약 링크 리다이렉트를 매 홉마다 검사하도록 강화(\`server/test/place-link.test.mjs\`, \`scripts/test-map-link-add.mjs\`).
- AI 비용 통제 — 자리표시자 단가(3원/건) 대신 실제 입력크기·출력상한 기준 사전 견적 + 응답 usage 기반 확정 정산으로 재설계, 중복 응답·잘린 응답 방어 강화(\`server/test/ai-classify-real-adapter.test.mjs\`).
- 일본어 회화 — reading(가나)과 실제로 다른 한글 발음(kr) 필드 신규 추가, 4초 재생 타이머가 정상 재생 중에도 강제로 "재생 실패"를 띄우던 버그 수정, 크게 보기 기능 추가(\`scripts/test-phrasebook.mjs\`).
- 서버 테스트 45개 + 화면(Chromium) 테스트 31개(13차와 동일 파일 수), 합계 76개 파일을 마지막에 한 번에 실행해 전부 통과 확인.

**② 베타 공개 전 남은 필수 항목(13차와 동일 — 이번 라운드는 새로 안 늘림)**
- 실제 결제 승인 테스트 미완료(토스 실키 미연결).
- 실제 iPhone Safari·베타 참가자 Android Chrome/Samsung Internet 핵심 흐름(가져오기·분류/검색·코스생성·저장/재로그인·일본어 듣기·결제) 미확인 — 이번 라운드에 그 확인 순서를 \`OPERATIONS_SETUP.md\` 3-1절에 새로 정리했다.
- 실제 AI 공급자 미선정 — AI 보조 분류는 계속 비활성 상태로 출시해야 함(이번 라운드에 비용 정산 방식만 실제 usage 기준으로 고쳤을 뿐, 실제로 켜는 결정은 그대로 남아 있음).
- Google 로그인은 있으면 좋지만 없어도 이메일 코드 로그인으로 서비스 전체가 동작하므로 차단 항목은 아님(이번 라운드에 계정 탈취 결함은 코드로 이미 막아 뒀다 — GOOGLE_CLIENT_ID 발급 후 바로 안전하게 켤 수 있는 상태).

**③ 사용자의 설정 단계 — 1단계부터 순서대로**
1. **서버 실행 환경 확인** — 지속 저장소(DB_PATH)가 컨테이너 재시작에도 남는지, 정기 백업·복원 절차를 한 번 리허설했는지 먼저 확인한다(\`OPERATIONS_SETUP.md\` 0-1절, 이번 라운드 신규).
2. **이메일(Resend) + 토스 테스트 결제**부터 실제로 연결·확인한다(가장 급함 — 6절 우선순위 체크리스트).
3. **Google Places/Routes 키**를 넣고 실제 위치확인·코스생성 1건씩 확인한다.
4. **폰에서 전체 흐름을 순서대로 확인**한다 — 가져오기→분류/검색→실제 코스→저장/재로그인→일본어 듣기→테스트 결제(\`OPERATIONS_SETUP.md\` 3-1절 신규). 운영자 본인의 iPhone Safari로 먼저 확인한 뒤, 베타 참가자에게는 Android Chrome/Samsung Internet에서도 같은 순서를 부탁한다.
5. **소수 베타 참가자에게 배분**하고 "불편함 보내기"로 결과를 받는다.
6. 여유가 되면 **Google 로그인(GOOGLE_CLIENT_ID)**·날씨 키를 마저 연결한다(계정 탈취 결함은 이미 수정돼 있어 안전하게 켤 수 있다).
7. **AI 공급자는 가장 마지막** — 실제로 켜기 전 소량으로 먼저 실제 청구 비용을 확인한다(이번 라운드부터 usage 기준으로 정산되므로 원장 숫자가 실제 청구서와 더 가깝게 맞을 것으로 기대되지만, 실제 대조 검증은 아직 안 했다).
8. 위 과정이 실제로 끝나기 전까지는 "출시 준비 완료"로 판단하지 않는다.

**④ 이후 개선 가능한 항목(막는 항목은 아님, 13차와 동일)**
- AI 캐시·동시성 보호는 이 프로세스(단일 서버 인스턴스) 안에서만 유효 — 여러 서버로 수평 확장하면 각자 중복 제거(문서에 이미 명시된 한계).
- 일본어 회화 문장 세트 확장 + 원어민 감수, 지도 링크 추가 기능의 축약 링크 지원 범위 확장.
- Google 로그인의 소유확인(이메일 코드) 경로에 클라이언트 화면(현재는 세션 기반 자동 통과만 UI 없이 지원, 코드 없이 처음 시도하면 이메일 로그인으로 자연스럽게 대체됨)을 별도로 다듬는 것.
- 태그 어휘·영어 번역·실기기 자동화(Firefox/WebKit 설치)는 필요해지면 별도로 확장.
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
