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
parts.push('# travel hub — 전달 문서 모음 (2026-09-11, 13차 재검토)\n');
parts.push('이 파일 하나에 RELEASE_STATUS·BUSINESS_DECISIONS·MARKETING_LAUNCH_PLAN·OPERATIONS_SETUP\n네 문서를 전부 이어 붙였다(다운로드 편의 + ChatGPT가 한 번에 읽을 수 있게).\n앞으로도 문서 전달은 이 방식(파일 하나)으로 한다.\n각 원본 문서 맨 앞에는 그 문서의 가장 최신 회차 갱신 요약이 오도록\n이미 정렬돼 있다(RELEASE_STATUS.md는 "-3. 13차 재검토 갱신 요약"이\n맨 앞) — 이 통합본도 그 순서를 그대로 이어 붙이므로 최신 내용이\n항상 먼저 보인다.\n');

// 2026-09-11 재검토(13차) 9절 — "통합 문서 맨 앞에 다음만 간단히
// 정리하라": 해결한 결함, 구현-실제연결 차이, 베타공개 차단 항목,
// 이후 개선 가능한 항목, 사용자의 다음 최소 행동. 아래 4개 소스
// 문서 전문과는 별개로, 여기서 딱 이 5묶음만 간단히 요약한다(자세한
// 근거는 각 문서 본문 참고).
parts.push('## 0. 요약 — 지금 상태를 한눈에(자세한 근거는 아래 각 문서 본문 참고)\n');
parts.push(`**① 이번(13차)에 해결한 결함(재현·검증 근거 포함)**
- 태그 저장 중 삭제 복원 버그 — 저장 응답 대기 중 태그를 삭제하면 늦게 온 응답이 되살리던 버그. 실제 지연 응답으로 재현·수정(\`scripts/test-tag-registry-sync.mjs\`). hasUnresolvedConflicts에 customTags 누락도 함께 수정.
- AI 분류 부분 겹침 동시요청 결과 유실 — Promise.all([단독요청, 겹치는요청])으로 정확히 재현, 진행 중 Promise를 발견 시점에 붙잡아 두는 방식으로 수정(\`server/test/ai-classify-cache-and-budget-race.test.mjs\`).
- 날씨 공유 조회 fetchedAt 밀리초 불일치 — 결정론적 시각 강제 테스트로 재현·수정, 기존 테스트 assertion 완화 없이 통과(\`server/test/weather-fetchedat-consistency.test.mjs\`).
- 문서 4개 전체 Markdown 표 헤더/본문 열개수 불일치(5열/6열) 발견·수정.
- 서버 테스트 45개 + 화면(Chromium) 테스트 31개, 합계 76개 파일을 마지막에 한 번에 실행해 전부 통과 확인.

**② 구현 완료와 실제 연결 검증 사이의 차이**
- Google 로그인 — 서버 검증 로직·계정 연결·클라이언트 화면 전부 구현하고 모의(mock) Chromium 검증까지 마쳤지만, **실제 Google 계정으로 로그인해 본 적은 없다**(GOOGLE_CLIENT_ID 실제 발급 필요).
- 실제 AI 공급자(Anthropic Claude Haiku 4.5) — 연결 코드·모의 검증까지 완료, **실제 API 키로 호출해 본 적 없다**(이중 게이트로 운영 기본값은 계속 비활성).
- 일본어 실전 회화 — 구현·Chromium 검증 완료, **원어민 감수는 받지 않았다**(교재 수준 정중체 기준).
- Google Places/Routes·토스페이먼츠·Resend·WeatherAPI는 여전히 코드는 실제 호출하지만 실 키로 검증 못 함(기존 상태 유지).

**③ 베타 공개를 막는 항목**
- 실제 결제 승인 테스트 미완료(토스 실키 미연결).
- 실제 iPhone 핵심 흐름(가져오기·검색·코스생성·로그인동기화·GPS·결제) 미확인.
- 실제 AI 공급자 미선정 — AI 보조 분류는 계속 비활성 상태로 출시해야 함.
- Google 로그인은 있으면 좋지만 없어도 이메일 코드 로그인으로 서비스 전체가 동작하므로 차단 항목은 아님.

**④ 이후 개선 가능한 항목(막는 항목은 아님)**
- AI 캐시·동시성 보호는 이 프로세스(단일 서버 인스턴스) 안에서만 유효 — 여러 서버로 수평 확장하면 각자 중복 제거(문서에 이미 명시된 한계).
- 일본어 회화 문장 세트 확장 + 원어민 감수, 지도 링크 추가 기능의 축약 링크 지원 범위 확장.
- 태그 어휘·영어 번역·실기기 자동화(Firefox/WebKit 설치)는 필요해지면 별도로 확장.

**⑤ 사용자의 다음 최소 행동(순서대로)**
1. 이메일(Resend) + 토스 테스트 결제부터 실제로 연결·확인한다(가장 급함 — \`OPERATIONS_SETUP.md\` 6절 우선순위 체크리스트).
2. Google Places/Routes 키를 넣고 실제 위치확인·코스생성 1건씩 확인한다.
3. 소수 베타 참가자에게 배분하고 "불편함 보내기"로 결과를 받는다.
4. 여유가 되면 Google 로그인(GOOGLE_CLIENT_ID)·날씨 키를 마저 연결한다.
5. AI 공급자는 가장 마지막 — 실제로 켜기 전 소량으로 먼저 청구 비용을 확인한다.
6. 위 과정이 실제로 끝나기 전까지는 "출시 준비 완료"로 판단하지 않는다.
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
