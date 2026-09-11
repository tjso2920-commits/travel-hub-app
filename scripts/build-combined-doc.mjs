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
parts.push('# travel hub — 전달 문서 모음 (2026-09-11, 12차 재검토)\n');
parts.push('이 파일 하나에 RELEASE_STATUS·BUSINESS_DECISIONS·MARKETING_LAUNCH_PLAN·OPERATIONS_SETUP\n네 문서를 전부 이어 붙였다(다운로드 편의 + ChatGPT가 한 번에 읽을 수 있게).\n앞으로도 문서 전달은 이 방식(파일 하나)으로 한다.\n각 원본 문서 맨 앞에는 그 문서의 가장 최신 회차 갱신 요약이 오도록\n이미 정렬돼 있다(RELEASE_STATUS.md는 "-2. 12차 재검토 갱신 요약"이\n맨 앞) — 이 통합본도 그 순서를 그대로 이어 붙이므로 최신 내용이\n항상 먼저 보인다.\n');

// 2026-09-11 재검토(12차) 9절 — "통합 문서 맨 앞에 다음만 간단히
// 정리하라": 이번에 수정한 문제/검증 근거, 실제연결·실기기 미검증
// 항목, 베타 공개를 막는 항목, 이후 개선 가능한 항목, 사용자가
// 다음에 할 최소 행동. 아래 4개 소스 문서 전문과는 별개로, 여기서
// 딱 이 5묶음만 간단히 요약한다(자세한 근거는 각 문서 본문 참고).
parts.push('## 0. 요약 — 지금 상태를 한눈에(자세한 근거는 아래 각 문서 본문 참고)\n');
parts.push(`**이번(12차)에 수정한 문제와 검증 근거**
- 태그 저장 중 수정 유실 — 저장 응답 대기 중 같은 태그를 또 고치면 사라지던 버그. places/courses/trips와 같은 3-way 재병합으로 수정, 실제 지연 응답으로 재현·확인(\`scripts/test-tag-registry-sync.mjs\`).
- AI 분류 캐시 localId 오염 — 우연히 같은 입력의 다른 장소가 서로 다른 localId를 돌려받던 버그. 캐시에서 localId 분리, 실제 재현·확인(\`server/test/ai-classify-cache-and-budget-race.test.mjs\`).
- AI 동시 요청 중복 처리·비용 2배 — Promise.all로 재현, places.mjs의 기존 동시요청 병합 패턴으로 수정(같은 파일).
- AI 헤드룸 예약 재정정 — "전형적인 하루 코스" 가정을 걷어내고 실제 최대 입력(60곳)·세그먼트·SKU로 재계산(35원/코스, 11차 14원에서 상향). 실제 실행 함수와 공유(\`server/route-segments.mjs\`), 재현·확인(\`server/test/ai-classify.test.mjs\`).
- 기기·브라우저 검증 범위 확대 — Chromium 뷰포트 에뮬레이션·글자 확대·느린 네트워크 점검 신규(\`scripts/test-cross-browser-and-viewport.mjs\`), 피드백에 브라우저 종류 추가.
- 서버 테스트 41개 + 화면(Chromium) 테스트 27개, 합계 68개 파일을 마지막에 한 번에 실행해 전부 통과 확인.

**실제 연결 및 실기기 미검증 항목**
- 실제 AI 공급자 없음(구조·모의 검증만 완료) — Google Places/Routes·토스페이먼츠·Resend·WeatherAPI는 코드는 실제 호출하지만 실 키로 검증 못 함.
- 실제 iPhone Safari, Android Chrome/Samsung Internet, macOS Safari, Instagram/Threads 인앱 브라우저 미검증. Firefox·WebKit은 이 세션 환경에 실행 파일이 없어 자동검사 자체 불가.
- Chromium 뷰포트 에뮬레이션·글자 확대 흉내는 실제 기기 검증이 아니다(그렇게 표시하지 않음).

**베타 공개를 막는 항목**
- 실제 결제 승인 테스트 미완료(토스 실키 미연결).
- 실제 iPhone 핵심 흐름(가져오기·검색·코스생성·로그인동기화·GPS·결제) 미확인.
- 실제 AI 공급자 미선정 — AI 보조 분류는 계속 비활성 상태로 출시해야 함.

**이후 개선 가능한 항목(막는 항목은 아님)**
- AI 캐시·동시성 보호는 이 프로세스(단일 서버 인스턴스) 안에서만 유효 — 여러 서버로 수평 확장하면 각자 중복 제거(문서에 이미 명시된 한계).
- 태그 어휘·영어 번역·실기기 자동화(Firefox/WebKit 설치)는 필요해지면 별도로 확장.

**사용자가 다음에 해야 하는 최소 행동(순서대로)**
1. 아래 "실기기 베타 체크리스트"(RELEASE_STATUS.md -2절)를 소수 베타 참가자에게 배분하고 결과를 "불편함 보내기"로 받는다.
2. 실제 Google/토스/Resend/WeatherAPI 키를 운영 환경에 넣고 \`OPERATIONS_SETUP.md\`대로 첫 연결을 확인한다(테스트 결제부터).
3. AI 공급자·모델을 실제로 선정할지 결정한다(선정 전까지 비활성 유지 — 임의로 켜지 않음).
4. 위 두 가지가 실제로 끝나기 전까지는 "출시 준비 완료"로 판단하지 않는다.
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
