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
parts.push('# travel hub — 전달 문서 모음 (2026-09-24, 자동 분류 개선본)\n');
parts.push('이 파일 하나에 RELEASE_STATUS·BUSINESS_DECISIONS·MARKETING_LAUNCH_PLAN·OPERATIONS_SETUP\n네 문서 원본을 전부 이어 붙였다. 각 문서 맨 앞에 가장 최신 회차가 온다.\n');

// 2026-09-23(18차 재검토 2차) — "문서 첫머리에 수정 결과·남은 미검증·사용자 PC 실행 순서."
parts.push('## 0. 맨 앞 요약\n');
parts.push(`### 0-1. 사용자 PC 실행 순서(앞 단계가 되면 다음으로)

1. Windows PC에서 받은 폴더의 \`start-windows.cmd\` 더블클릭(처음이면 Node.js 24 LTS 먼저 설치).
2. 같은 PC 브라우저에서 \`http://localhost:8787/\` → **새 앱 화면**이 뜨는지 확인.
3. **Google 로그인**(4번 문서 0-E ②).
4. 구글맵에서 내보낸 목록(식당·옷집·카페가 섞인 것)을 **가져오기** → 목록 화면에서 "쇼핑 → 의류"처럼 분류 필터가 맞게 좁혀지는지,
   틀린 곳은 상세에서 두 번 눌러 고쳐지는지 확인(이 단계는 비용 없음).
5. 실제 키를 넣고 **소량만**: 장소 위치 확인 2~3곳(업종이 분류에 반영되는지 같이 확인) → 코스 1개 → 영업시간 확인 3곳 → 도보 경로 확인.
6. 토스페이먼츠 **테스트 키**로 결제 한 번 → 결제 후 앱으로 돌아오는지.
7. https 주소(운영 호스팅)를 정한 뒤 **PC·iPhone·Android에서 같은 계정**으로 같은 코스가 보이는지, 한 기기에서 고친 뒤 다른 기기에서 되돌리기가 어떻게 안내되는지.

(\`localhost:8787\`은 사용자 PC 안의 주소다. 이번 작업은 원격 작업 환경에서 했고, 그 환경의 주소는 사용자가 열 수 없다.)

### 0-2. 이번 작업 — 자동 분류 개선 요약

**자동 분류 가능한 근거**: ① 사용자가 직접 고른 분류(최우선, 절대 안 덮음) ② 이미 하던 "위치 확인" 때 받은 Google 업종
(primaryType 우선, 구체 업종 > store·food 같은 포괄 업종, 국가 무관) ③ 장소 이름·내 메모의 분명한 업종 낱말(古着·스시·미술관 등)
④ 없으면 미분류. 큰 분류(식당·카페·디저트·바·주점·쇼핑·관광·문화·휴식·미용·숙소·교통·약국·의료·미분류)와 세부 분류가 연결돼
"쇼핑 → 의류"처럼 좁혀 볼 수 있다.

**미분류로 남는 경우**: 브랜드명만 있고(예: UNIQLO) 아직 위치 확인을 안 한 곳, Google이 업종 없는 값만 준 곳. 목록 이름("쇼핑",
"여행 계획")과 주소는 업종 근거로 쓰지 않는다(주소 "港区"의 港 때문에 카페가 교통으로 분류되던 문제를 이번에 고쳤다).
미분류여도 다른 기능은 그대로 쓰고, 상세 화면에서 두 번 눌러 고칠 수 있다.

**기존 사용자 데이터 보존**: 저장값은 그대로(화면 표시명만 분리), 사용자가 고른 분류·태그·일부러 비운 태그·개인 태그·목록 소속·
코스 연결 유지. 자동 처리는 태그를 지우지 않고 덧붙이기만 한다. 재가져오기·새로고침·다른 기기 동기화 뒤에도 유지(검사로 확인).

**추가 API 호출 여부**: 없음. 분류만을 위한 조회·필드 확대·AI 호출 없음. 가져오기·필터·화면 열기로 유료 요청 0건, 비용 원장 0건.

**실제 실행한 검증과 미검증**: 새 검사 \`scripts/test-auto-classify.mjs\`(헤드리스 Chromium + 테스트 모드 서버, 요청된 시나리오 전부)와
관련 기존 검사, 마지막 전체 검증 1회 — 1번 문서 -18절. 미검증: 실제 Google 응답(테스트 어댑터만), \`sushi_restaurant\` 같은 세부
식당 업종 이름(공식 문서 페이지 접속 차단 — 응답 구조와 기본 업종 이름은 Google 공식 API 정의·공식 클라이언트로 확인),
Windows·iPhone·Android 실기기.

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
