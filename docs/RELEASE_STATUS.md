# 출시 상태 (RELEASE_STATUS)

## -4. 14차 재검토 갱신 요약(가장 최신 — 여기부터 읽기)

ChatGPT가 13차 결과물을 검토한 뒤 "새 기능을 추가하지 말고 아래 문제
수정과 실제 연결 준비에 집중하라"고 지시했다. 이번 라운드는 새 기능이
전혀 없다 — 전부 13차에서 만든 기능의 결함 수정이거나 실제 연결
준비를 위한 문서 정리다. 표기 원칙은 이전과 동일: `실사용 가능` /
`코드는 있으나 화면 미연결` / `모의(mock)로만 검증` / `실제 공급자
미연결` / `실기기(iPhone) 미검증` / `사용자 다음 행동 필요`.

| 항목 | 수정 위치 | 재현/검증 결과 | 완료 여부 | 상태 | 다음 행동(사용자) |
|---|---|---|---|---|---|
| R14-1 Google 로그인 계정 탈취 취약점 수정 | `server/adapters/google-auth.mjs`, `server/auth.mjs`, `server/db.mjs`(google_identities 표 신규), `server/index.mjs` | ChatGPT가 재현한 정확한 시나리오(기존 owner@example.com 계정이 있는 상태에서, 같은 이메일·email_verified:true·hd 없음·한 번도 못 본 sub인 Google 토큰을 보내면 추가 확인 없이 그 계정에 그대로 로그인되던 결함)를 그대로 재현·확인. 이메일이 아니라 Google의 안정 식별자 sub를 계정 연결 기본키로 재설계 — 이미 연결된 sub는 바로 로그인(반복 인증 없음), 그 이메일을 쓰는 계정이 없으면 새로 만들어 즉시 연결(안전), 이미 다른 계정이 그 이메일을 쓰면 기존 세션 또는 이메일 로그인 코드로 소유확인을 거쳐야만 연결(거부 시 409 ownership-verification-required). JWKS 요청에 5초 타임아웃 추가, 키 회전 시 unknown kid를 한 번 더 강제 새로고침해 재시도. 계정 id 자체는 안 바뀌므로 이용권/무료체험 상태는 로그인 방식이 바뀌어도 유지됨을 테스트로 재확인. git stash로 수정 전 코드에서 공격이 실제로 성공함을 확인(`server/test/google-auth.test.mjs` 신규 시나리오 3-a~3-d, 1절 hd/missing-subject 신규) | 완료 | `실사용 가능`(순수 서버 로직 — 단 GOOGLE_CLIENT_ID 미설정이라 운영 기본값은 여전히 비활성) | Google Cloud Console에서 실제 OAuth 클라이언트 ID 발급 필요(`OPERATIONS_SETUP.md` 1-5c절) — 그 전까지 Google 로그인 자체가 서비스에서 꺼져 있어 이번 수정의 실제 효과는 발급 이후에만 나타남 |
| R14-2 지도 링크 추가 — 중심좌표 오인 + 저장실패 처리 | `server/routes/place-link.mjs`, `src/design/import-adapter.js`, `src/design/spots.js` | ChatGPT 지적: "/maps/place/이름/@lat,lng"의 @ 좌표는 지도 화면의 중심(뷰포트)일 뿐 그 장소의 확정 좌표라는 보장이 없는데, 예전 코드는 이 값을 그대로 확정 좌표로 저장해 코스 생성 등에 실좌표처럼 쓰일 수 있었다. 좌표 추출을 "확정 좌표"(!3d!4d 데이터 블록)와 "중심/뷰포트 좌표"(@, q=, ll= 등)로 분리해, 중심좌표는 절대 확정 좌표로 반환·저장하지 않고 기존 needsLookup 큐로 넘어가게 함. 이름을 못 찾은 링크는 조용히 무명 장소를 만들지 않고 이름 입력을 요구(nameRequired). 축약 링크 리다이렉트를 매 홉마다 직접 검사(redirect:'manual'+HEAD)하도록 바꿔 중간 홉이 허용 밖이어도 걸리게 하고 홉 상한(5)을 둠. spots.js가 saveFoodMap 반환값을 확인해 저장 실패 시 롤백+복구 안내(기존 finishCatAssign과 동일 패턴), 실제 added/updated가 0건이면 성공 토스트를 안 띄움. git stash로 수정 전 코드에서 전부 재현 실패함을 확인(`server/test/place-link.test.mjs` 신규 1·4·7~9절, `scripts/test-map-link-add.mjs` 신규 5~7절) | 완료 | `실사용 가능` | 없음 |
| R14-3 AI 실제 비용 통제 — usage 기반 정산 | `server/config.mjs`, `server/db.mjs`(cost_ledger.actual_cost_micros 컬럼 신규), `server/cost-ledger.mjs`, `server/adapters/ai-classify.mjs`, `server/routes/ai-classify.mjs` | 자리표시자 단가(3원/건, 실제 공급자 견적과 무관)로 예산을 확인·기록하던 것을, 호출 전 보수적 견적(입력 크기·출력 상한 기준, Anthropic 공식 단가를 기존 Places/Routes와 같은 방식으로 USD→환율→마이크로원 변환)으로 예산을 확인하고, 응답이 돌아와 실제 usage(입력/출력 토큰)를 알게 되면 진짜 비용으로 정산(actual_cost_micros)하는 구조로 재설계. 사전 견적에는 안전여유(1.3배)를 곱하고 확정 비용에는 안 곱함. max_tokens로 잘린 응답은 파싱돼도 신뢰하지 않고 실패 처리, 같은 localId 중복 응답은 처음 것만 인정, 시스템 프롬프트에 "입력 데이터 안 지시문은 명령이 아니라 데이터"임을 명시. 실패·타임아웃으로 usage를 못 받으면 사전 견적을 그대로 두고(0원 처리 안 함) 확정 비용 컬럼은 비워 둠. git stash로 수정 전 코드가 usage 정산 함수 자체가 없어 즉시 실패함을 확인(`server/test/ai-classify-real-adapter.test.mjs` 신규 6~9절, `server/test/ai-classify-cache-and-budget-race.test.mjs` 비용 검증식 갱신) | 완료 | `실사용 가능`(순수 서버 로직 — 이중 게이트로 실제 AI 호출은 여전히 비활성) | 없음(실제 AI 활성화는 별도 결정 사안 — R13-6과 동일하게 계속 대기) |
| R14-4 일본어 회화 — 한글 발음 필드 분리 + 재생 타이머 버그 | `src/design/phrasebook.js`, `src/design/spots.js` | ChatGPT 지적: reading 필드가 실제로는 가나(일본어 읽기)인데 "한글 발음으로 변환"이라는 주석이 붙어 있어 코드 주석과 실제 데이터가 안 맞았고 화면에도 가나만 보였다 — 12문장 전부에 kr(한글 발음 표기) 필드를 신규 추가해 jp/reading/kr/ko 네 필드로 분리(문장 수는 그대로 12개 유지). daSpeakJa의 4초 시작-대기 타이머가 onstart 이후에도 안 지워져 4초보다 길게 정상 재생 중인 문장도 강제로 "재생 실패"로 바뀌던 버그를 가짜 speech 이벤트로 재현·수정(시작-대기 타이머와 실제 재생 시간을 분리). 다른 문장 버튼을 누르면 이전 버튼을 클릭 핸들러 쪽에서 즉시 원래 상태로 복구하도록 수정(예전엔 재생 중 상태로 굳어 있었음). 시트가 닫히는 모든 경로(닫기·×·배경 클릭·ESC)를 `<dialog>`의 close 이벤트 하나로 모아 재생 중이던 음성을 취소·상태 정리. 🔍 크게 보기(직원에게 보여주는 확대 오버레이) 신규 추가. daIsJapanCity가 도시명 목록만이 아니라 city.country가 채워져 있으면 그 값을 우선 판정하도록 확장(가능한 범위에서 국가 정보 기준 판단), 여행 도구 진입점에도 장소 상세와 같은 일본 노출 게이팅 적용(예전엔 목적지 무관하게 항상 노출). git stash로 수정 전 코드에서 타이머·버튼복구·시트정리·kr필드 부재가 전부 재현됨을 확인(`scripts/test-phrasebook.mjs` 신규 7~12절) | 완료 | `실사용 가능`(문장 자체는 여전히 원어민 감수 전 — R13-7과 동일 원칙 유지) | 필요하면 원어민 감수를 별도로 진행 |
| R14-5 최종 회귀 + 실제연결 준비 문서 정리 + 전달 | 본 문서, `docs/OPERATIONS_SETUP.md`, `docs/전달문서_통합본.md` | 서버 테스트 45개 + 화면(Chromium) 테스트 31개(13차와 동일 파일 수 — 신규 파일 없이 기존 파일에 시나리오만 추가) 전체를 이번 라운드 마지막에 한 번에 실행해 전부 종료코드 0 확인. OPERATIONS_SETUP.md에 코드-준비완료 항목과 사용자-설정필요 항목을 구분해 재정리하고, "/api/health가 정상이어도 공급자 연결 완료가 아니다"를 재확인. 문서 전체에서 "실사용 검증 완료"류 과장 표현이 없는지 재검사(발견된 것 없음 — 기존에도 항상 상태 표기(모의검증/실공급자 미연결 등)를 명시했었음) | 완료 | `실사용 가능`(문서·검증 작업) | 없음 |

**이번 라운드에서 실제로 검증한 것과 안 한 것을 분명히 구분**:
- **실제로 재현·수정하고 자동 테스트로 검증한 것**: 위 표의 R14-1
  (Google 로그인 계정 탈취 취약점), R14-2(지도 링크 중심좌표 오인),
  R14-3(AI 비용 usage 정산 구조), R14-4(일본어 회화 타이머·필드
  버그), R14-5(문서·회귀).
- **여전히 실제 서비스로 검증 못 한 것**: Google 로그인(GOOGLE_CLIENT_ID
  미발급이라 여전히 서비스에서 꺼져 있음 — 이번 수정은 발급 후 그
  계정 탈취 경로가 막혀 있는지를 코드 수준에서 미리 고친 것), 실제
  AI 공급자(여전히 이중 게이트로 비활성), 일본어 회화 원어민 감수.
- **여전히 안 한 것(13차와 동일)**: 실제 공개 배포, master 병합,
  실과금, 유료 계약, SNS 게시, 외부 메시지 발송, git 히스토리
  재작성, 가격/이용권 수량 임의 변경 — 지시대로 전부 안 했다.

## -3. 13차 재검토 갱신 요약

ChatGPT가 12차 결과물을 검토한 뒤 (1) 우선 재현·수정할 버그 3건,
(2) Google 로그인 기본화, (3) 한국 가져오기 방향 확정 + 지도 링크
추가, (4) 실제 AI 공급자 연결, (5) 일본어 실전 회화 연결, (6)~(8)
가격·실연결 체크리스트·마케팅 문서 확인, (9) 문서 정리를 지시했다.
아래는 이번 라운드에서 실제로 한 일만 담는다 — 표기 원칙은 이전과
동일: `실사용 가능` / `코드는 있으나 화면 미연결` / `모의(mock)로만
검증` / `실제 공급자 미연결` / `실기기(iPhone) 미검증` / `사용자
다음 행동 필요`.

| 항목 | 수정 위치 | 재현/검증 결과 | 완료 여부 | 상태 | 다음 행동(사용자) |
|---|---|---|---|---|---|
| R13-1 태그 저장 중 삭제 복원 버그 | `src/design/spots.js`(daSyncPush 태그 병합, hasUnresolvedConflicts) | 저장 요청 응답 대기 중 같은 태그를 로컬에서 삭제하면 늦게 온 응답이 "다른 기기가 만든 낯선 태그"로 오인해 되살리던 버그를 실제 지연 응답으로 재현·수정(응답 처리 시점의 deletedTagIds를 확인해 부활 차단). hasUnresolvedConflicts가 places/courses/trips만 보고 customTags를 빠뜨려 태그 필드충돌이 남아도 fullySynced가 잘못 true였던 점도 함께 수정. git stash로 재현 확인(`scripts/test-tag-registry-sync.mjs` 8번 신규) | 완료 | `실사용 가능` | 없음 |
| R13-2 AI 분류 부분 겹침 동시요청 결과 유실 | `server/routes/ai-classify.mjs` | Promise.all([classifyBatchRoute(acc,[shared]), classifyBatchRoute(acc,[shared,other])])로 정확히 재현 — 두 번째 요청의 shared 결과가 사라지던 버그(둘 다 ok:true라 조용히 성공처럼 보임). "지금 진행 중"이라고 발견하는 순간 Promise 참조를 붙잡아 두고 나중에 맵을 다시 조회하지 않도록 수정. unresolvedCount 필드를 응답에 추가해 유실을 성공으로 위장하지 않게 함. git stash로 재현 확인(`server/test/ai-classify-cache-and-budget-race.test.mjs` 7절 신규) | 완료 | `실사용 가능`(순수 서버 로직) | 없음 |
| R13-3 날씨 공유 조회 fetchedAt 밀리초 불일치 | `server/routes/weather.mjs` | 공유 Promise를 기다리는 각 호출자가 각자 nowIso()를 불러 fetchedAt이 갈라지던 버그(빠른 로컬 실행에선 우연히 같은 밀리초에 걸려 안 보일 수도 있음) — fetchedAt을 실제 조회가 끝나는 .then 콜백 안에서 한 번만 계산해 공유하도록 수정. 밀리초 경계를 운에 맡기지 않고 new Date() 호출마다 강제로 다른 값을 주는 결정론적 테스트로 재현(`server/test/weather-fetchedat-consistency.test.mjs` 신규, 기존 `weather-merge-cap.test.mjs`는 assertion 완화 없이 그대로 통과) | 완료 | `실사용 가능` | 없음 |
| R13-4 Google 로그인을 기본 진입 방식으로 추가 | `server/adapters/google-auth.mjs`(신규), `server/auth.mjs`, `server/config.mjs`, `server/index.mjs`, `src/design/spots.js` | ID 토큰을 서버가 Google 공개 JWKS로 직접 서명 검증(클라 시크릿 미사용 설계). 이메일 코드 로그인과 완전히 같은 계정 연결 경로(loginOrCreateAccount)를 재사용해, 같은 이메일이면 로그인 방식이 바뀌어도 같은 accountId·같은 무료체험/이용권 상태로 이어짐을 실제로 검증. GOOGLE_CLIENT_ID 없으면 서버 시작은 안 막되 서비스가 정직하게 unavailable(부가 기능). 클라이언트는 GSI 스크립트 로드 실패·인앱 브라우저 차단 시 조용히 이메일 로그인만 남김(깨진 버튼 없음). git stash 불필요(신규 기능, `server/test/google-auth.test.mjs` 16개 + `scripts/test-google-signin-ui.mjs`/`test-google-signin-configured.mjs` 실제 Chromium 검증) | 완료 | `모의(mock)로만 검증`(실제 Google 계정 연결 검증 아님), 코드 구현 완료 | Google Cloud Console에서 실제 OAuth 클라이언트 ID 발급 필요(`OPERATIONS_SETUP.md` 1-5c절) |
| R13-5 한국 가져오기 방향 확정 + 지도 링크 추가 | `server/routes/place-link.mjs`(신규), `src/design/spots.js` | 한국이 Google Data Portability API 미지원국임을 확인 — 자동 가져오기를 약속·구현하지 않음(기존 확정 흐름 그대로 유지 확인). 신규: 구글맵 장소 링크(축약 링크 포함) 붙여넣기로 한 곳 추가 — Places API 미호출(비용 없음, 이름·좌표 힌트만 추출), 실제 위치 확인은 기존 이용권 한도가 그대로 적용됨. SSRF 방어(축약 링크 최종 호스트도 구글 도메인인지 재확인), 지원 안 하는 링크는 명시적으로 실패 반환(조용한 성공 없음). git stash 불필요(신규 기능, `server/test/place-link.test.mjs` 12개 + `scripts/test-map-link-add.mjs` 실제 Chromium 검증) | 완료 | `실사용 가능` | 없음 |
| R13-6 실제 AI 자동분류 공급자(Anthropic Claude Haiku 4.5) 연결 | `server/adapters/ai-classify.mjs`, `server/config.mjs` | 공식 가격 확인(WebSearch 교차 확인 — 이 세션에서 anthropic.com 직접 열람은 네트워크 정책상 차단돼 제약을 그대로 남김): 입력 $1/1M, 출력 $5/1M 토큰. raw fetch로 실제 Anthropic Messages API를 부르는 어댑터 신규(이 저장소의 다른 실제 어댑터와 동일한 무-SDK 관례). 응답은 기존 validateClassifyResult로 그대로 검증(AI 출력 맹신 안 함). AI_CLASSIFY_ENABLE_REAL=true AND 실제 ANTHROPIC_API_KEY 둘 다 있어야만 real 모드 켜짐(이중 게이트) — 운영 기본값은 계속 비활성. 실제 키 검증은 안 함 — fetch를 가짜 응답으로 대체한 모의 검증까지(`server/test/ai-classify-real-adapter.test.mjs` 14개) | 완료(모의 검증까지) | `모의(mock)로만 검증`, `실제 공급자 미연결` | 실제 공급자로 켤지, 켠다면 언제 결정(선정 전까지 계속 비활성) |
| R13-7 일본어 실전 회화("여기서 쓸 말") 연결 | `src/design/phrasebook.js`(신규), `src/design/spots.js` | 기존 옛 디자인의 "일본어" 탭을 확인한 결과 친교용 잡담 고정문장 + 화면 열 때마다 AI가 즉석에서 만드는 13주 커리큘럼뿐이라 그대로 옮기지 않고, 요구된 다섯 상황(주문·계산·교통·숙소·재질문)에 맞는 12문장을 새로 정리(표준 교재 정중체, 원어민 감수 안 받음을 화면에 명시). 기기 SpeechSynthesis만 사용(클릭 시에만 재생), 음성없음/재생실패를 각각 정직하게 안내. 일본 목적지 장소에서만 노출. 실제 Chromium 검증(`scripts/test-phrasebook.mjs` 14개) | 완료 | `실사용 가능`(문장 자체는 원어민 감수 전) | 필요하면 원어민 감수를 별도로 진행 |
| R13-8 가격·무료/유료 기준 확인 | `docs/BUSINESS_DECISIONS.md`(3-3-9절 신규) | 9,900원 유지(4,900원 베타 여전히 미확정), 무료체험 재열람 무차감을 코드로 재확인(getCourse가 entitlement 미접촉), 로그인 방식 변경해도 무료체험 안 초기화됨을 R13-4 테스트로 실증. 원가표를 API/AI/결제수수료/서버 + 무료비용/실패재시도/환불/지원부담으로 구분 재정리. 내부 안전상한을 확정 이익처럼 서술하지 않는다는 원칙 재확인 | 완료 | `실사용 가능`(문서·검증 작업) | 없음 |
| R13-9 실제연결·기기검증 체크리스트 + 마케팅 문서 갱신 | `docs/OPERATIONS_SETUP.md`, `docs/MARKETING_LAUNCH_PLAN.md` | Google Cloud Console OAuth 설정 절차, Anthropic 이중 게이트 설정법, 우선순위 체크리스트(이메일·결제→Places/Routes→베타배포→Google로그인→날씨→AI 순) 신규. 마케팅 문서에 13차 신규 기능 상태표 반영 + "Google 로그인하면 자동으로 들어온다"는 오해 소지 문구 금지 추가, 제휴 클릭≠매출 원칙 재확인(기존에 이미 코드로 보장돼 있었음, 문서로 재확인만) | 완료 | `실사용 가능`(문서 작업) | 없음 |
| R13-10 최종 회귀 + 문서 표 수정 + 전달 | 본 문서, `docs/전달문서_통합본.md` | 문서 4개 전체에서 Markdown 표 헤더/본문 열개수 불일치를 실제로 스캔해 발견(이 문서의 R11/R12 표가 5열 헤더에 6열 본문이었음 — "완료" 칸이 헤더 없이 끼어 있었음) → "완료 여부" 열을 헤더에 추가해 수정. 서버 테스트 전체 + 화면(Chromium) 테스트 전체를 마지막에 한 번에 실행해 회귀 확인 | 완료 | `실사용 가능`(문서·검증 작업) | 없음 |

**이번 라운드에서 실제로 검증한 것과 안 한 것을 분명히 구분**:
- **실제로 재현·수정하고 자동 테스트로 검증한 것**: 위 표의 R13-1~3
  (버그 수정), R13-5(지도 링크 추가), R13-7(회화 기능), R13-8~10
  (문서·회귀).
- **코드는 실제로 작성했지만 실제 서비스로 검증하지 못한 것**:
  R13-4(Google 로그인 — 실제 Google 계정 연결 미검증), R13-6(AI
  공급자 — 실제 API 키 미검증). 둘 다 운영 기본값은 비활성/미설정
  상태로 남겨 뒀다.
- **여전히 안 한 것**: 실제 계정·크리덴셜 발급, 실제 결제, 실제
  기기(iPhone 등) 검증, SNS 게시, git 히스토리 재작성 — 지시대로
  전부 안 했다.

## -2. 12차 재검토 갱신 요약

ChatGPT가 11차 결과물을 독립적으로 검증(서버 테스트 41개 직접 실행,
trips 충돌 보존·통합문서 구성 재확인)한 뒤, **기존 테스트에는 없었던
5가지 결함**을 추가로 재현·지적했다. 이미 해결된 항목은 다시 손대지
않고, 아래 5건만 우선 재현·수정했다. 표기 원칙은 지금까지와 동일 —
`실사용 가능` / `코드는 있으나 화면 미연결` / `모의(mock)로만 검증` /
`실제 공급자 미연결` / `실기기(iPhone) 미검증` / `사용자 다음 행동 필요`.

| 항목 | 수정 위치 | 재현/검증 결과 | 완료 여부 | 상태 | 다음 행동(사용자) |
|---|---|---|---|---|---|
| R12-1 태그 저장 중 수정 유실 | `src/design/spots.js`(daSyncPush 태그 병합), `src/design/import-adapter.js`(태그 기준선 신규) | ChatGPT가 지적한 정확한 재현 조건(저장 요청 응답 대기 중 같은 태그를 로컬에서 또 고침)을 실제 지연 응답으로 재현 — 예전엔 "태그 충돌은 드물어서 서버값 우선"이라는 처리 때문에 방금 한 수정이 조용히 사라졌다. places/courses/trips와 같은 3-way 재병합(기준선 대조)을 적용해 저장 중 수정을 보존하고, 진짜 같은 필드 충돌은 `_fieldConflicts`로 남겨 태그 편집 화면에서 직접 해결하게 했다(해결 시 장소에 붙은 태그 문자열도 함께 갱신 — 연결 유지). 삭제 충돌이 옛 버전으로 영원히 재시도되던 문제도 서버가 알려준 최신 버전으로 갱신해 수렴하게 고쳤다. git stash로 재현 확인(`scripts/test-tag-registry-sync.mjs` 시나리오 6~7 신규) | 완료 | `실사용 가능` | 없음 |
| R12-2 AI 분류 캐시 localId 오염 | `server/routes/ai-classify.mjs` | localId A로 분류→캐시된 뒤 완전히 다른 localId B가 우연히 같은 이름·주소·확인유형으로 요청하면 B의 응답에 A의 localId가 그대로 실려 나가던 결함을 실제로 재현. 캐시에는 분류 내용만 저장하고(localId 제외), 응답 조립 시 항상 지금 요청의 localId로 재라벨링하도록 수정. git stash로 재현 확인(`server/test/ai-classify-cache-and-budget-race.test.mjs` 5절 신규) | 완료 | `실사용 가능`(순수 서버 로직) | 없음 |
| R12-3 AI 동시 요청 중복 처리·비용 이중기록 | `server/routes/ai-classify.mjs` | 같은 계정·입력·분류버전의 캐시미스 요청 두 개를 Promise.all로 보내면 둘 다 독립적으로 분류·과금되던 결함(비용 2배)을 실제로 재현. places.mjs의 기존 동시요청 병합 패턴(inFlightLookups)과 같은 방식으로, (계정,입력해시,버전) 키 하나당 공유 Promise 하나로만 실제 작업이 진행되고 비용도 한 번만 청구되게 수정 — 배치 내 동일 입력도 같은 방식으로 한 번만 처리됨. 실패해도 in-flight 항목은 항상 정리돼 다음 재시도가 영구 잠금에 안 걸림. git stash로 재현 확인(같은 파일 6절 신규) | 완료 | `실사용 가능`(순수 서버 로직, 이 프로세스 안에서만 유효 — 수평 확장 시 프로세스별 중복 제거는 기존 한계와 동일) | 없음 |
| R12-4 AI 헤드룸 예약 과소평가 재정정 | `server/route-segments.mjs`(신규), `server/entitlement-usage.mjs`, `server/adapters/routing.mjs` | maxPlacesPerGeneration(기본 60곳)까지 실제로 허용하면서 예약은 1세그먼트분(14원)만 하던 결함을 지적받아, 실제 최대 입력을 routing.mjs와 완전히 같은 함수(splitIntoSegments)로 나눠 실제 세그먼트 수·SKU 등급을 계산해 예약하도록 재정정(60곳 기준 3세그먼트, 35원/코스로 재계산 — "전형적인 하루 코스" 같은 임의 가정 표현 제거). 조정용 상수(reservedRouteSegmentsPerCourse)는 더 이상 필요 없어 제거. git stash로 재현 확인(`server/test/ai-classify.test.mjs` 4절 신규 — 실제 splitIntoSegments 계산과 일치하는지, 최대 입력이 커지면 예약액도 커지는지 확인) | 완료 | `실사용 가능`(계산 로직 — 실제 AI 미연결이라 실질 영향은 아직 없음) | 없음 |
| R12-5 기기·브라우저 검증 범위 확대 | `scripts/test-cross-browser-and-viewport.mjs`(신규), `server/feedback.mjs`·`src/design/spots.js`(피드백 브라우저 종류 추가) | Firefox·WebKit을 실제로 launch 시도 — 이 세션 환경엔 실행 파일 자체가 없어(신규 설치는 세션 정책상 금지) 실행 불가를 콘솔에 정직하게 남김(가짜 통과 표시 없음). Chromium 뷰포트 에뮬레이션(375×667)으로 하단 내비게이션 44×44px 유지·로그인 입력창 가시성 확인, 글자 150% 확대 상태에서 버튼 안 겹침 확인, 느린 네트워크 중 동기화 요청이 겹쳐 불려도 서버에 중복 저장 안 됨을 재확인. 피드백 진단정보에 browserType(User-Agent 기반 최선 추정) 추가 — 기기·브라우저·실패단계·오류ID를 한 창구(기존 admin 피드백 화면)에서 함께 볼 수 있게 함 | 완료(가능한 범위) | `모의(mock)로만 검증`(뷰포트 에뮬레이션일 뿐 실기기 아님), `실기기(iPhone/Android/Samsung Internet/macOS Safari) 미검증`, Firefox·WebKit `실행 환경 없음(미검증)` | 아래 "실기기 베타 체크리스트"로 소수 베타 참가자에게 배분 |

**아직 미검증(정직하게 남김, 8절·아래 체크리스트 참고)**: 실제
iPhone Safari, 실제 Android Chrome/Samsung Internet, macOS Safari,
Instagram/Threads 인앱 브라우저(파일 선택·로그인·결제 제한 여부),
실제 OS 접근성 글자 확대, 실제 온스크린 키보드로 인한 뷰포트 축소,
실제 GPS 하드웨어·모바일 통신망 끊김. Firefox·WebKit은 이 세션
환경에 실행 파일이 없어 자동검사 자체를 못 했다(설치 시도 안 함 —
세션 정책).

**실기기 베타 체크리스트(소수 참가자에게 배분 — 별도 기기 구매·유료
테스트 서비스 계약 없이, 참가자 본인 기기로 5~10분 안에 끝나는
분량)**:
1. ZIP/CSV로 저장 목록 가져오기 → 한글 파일명 포함 파일 선택이 됨
2. 검색 → 자동 분류 결과 확인 → 태그 하나 고쳐 저장됨
3. 거리순 정렬 옆 "내 위치 기준" 버튼 → 위치 권한 허용/거절 각각 확인
4. 오늘 동선 담기 → 코스 만들기 → 결과 저장됨 → 로그아웃 후 재로그인해도 남아 있음
5. (Instagram/Threads에서 링크를 열었다면) 가져오기·로그인·결제 중 막히는 화면이 있는지, 있다면 "외부 브라우저로 열기" 안내가 뜨는지
6. 문제가 있으면 프로필 → "불편함 보내기"로 바로 제출(화면 이름과 무엇을 하다 막혔는지만 적어도 충분 — 기기·브라우저 정보는 자동으로 같이 감)

**아직 "출시 준비 완료"라고 말할 수 없는 이유(11차와 동일 원칙
유지)**: 실제 AI 공급자 연결, 실제 결제 테스트, 실제 iPhone/Android
핵심 흐름 확인 중 하나라도 남아 있으면 "출시 준비 완료"로 부르지
않는다 — 지금 시점엔 전부 남아 있다.

**전체 회귀(12차)**: 서버 테스트 `server/test/*.test.mjs` **41개**
(11차와 동일 — 신규 서버 테스트 파일 없이 기존 파일에 시나리오만
추가), 화면 테스트 `scripts/test-*.mjs` **27개**(11차 26개 + 신규
1개: 기기·브라우저·뷰포트 검증). 합계 **68개 파일**을 이번 라운드
마지막에 한 번에 실행해 전부 종료코드 0(전체 통과)임을 확인했다.

---

## -1. 11차 재검토 갱신 요약

이번 목표는 ChatGPT의 지시 그대로 **"기능 확장이 아니라 데이터 손실
해결과 이미 요청한 기능의 화면·저장·동기화 연결 완성"**이었다. 아래
표기 원칙은 지금까지와 같다 — **"완료"는 코드가 실제로 동작하고
합성 데이터·Chromium 실제 브라우저로 검증됐다는 뜻이지, 실제 Google/
토스/Resend 키·실제 iPhone 기기·실제 배포로 검증됐다는 뜻이 아니다.**
이번 라운드부터는 각 항목에 아래 6개 상태 표기 중 하나를 **명시적으로**
붙인다(11차 지시):
`실사용 가능` / `코드는 있으나 화면 미연결` / `모의(mock)로만 검증` /
`실제 공급자 미연결` / `실기기(iPhone) 미검증` / `사용자 다음 행동 필요`
— 한 항목이 여러 개 해당하면 전부 붙인다.

**R11-1(보고 정정)**: ChatGPT의 10차 재현이 "Node + 인메모리 DB(jsdom
아님)로만 이뤄졌고, 실제 브라우저·실제 iPhone 검증이 아니다"라는
지적을 확인 — `scripts/test-*.mjs` 26개 전부가 실제로 Playwright/
Chromium을 띄워 실행됨을 코드로 재확인했고(각 파일이 `chromium.launch`
를 실제로 호출), `server/test/*.test.mjs` 41개는 순수 Node+인메모리
DB만 쓴다는 ChatGPT의 지적이 정확함을 인정한다. 이미 맞았던 10차의
파일 수(38+23)는 다시 세지 않고, 이번 라운드에서 늘어난 수만 아래
"전체 회귀"에 정정 반영한다. 상태: `실사용 가능`(문서 정정 작업이라
코드 영향 없음).

| 항목 | 수정 위치 | 재현/검증 결과 | 완료 여부 | 상태 | 다음 행동(사용자) |
|---|---|---|---|---|---|
| R11-2 trips/courses 충돌 기록 소실 + 필드 삭제 부활 | `src/design/spots.js`(daRemergeGenericConflict, daSyncPush), `src/design/import-adapter.js`, `server/db.mjs`(trips.field_conflicts 컬럼), `server/routes/trips.mjs`(syncTrips) | ①같은 필드를 두 기기가 다르게 고치면 trips/courses도 `_fieldConflicts`로 보존되고(예전엔 서버가 고정 컬럼만 저장해 재제출 시 조용히 사라짐), ②로컬에서 명시적으로 지운 필드가 상대 기기 값으로 부활하던 버그(`Object.keys(mine)`만 순회하던 결함)를 union-of-keys로 수정, ③trips/courses에도 장소와 같은 실제 충돌 해결 화면(선택 버튼)을 신규 연결, ④HTTP 200과 "완전히 동기화됨"을 구분(`hasUnresolvedConflicts`/`fullySynced`), ⑤로그아웃 시 "저장은 됐지만 아직 정리할 값이 남음"과 "저장 자체가 실패함"을 다른 문구로 구분. 테스트 작성 중 **별도로 새로 발견한 버그**(제3의 기기의 무해한 재동기화가 trips 버전을 불필요하게 올려 다른 기기의 정상 수정이 스푸리어스 충돌을 일으킴)도 `syncTrips`에 `contentUnchanged` 보호를 추가해 함께 수정. git stash로 수정 전 실제 재현 확인(`server/test/trips-field-conflicts.test.mjs` 10개, `scripts/test-sync-conflict-devices.mjs` 시나리오 10~13 신규) | 완료 | `실사용 가능`(순수 클라이언트+서버 로직, 별도 연결 없음) | 없음 |
| R11-3 태그 실제 화면·계정 저장 완성 | `src/design/import-adapter.js`(태그 레지스트리 override 구조), `src/design/spots.js`(tagsEditSheet, bulkTagEditSheet), `server/db.mjs`(account_tags), `server/routes/tags.mjs`(신규) | 기존 태그 편집 화면 안에 이름바꾸기/삭제 추가(새 대형 관리화면 안 만듦, 지시대로), 다중선택 일괄 태그 추가/삭제 신규, 계정별 태그 레지스트리(커스텀 태그+기본태그 표시명 override) 동기화 신규(로그아웃/재접속/다른기기 생존, 계정 전환 격리 확인), 기본 태그 이름을 바꿔도 공유 전역 배열은 절대 안 바뀌고 계정별 override로만 저장, `daInferTags`를 기본(builtin) 태그만 순회하도록 제한해 개인 취향 태그("꼭 가기" 등)가 절대 다른 장소에 자동으로 안 번지게 구조적으로 차단, 다른 기기가 준 미지 태그를 편집 화면에서 안 지움, 새 태그 저장 실패 시 롤백. git stash로 재현 확인(`server/test/tags-sync.test.mjs` 7개, `scripts/test-tag-registry-sync.mjs` 14개) | 완료 | `실사용 가능` | 없음 |
| R11-4 AI 분류 클라이언트 연결 + 원가 통제 강화 | `src/design/spots.js`(daRunAiClassifyQueueOnce), `src/design/import-adapter.js`(daNeedsAiClassify 등), `server/routes/ai-classify.mjs`, `server/config.mjs`, `server/entitlement-usage.mjs`, `server/db.mjs`(ai_classify_cache) | 가져오기 완료/로그인 동기화 직후 규칙으로 못 정한 곳만 골라 백그라운드로 분류 요청(화면 안 막힘, 응답 대기 중 사용자가 직접 확정/삭제하면 결과 폐기)을 신규 연결. 개인 메모(note)를 입력에서 완전히 제거하고 confirmedTypes로 대체. 입력해시+분류버전+계정별 캐시로 중복 호출·중복 과금 방지. 전체(서비스 전역) 하루 배치 한도 신규(계정별 한도와 별개). 헤드룸 예약을 실제 코스 세그먼트·SKU 등급 기준으로 정확화하고, 헤드룸-확인-후-차감 경합을 원자적 트랜잭션이 직접 막도록 수정. 유료 이용권(50곳+30회)과 기존 3,500원 안전상한이 실제로 공존 가능함을 구체적 숫자로 보고(BUSINESS_DECISIONS.md 3-3-7절). git stash로 재현 확인(`server/test/ai-classify-cache-and-budget-race.test.mjs` 12개, `scripts/test-ai-classify-client-queue.mjs` 8개) | **구조 연결 완료. 실제 AI 분류는 여전히 미완료**(실제 공급자 없음) | `모의(mock)로만 검증`, `실제 공급자 미연결` | AI 공급자·모델 선정 여부 결정(선정 전까지 계속 비활성) |
| R11-5 거리순 "내 위치 기준" 옵트인 + 위치 기능 정리 | `src/design/spots.js`(daRequestMyLocation, daLocationBasis, nearby), `src/design/index.html` | 앱을 여는 것만으로는 GPS를 절대 안 부르고, 거리순 옆 "내 위치 기준으로 보기" 버튼을 눌러야 그때 GPS를 요청함을 확인. GPS 거절 시 직접 좌표 입력 대안 제공(강제 종료 아님). "평균 위치"라는 표현을 정확히 씀("지정 위치"라고 잘못 부르지 않음). 예전에 "GPS 연결 전인 화면"이라던 `nearby()` 자리표시자를 실제 거리순+위치요청 동작으로 교체. 로그아웃 시 세션 GPS/직접입력 위치가 다음 계정에 안 새어 나감을 확인. 목적지 날씨(weather-card.js)는 의도적으로 GPS와 무관한 별개 기준이라는 경계를 그대로 지켰고, "향후 내 주변 날씨" 주석은 미구현임을 정직하게 남김(연결된 것처럼 보고하지 않음). git stash 불필요(신규 기능 자체를 새 테스트로 검증, `scripts/test-location-optin.mjs` 13개) | 완료 | `실사용 가능`(Chromium GPS 모킹으로 검증), `실기기(iPhone) 미검증` | 실제 iPhone에서 GPS 권한 팝업·거절 동작 직접 확인 필요 |
| R11-6 최종 회귀 + 문서 정리 + 전달 | 본 문서, `docs/BUSINESS_DECISIONS.md`, `docs/전달문서_통합본.md` | 서버 테스트 41개 + 화면(Chromium) 테스트 26개(각각 R11-2~R11-5 신규 2개씩 포함) 전체를 이번 라운드 마지막에 한 번에 실행해 전부 종료코드 0 확인. 4개 원본 문서를 통합문서로 기계적으로 재생성(`scripts/build-combined-doc.mjs`) | 완료 | `실사용 가능`(문서·검증 작업) | 없음 |

**이번 라운드에서 절대 안 한 것(9차·10차와 동일 원칙 유지)**: 실제
공개 배포, master 병합, 실과금, 유료 계약(AI 포함), SNS 게시, 외부
메시지 발송, git 히스토리 재작성, 가격/사용한도/안전상한 값 임의
변경, 실제 AI 공급자 연결, 새 지역팩·AI 여행플래너·B2B·광고 기능
추가.

**아직 "출시 준비 완료"라고 말할 수 없는 이유(11차 지시 그대로
명시)**: 실제 AI 공급자 연결, 실제 결제 테스트, 영구 저장·백업/복원의
실제 운영 검증, 실제 iPhone 핵심 흐름 확인 중 아직 안 끝난 게 있다 —
이 중 하나라도 남아 있으면 "출시 준비 완료"로 부르지 않는다. 지금
시점엔 전부 위 조건에 걸린다(AI는 미연결, 결제는 토스 실키 미연결,
iPhone 실기기 미검증 — 아래 8절 계속 참고).

**전체 회귀(11차)**: 서버 테스트 `server/test/*.test.mjs` **41개**
(10차 38개 + 신규 3개: trips 필드충돌, 태그 동기화, AI 캐시·예산
경합), 화면 테스트 `scripts/test-*.mjs` **26개**(10차 23개 + 신규
3개: 위치 옵트인, AI 분류 클라이언트 큐, 태그 레지스트리 동기화 —
태그 레지스트리 동기화는 화면 테스트 쪽에도 별도 파일로 추가됐다).
합계 **67개 파일**을 이번 라운드 마지막에 한 번에 실행해 전부
종료코드 0(전체 통과)임을 확인했다.

---

## 0. 9차 재검토 갱신 요약(가장 중요 — 여기부터 읽기)

claude_round9_handoff.md의 지시대로 앞부분 재현된 오류(1~4)부터
고치고, 그다음 확정 사업 방향·추가 요청(6-1~6-4)을 순서대로 구현했다.
아래 표에 항목별 수정 위치·재현 결과·완료 여부·실제 연결 미검증
여부·사용자가 다음에 할 일을 정리한다. **"완료"는 코드가 실제로
동작하고 합성 데이터로 검증됐다는 뜻이지, 실제 Google/토스/Resend
키·실제 iPhone 기기·실제 배포로 검증됐다는 뜻이 아니다** — 8절 참고.

| 항목 | 수정 위치 | 재현 결과 | 상태 | 실연결 미검증 | 다음 행동(사용자) |
|---|---|---|---|---|---|
| R9-1 동기화 삭제충돌 우회 | `src/design/spots.js`(daSyncPush) | 두 기기 동시 삭제·수정 시나리오를 실제 재현 — 예전엔 삭제 큐가 서버의 새 버전으로 몰래 재무장돼 최신 내용이 사라짐. 고친 뒤엔 삭제를 영구 취소하고 최신 내용을 복원함을 확인(`scripts/test-sync-conflict-devices.mjs` 4번) | 완료 | 없음(순수 클라이언트 로직) | 없음 |
| R9-2 같은 필드 충돌 보존 | `src/design/spots.js`(daRemergePlaceConflict) | 두 기기가 같은 필드를 다르게 고치는 시나리오 재현 — 예전엔 서버 값이 조용히 사라짐. 고친 뒤엔 `_fieldConflicts`로 양쪽 값을 보존하고 화면에서 선택하게 함을 확인(같은 테스트 5번) | 완료 | 없음 | 없음 |
| R9-3 courses/trips 충돌 무시 | `src/design/spots.js` | 여행 정보 동시 수정 재현 — 서버의 반려 응답이 로컬 최신 수정을 덮어씀을 확인하고 수정(같은 테스트 6번). visits는 이미 안전했음(점검만) | 완료 | 없음 | 없음 |
| R9-4 장소확인 예약 멱등성 | `server/entitlement-usage.mjs` | 이중 확정·스윕 후 뒤늦은 응답 두 시나리오를 실제로 재현해 확인(`server/test/place-lookup-reservation-idempotency.test.mjs`, 17개) | 완료 | 없음(로직 검증 — 실제 Google Places 키 연동 자체는 별도 항목) | 없음 |
| R9-5 한도소진 후 비용 노출 | `server/entitlement-usage.mjs`, `server/config.mjs` | 한도 초과 후 새 검색 반복 시나리오 재현 — 계정당 하루 20회(제안값)로 상한(`server/test/entitlement-overlimit-verify-cap.test.mjs`, 9개) | 완료 | 상한값(20회) 자체는 확정 아님, 실사용 데이터로 조정 필요 | 실사용 데이터를 보고 상한값 조정 여부 결정 |
| R9-6 날씨 이중소비+착장 날짜혼선 | `server/routes/weather.mjs`, `src/design/weather-card.js` | 동시 요청 병합 시 캡 이중 소비, 선택 날짜와 현재 날씨 혼용 두 버그 모두 실제 재현(`server/test/weather-merge-cap.test.mjs` 4개, `scripts/test-weather-outfit-note-date-scope.mjs` 7개) | 완료 | WeatherAPI.com 무료 등급 실제 키 연동은 별도 미검증 | 없음 |
| R9-7 사업 방향 문서 갱신 | `docs/BUSINESS_DECISIONS.md` 1-2절 | 해당 없음(문서 작업) | 완료 | 문서일 뿐, 아래 남은 결정 사항은 여전히 사용자 승인 필요 | 4,900원 베타가·소규모 모집 규모 등 미결 항목 검토 |
| R9-8 최소 제휴 준비 | `server/affiliates.mjs`, `src/design/affiliates.js` | 실제 등록 0건 상태에서 화면에 안 보이는지, 합성 데이터 주입 시 뜨는지 실제 확인(`server/test/affiliates.test.mjs` 14개, `scripts/test-affiliates.mjs` 15개) | 완료(구조만 — 실제 제휴 0건) | 실제 제휴사 계약·링크 전무(의도됨) | 실제 제휴 계약 체결 여부 결정 |
| R9-9 정렬+메타데이터 분리 | `src/design/import-adapter.js`, `spots.js` | 재수입 시 firstAddedAt 유지, originalSavedAt 비파괴적 채움, 레거시 항목 정렬 시 뒤로 밀림(숨지 않음)을 실제로 확인(`scripts/test-sort-and-metadata.mjs` 22개) | 완료 | 숙소 좌표 없음(거리순 기준이 센트로이드일 뿐 GPS 아님) | GPS 옵트인 버튼 추가 여부 결정 |
| R9-10 세계 공통 상위분류+다중 태그 | `src/design/import-adapter.js`, `spots.js` | 야키토리+이자카야 동시 태그, 동의어 통합, 사용자 확정 보호, 레거시 마이그레이션 전부 실제 확인(`scripts/test-tags-and-category.mjs` 17개) | 완료 | 태그 어휘 21개는 시작 세트일 뿐, 확정 목록 아님 | 태그 어휘 추가 필요 시 요청 |
| R9-11 테스트 위치 모드 | `src/design/import-adapter.js`, `spots.js` | 잠금/해제 지속성, 프리셋 적용, 거리순 연동, 해제 복귀 전부 실제 확인(`scripts/test-test-location-mode.mjs` 14개) | 완료(개발자 전용 최소 구현) | 실제 계정 화이트리스트 메커니즘 없음(쿼리파라미터 방식) — 실제 GPS·로밍 검증 아님 | 아이폰 비공개 프리뷰 방법 3가지 중 택1 |
| R9-12 소규모 베타·피드백 체계 | `server/feedback.mjs`, `server/invite-codes.mjs`, `src/design/admin.html` 등 | 접수/설문/관리자 인증/초대코드 게이트(기본 꺼짐) 전부 실제 확인(`server/test/*` 38개, `scripts/test-feedback-and-survey-ui.mjs` 16개) | 완료(실제 모집은 비활성 유지) | 화면 스크린샷 첨부 미구현(의도됨), 관리자 화면 실제 배포 안 됨 | 실제 모집 시작 여부·규모 결정 |
| R9-13 거리영상 안정성 보강 | `src/design/street-video.js` | 로드 실패(onerror)·타임아웃·낡은 콜백 세 가지 모두 실제로 재현해 확인(`scripts/test-street-video.mjs` 8~10번, 27개 전체) | 완료 | 실제 방송 등록 여전히 0건(STREET_VIDEOS 빈 표) | 실제 방송 확인 후 영상 등록 |

**이번 라운드에서 절대 안 한 것(문서에 없는 사업 기능 신규 추가
금지 지시 준수)**: 실제 공개 배포, master 병합, 실과금, 유료 계약,
SNS 게시, 외부 메시지 발송, git 히스토리 재작성, 가격/사용한도 값
임의 변경, 저가 모집 로직 무단 추가.

**전체 회귀(10차 재검토 — 수치 정정)**: 이전 판에 "server/test 전체
53개"라고 썼던 건 서버 테스트와 화면(Chromium) 테스트를 합친 뒤
잘못 센 숫자였다 — ChatGPT가 실제로 파일 수를 세어 지적한 대로
정정한다. 실제로는:
- **서버 테스트(순수 Node, DB만 사용)**: `server/test/*.test.mjs`
  **34개**(신규 R9/R10 파일 포함).
- **화면 테스트(실제 Chromium 브라우저 구동)**: `scripts/test-*.mjs`
  **21개**.
- 합계 55개 파일을 이번 라운드 마지막에 한 번에 실행해 전부 종료코드
  0(전체 통과)임을 확인했다(개별 파일 결과는 각 항목의 테스트 이름으로
  위 표에 남겼다 — 이 문서에 매 항목 반복 나열하지 않는다).

---

## 0-1. 10차 재검토 갱신 요약(9차 다음으로 중요 — 여기부터 읽기)

이 메시지는 9차 결과 검토·정정, 만료 예약/코스 동기화 데이터 손실
버그 수정, 분류 체계 세계 공통화, AI 보조 분류(기본 비활성)와 원가
검증, 위치 공급 함수 통합, 영어 지원 구조를 모두 합친 단일 지시로
받았다. 아래 표에 항목별 상태를 정리한다. **표기 원칙은 9차와
동일하다 — "완료"는 코드가 실제로 동작하고 합성 데이터로 검증됐다는
뜻이지, 실제 키·실제 기기·실제 배포 검증을 뜻하지 않는다.**

| 항목 | 수정 위치 | 재현/검증 결과 | 상태 | 실연결 미검증 | 다음 행동(사용자) |
|---|---|---|---|---|---|
| R10-1 9차 보고 정정 | `docs/RELEASE_STATUS.md` | ChatGPT가 직접 파일 수를 세어 "53개"가 서버+화면 테스트를 잘못 합산한 숫자임을 지적 — 서버 34개/화면 21개로 정정 | 완료 | 없음(문서 정정) | 없음 |
| R10-2 만료 예약 늦은 성공 무료확정 | `server/entitlement-usage.mjs`(commitNewLookupUsageCharge) | ①old 예약→②만료로 되돌림→③new 예약이 old를 스윕→④new 성공 확정→⑤만료된 old가 뒤늦게 성공 응답 — 예전엔 old가 공짜로 확정(`entitlement_place_confirmed`만 늘고 `used`는 그대로). git stash로 수정 전 재현 후 수정 확인(`server/test/entitlement-expired-reservation-late-success.test.mjs` 13개, 기존 `place-lookup-reservation-idempotency.test.mjs`도 같은 원칙으로 정정) | 완료 | 없음(순수 서버 로직) | 없음 |
| R10-3 courses/trips 충돌 시 서버 최신값 소실 | `src/design/spots.js`(daRemergeGenericConflict), `src/design/import-adapter.js`(courses/trips 기준선 신규) | 원본 v1→A가 note='SERVER-NEW' 저장 v2→B가 v1 기준으로 memo만 고쳐 저장 — 예전엔 충돌 시 "버전만 바꿔 전체 재제출"해 SERVER-NEW가 통째로 사라짐. courses/trips에도 places와 같은 기준선(baseline) 추적을 새로 추가해 필드 단위 병합으로 고침. 같은 세션에서 점검하라고 지시받은 "저장 중 새 장소 추가 보존"(응답 대기 중 추가한 장소가 사라짐)과 "기준 스냅샷의 재시작 보존"(미동기화 수정이 재시작 후 충돌에서 조용히 사라짐)도 실제로 재현해 확인 후 수정 — 기준선을 localStorage에 지속시키고 로그아웃 시 계정 간 유출 방지까지 처리. git stash로 세 건 모두 수정 전 재현 확인(`scripts/test-sync-conflict-devices.mjs` 시나리오 7~9) | 완료 | 없음(순수 클라이언트 로직) | 없음 |
| R10-4 분류 세계 공통화+태그 레지스트리 | `src/design/import-adapter.js`(TAG_REGISTRY_BUILTIN) | `daInferTags('居酒屋')`가 부분 문자열(酒屋)로 주류샵과 잘못 겹치는 문제, `daInferTags('스시 말고 라멘 먹기')`가 부정문을 실제 업종으로 오인하는 문제 둘 다 실제 재현 후 수정(문자 클래스 제외 + 부정 단서 감지). 21개 고정 정규식을 id/label/synonyms/source 분리 레지스트리로 바꾸고 사용자 태그 생성·이름수정·삭제·일괄편집 CRUD 신규 구현(place.tags는 계속 label 문자열 저장 — 비파괴적). git stash로 두 버그 모두 수정 전 재현 확인(`scripts/test-classification-registry.mjs` 22개, 기존 `test-tags-and-category.mjs`도 새 UI 구조에 맞게 갱신) | 완료 | 없음(순수 클라이언트 로직) | 새 태그 이름 수정·삭제·일괄편집은 코드는 있으나 전용 관리 화면은 없음(장소별 태그 편집 화면에서만 조작 가능) — 별도 관리 화면 필요 시 요청 |
| R10-5 자동분류 우선순위+AI 보조(기본 비활성) | `server/adapters/ai-classify.mjs`(신규), `server/routes/ai-classify.mjs`(신규), `src/design/import-adapter.js`(daApplyConfirmedTypes) | 우선순위(사용자 확정값>확인된 장소 유형>규칙>AI>미분류)를 실제 구현. 위치 확인 응답의 Google types/primaryType을 분류에 활용(분류만을 위한 새 유료 호출 없음). AI는 실제 공급자 없음(의도적 미구현) — mock 어댑터로 출력 스키마 검증(상위분류 화이트리스트, 태그 개수/길이/중복정규화, localId 위조 방지)과 비활성 기본값을 확인(`server/test/ai-classify.test.mjs` 17개, `ai-classify-mock-enabled.test.mjs` 10개, `scripts/test-place-lookup.mjs`·`test-classification-registry.mjs`에 우선순위 체인 시나리오 추가) | **구조 구현 + 모의 검증만 완료. 실제 AI 분류는 미완료**(AI 키 자체가 없음) | AI 실제 공급자·모델·단가 전부 미확정 — `/api/health` 같은 응답으로 "AI 연결됨"이라 말한 적 없음 | AI 공급자·모델 선정 여부 결정(선정 전까지 AI 보조 분류는 계속 비활성) |
| R10-6 AI 원가 검증 보고 | `docs/BUSINESS_DECISIONS.md` 3-3-6절, `scripts/analyze-classification-rate.mjs`(신규) | 실제 daInfer/daInferTags 코드를 합성 다국어 데이터로 돌려 50/160/300+3 시나리오의 ①전체 장소 수 ②규칙 해결 수 ③AI 후보 수 ④배치 요청 수를 실측(합성 데이터일 뿐 실제 고객 평균 아님을 명시). ⑤~⑦(토큰·모델·단가)은 공급자 미확정이라 미검증으로 명시, 임의 숫자 미작성. 무료체험(700원) 기준 핵심 제공량 예약 후 AI 헤드룸이 약 245원뿐임을 계산해 보고 | 완료(보고서 작성 — 실제 원가 확정은 공급자 선정 후) | 실제 AI 단가·실제 고객 분류 성공률 전부 미검증 | 3-3-6절 읽고 AI 도입 시 예산 배분 방향 결정 |
| R10-7 위치 공급 함수 통합 | `src/design/spots.js`(daLocationBasis), `server/db.mjs`(test_access 컬럼), `server/routes/entitlement.mjs`, `server/index.mjs` | 거리순·코스출발점이 공통 함수(테스트 위치>세션 GPS>평균 위치 우선순위)를 쓰도록 통합. "평균 위치"를 "지정 위치"로 잘못 부르던 표현 전부 정정. 코스 출발지의 GPS 버튼이 테스트 위치를 무시하고 항상 실제 GPS를 부르던 결함 수정(테스트 위치 켜져 있으면 그 좌표 사용, 실제 GPS 미호출을 테스트로 확인). "?testmode=1만으로 영구 잠금 해제"되던 결함을 서버 승인 모델로 교체 — accounts.test_access 컬럼 신규, 관리자 전용 API(`/api/admin/test-access`)로만 켜고 끌 수 있음, 클라이언트는 로그인마다 서버에 재확인. git stash 없이 새 서버 모델 자체를 재현 테스트로 검증(`server/test/test-access.test.mjs` 10개, `scripts/test-test-location-mode.mjs` 20개 재작성 — URL 파라미터 무효화·GPS 미호출·승인 철회 시 로컬 잔여값 무시 확인 포함) | 완료 | 실제 GPS·로밍 조건 검증 아님(테스트 위치는 좌표 치환일 뿐) | 아이폰 실기기·현지 GPS 검증은 여전히 사용자 직접 확인 필요(8절 참고) |
| R10-8 영어 지원 구조 | `src/design/import-adapter.js`(A.t/A.setLocale/A.locale) | 내부 키/표시 문구 분리 사전 조회 구조 신규(ko 사전만 존재, en 없음). 로케일 전환 전후 목적지(도쿄) 날짜·시간 완전 동일함을 재현 테스트로 확인(시간대와 로케일 무관 증명). 사전 없는 로케일 전환은 안전하게 실패 처리. 이번 라운드 신규 화면(태그 관리)만 이 구조를 실제로 씀(`scripts/test-i18n-structure.mjs` 10개) | 완료(구조만 — 번역 자체는 범위 밖) | 실제 영어 사전 없음(의도됨), 기존 화면 대부분 여전히 한국어 하드코딩 | 실제 영어 지원 착수 시점·우선순위 화면 결정 |

**이번 라운드에서 절대 안 한 것(9차와 동일 원칙 유지)**: 실제 공개
배포, master 병합, 실과금, 유료 계약(AI 포함), SNS 게시, 외부 메시지
발송, git 히스토리 재작성, 가격/사용한도 값 임의 변경, 실제 AI
공급자 연결.

**전체 회귀(10차)**: 서버 테스트 `server/test/*.test.mjs` **38개**
(9차 34개 + 신규 4개: 만료예약 재현, AI 분류 계약 2개, 테스트접근
계약), 화면 테스트 `scripts/test-*.mjs` **23개**(9차 21개 + 신규 2개:
분류 레지스트리, i18n 구조). 합계 **61개 파일**을 이번 라운드 마지막에
한 번에 실행해 전부 종료코드 0(전체 통과)임을 확인했다.

---

작성: 2026-09-10(1차) · 갱신: 2026-09-10(2차 — 확정 상품 반영) ·
갱신: 2026-09-10(3차 — 결제/이메일/경로 공급자 확정, 서버 집행 구조
재설계) · 갱신: 2026-09-10(4차 — ChatGPT가 실제로 재현한 문제 수정,
API 비용 통제 실제 구현, 경유지 상한 반영) · 갱신: 2026-09-10(5차 —
비용 SKU 단가 정확화, 비용 예약 원자성 강화, 장소조회 캐시·동시성
버그 수정, 결제·타임아웃 경계 6건, **재방문 여행자 지원 신규**,
재방문 기록 보호 동기화) · 갱신: 2026-09-10(6차 — **초기 테스트
상품(무료체험 10+1/유료 50+30) 이용권 사용량 실제 집행**, 내부 비용
안전상한, 신규판매 예산 판정에 기존 유료고객 몫 반영, **재방문
여행자 지원을 실제 화면까지 연결**, 기존 전체치환 동기화 경로
검증) · 갱신: 2026-09-10(7차 — **`/api/places` 전체치환 데이터손실을
6차에서 발견만 하고 남겨 뒀던 것을 실제로 고침**(trips/visits와 같은
버전 보호+보수적 병합), **신규 장소 확인 한도 우회 차단**(ChatGPT가
재현한 우회 — 실제 확정 결과 기준으로 재판정), **하루 비용 한도와
유료 이용권 하루 몰아쓰기 약속의 충돌 해결**, **착장 판단용 날씨 카드
신규**(WeatherAPI.com 무료 등급)) · 갱신: 2026-09-10(8차 — 7차 ZIP
검토에서 ChatGPT가 재현한 세 가지 결함을 실제로 고침: **동기화 충돌
보호 재설계**(baseVersion 기준 서버 발급 버전 — 동시 편집 데이터
손실 차단), **장소확인 빠른경로 재판정**(같은 검색조건이어도 실제
반환 장소가 바뀌면 다시 신규 판정), **날씨 시간대 버그 수정**(공급자
epoch 필드 사용 — 서버 시간대와 무관하게 항상 정확), **현지 거리·
옷차림 영상 신규**(클릭 시에만 공식 유튜브 플레이어 로드, 실제 영상
등록은 미검증)) · 갱신: 2026-09-11(9차 — ChatGPT가 재현한 동기화
삭제충돌 우회·같은 필드 충돌 손실·장소확인 예약 이중처리·비용 노출
4건 실제 수정, **사업 방향 재확정**(세계 다도시·월 100만원 목표·이용권
+재구매 모델), **최소 제휴 준비 신규**, **저장 목록 정렬+메타데이터
분리 신규**, **세계 공통 상위분류 유지+세부 다중 태그 신규**,
**테스트 위치 모드 신규**, **소규모 베타·피드백 체계 신규**(초대코드는
기본 꺼짐), **거리영상 안정성 보강**(loadIframeApi 오류·타임아웃·
낡은 콜백 정리) — 자세한 항목별 표는 위 0절 참고) · 브랜치 `design-integration`

**8차 갱신 배경**: 7차 코드를 ChatGPT가 실제로 재현·검토한 결과 세
가지 결함이 드러났다. 첫째, `account_places` 동기화가 `버전 >= 저장된
버전`이면 받아들여 두 기기가 같은 원본에서 동시에 고치면(둘 다
"버전+1"을 보내면) 뒤에 도착한 기기가 앞 기기의 수정을 조용히
지웠다 — 이제 서버만 버전을 발급하고(`baseVersion` 정확히 일치할
때만 수락), 충돌 시 3-way 재병합으로 양쪽 수정을 모두 보존한다.
둘째, "같은 로컬 슬롯+같은 검색 조건이면 빠른 경로로 신규 아님"
판정이 실제로 돌아온 장소가 바뀌었는지 전혀 대조하지 않아, 캐시 만료
후 재조회로 실제 장소가 바뀌어도 계속 비과금으로 샜다 — 이제 항상
실제 반환 식별자를 대조하고, 잠정 예약도 프로세스 종료 시 복구
가능하게 했다. 셋째, `server/adapters/weather.mjs`가 공급자의 시간대
표기 없는 "현지 시각" 문자열을 `new Date()`로 그대로 파싱해 서버가
UTC로 돌면 일본 현지 시각이 9시간 밀려 표시됐다 — 이제 epoch 필드만
쓰고 tz_id로 재지역화해 계산한다. 마지막으로 "이미 요청한" 현지
거리·옷차림 영상 기능을 범위를 제한해 신규 구현했다(클릭 시에만 공식
플레이어, 자동재생 금지, 서버 저장·중계 없음) — 단, 실제 방송 존재·
임베드 가능 여부를 이번 세션에서 검증할 방법이 없어 영상 목록은 빈
표로 남겨 뒀고, 검증된 영상이 없는 모든 도시에서 버튼이 실제로
숨겨진다(**실제 영상 등록은 사람이 직접 확인 후 별도로 진행해야
하는, 아직 안 끝난 일**). 자세한 내용은 3-3절.

**7차 갱신 배경**: 6차에서 "새로 발견했지만 미해결"로 남겨 뒀던
`/api/places` 전체치환 데이터손실 문제(아래 3절 옛 123행 참고)를 이번
세션에서 실제로 고쳤다 — trips/visits와 같은 버전 비교+보수적 병합을
`account_places`/`account_courses`에도 적용했고, 삭제는 명시적
`deletedIds`로만 이뤄지게 해 배열 누락으로 추측 삭제하지 않는다.
ChatGPT가 실제로 재현한 두 번째 우회(같은 로컬 장소 식별자에 검색어만
바꿔 보내 서로 다른 실제 장소를 무료로 확인받는 것)도 막았다 — "신규
여부"를 클라이언트 문자열이 아니라 공급자가 실제로 돌려준 장소
식별자로 재판정한다. 세 번째로, 계정별 하루 비용 한도(기본 500원)가
무료/유료 구분 없이 적용돼 유료 이용권이 약속한 "하루 안에 50곳
확인"을 11건 만에 막던 버그를 고쳤다(이용권 기간 전체 누적 한도보다
낮게 잡히지 않게 함). 마지막으로 착장 판단용 날씨 카드를 신규로
추가했다("오늘 동선" 화면 상단 — WeatherAPI.com 무료 등급, 서버가
키를 들고 소비자는 절대 키를 입력하지 않음, 로그인 없이도 볼 수
있고 이용권/비용 원장을 전혀 안 건드림). 자세한 내용은 3-2절.

- **①코드 완료** — 동작에 필요한 코드가 전부 작성됐고, 외부 서비스가
  없거나 실제 HTTP 요청으로 검증까지 끝난 기능.
- **②모의 검증** — 실제 코드 경로는 전부 진짜고, 응답을 주는 쪽만
  가짜(테스트 어댑터, `fetch` 모의 등)로 검증.
- **③실제 연결 검증** — 실제 키·실제 네트워크로 외부 서비스에 요청을
  보내 성공 응답을 실제로 받아봄.
- **④사용자 설정 필요** — 코드는 있지만 실제 키가 없거나
  (EGRESS_BLOCKED로 이 세션이 발급받지 못함), 사용자가 직접 키를
  넣고 처음 검증해야 하는 항목.
- **⑤서버 완료·화면 미연결**(5차 신규 분류) — 서버 API·DB 스키마는
  실제 HTTP 요청으로 검증까지 끝났지만, `src/design`의 실제 사용자
  화면(spots.js 등)이 아직 그 API를 부르지 않는 항목. "배치 서버
  구현"과 "사용자가 편하게 쓰는 화면"을 구분하라는 지시에 따라, 이
  상태를 ①로 부풀리지 않고 명시적으로 구분한다.

**이번에도 ③(실제 연결 검증)은 늘지 않았다** — 네트워크 제약은
4차와 동일하게 남아 있다(`docs.tosspayments.com`, `resend.com`,
`developers.google.com`, `mapsplatform.google.com` 전부 이번 세션에도
다시 시도했지만 여전히 접속 불가). 5차의 진짜 변화는 **① 코드
완료·실제 재현 테스트 통과 항목이 늘어난 것**과 **재방문 여행자
지원의 서버 쪽 전체가 새로 생긴 것(단, 화면은 아직 미연결 — ⑤)**
이다.

---

## 1. 기능별 상태

| 기능 | 상태 | 근거 |
|---|---|---|
| Google Takeout ZIP/CSV/JSON 가져오기 | **①** | `scripts/test-zip-import.mjs` 18개 |
| 재가져오기 중복 방지, 사용자 수정(유형·도시) 보존 | **①** | `scripts/design-integration-check.mjs`, `scripts/test/t49.mjs` |
| 도시별 컬렉션·검색·수동 정리 | **①** | `scripts/design-integration-check.mjs` |
| **가져오기 자체는 유료 조회를 전혀 안 함**(6-① 지시) | **①** | `server/test/reliability-and-cost.test.mjs` — 300곳을 저장(PUT /api/places)만 했을 때 `cost_ledger`에 행이 0개 늘어남을 실제로 확인 |
| **장소 조회 — 인증 필수 + 초기가져오기/재조회/일괄 3단 한도 분리** | **①** | `server/test/server-v2.test.mjs`, `server/test/reliability-and-cost.test.mjs` — 단일 조회는 `phase` 값과 무관하게 항상 requery 한도만 적용(4차 수정: 예전엔 클라이언트가 phase=import를 자기 신고해 큰 한도를 받을 수 있었다), 더 큰 배치 한도는 `/api/places/lookup-batch`로만(서버가 실제 처리 개수로 판단) |
| **장소 조회 — Places API(New) 전환, 동명 장소 지역 힌트 판별** | **①**(코드) + **②**(계약 테스트) | `server/test/provider-contracts.test.mjs` — Legacy Find Place 폐기, `v1/places:searchText` 사용, 지역 힌트와 실제로 맞는 후보를 첫 결과보다 우선(4차 신규) |
| **장소 조회 — 중복 호출 방지(캐시) + 비용 원장 기록** | **①** | `server/test/reliability-and-cost.test.mjs` — 완전히 같은 질의 반복 시 실제 유료 호출이 1건만 기록됨을 확인 |
| **장소 조회 — 계정별/전체 비용 한도(일일·월간)** | **①** | `server/cost-ledger.mjs`, `server/test/reliability-and-cost.test.mjs` — 한도 초과 시 외부 호출 자체를 안 함(503), 계정 한도가 먼저 걸리면 전체 한도를 안 건드림(순서 수정) |
| 불확실한 후보 확인(사람이 "맞아요"를 눌러야 반영) | **①** | `scripts/test-place-lookup.mjs` 11개 |
| **장소 조회 — 실제 Google Places 연결** | **④** | `mapsplatform.google.com` 접속 불가로 문서 재확인·실 키 호출 모두 못 함 |
| **개인화 코스 생성 — 서버 집행 + 저장/체험차감 원자성 + 잠금 만료·소유권 검증** | **①** | `server/test/server-v2.test.mjs`, `server/test/reliability-and-cost.test.mjs` — 체험 차감·코스 저장·결과 기록을 하나의 DB 트랜잭션으로 묶음(4차 신규), 죽은 프로세스가 남긴 오래된 잠금을 회수해 계정이 영구히 안 막힘(4차 신규, 실제 재현), 같은 멱등키에 다른 요청 본문이 오면 충돌(409) 처리(4차 신규) |
| **코스 생성 — 입력 검증(좌표 범위·장소 개수·시간 예산)** | **①** | `server/test/reliability-and-cost.test.mjs` — 위도 999, 장소 61개, 시간예산 999999분 각각 실제로 400 거부 확인(4차 신규) |
| **운영에서 경로 키 누락 시 가짜 실제경로 방지(ChatGPT 재현 버그 수정)** | **①** | `server/test/reliability-and-cost.test.mjs` — `APP_ENV=production`+키없음+ChatGPT가 쓴 것과 동일한 synthetic 좌표로 실제 `/api/course/generate`를 호출해 `routedReal:false`·체험 미차감을 확인(4차 신규, 최우선 수정) |
| **도보 경로 계산 — Google Routes(WALK), 경유지 상한(25개)·고요금 구간(11개+) 반영** | **①**(코드) + **②**(계약·재현 테스트) | `server/test/provider-contracts.test.mjs`, `server/test/routes-waypoint-limits.test.mjs`(4차 신규, 12개) — 25개 초과 시 연결된 여러 호출로 분할(경계 보존 확인), 11개 이상 구간은 고요금 SKU로 비용 기록. `server/test/cost-budget-allornothing.test.mjs`(4차 신규) — 예산이 일부만 감당 가능하면 전부 추정으로 대체(실제·추정 뒤섞임 방지) |
| **도보 경로 — 실제 Google Routes 연결** | **④** | `developers.google.com` 접속 불가 |
| 가용 시간·출발 시각 반영, 시간 초과 시 안내 | **①** | `scripts/test-course-generation.mjs` |
| 도시별 코스 분리, 여러 날짜 일정 | **①** | `scripts/test-multi-day.mjs` 28개 |
| 새 코스 생성·저장 실패 시 기존 코스 보존 | **①** | `scripts/test-course-generation.mjs`, `scripts/test-purchase-flow.mjs` |
| 저장된 코스 재열람은 새 유료 생성으로 처리 안 함 | **①** | `scripts/test-multi-day.mjs` — 날짜 탭 전환은 서버 호출 자체가 없어 `course_generated` 이벤트가 새로 안 늘어남 |
| **이메일 로그인 — 쿨다운·IP 레이트리밋·연속실패 잠금** | **①** | `server/test/server-v2.test.mjs` |
| **이메일 로그인 — 실제 Resend 발송** | **①**(코드) + **②**(계약 테스트) + **④**(실제 발송) | `server/test/provider-contracts.test.mjs` |
| 로그인 후 기존 장소·진행 중 코스 유지, 첫 코스도 로그인 필요 | **①** | `scripts/test-purchase-flow.mjs` |
| **계정별 서버 저장 — 장소·코스 동기화·병합·로그아웃 격리** | **①** | `scripts/test-account-sync.mjs` 12개 |
| **결제 — 활성 이용권 있으면 중복 구매 서버가 직접 거부** | **①** | `server/test/reliability-and-cost.test.mjs`(4차 신규) |
| **결제 — 취소 시 계정 소유자 대조(ChatGPT 재현 버그 수정)** | **①** | `server/test/reliability-and-cost.test.mjs` — 다른 계정의 주문 취소 시도가 403으로 거부되고 실제 토스 API 호출 자체가 안 나감을 확인(4차 신규, 최우선 수정) |
| **결제 — 승인 응답 유실/타임아웃 시 조회 API로 재확인(무조건 실패 확정 금지)** | **①** | `server/test/reliability-and-cost.test.mjs`(4차 신규) — 네트워크 오류로 confirm이 실패해도 조회로 실제 DONE 상태를 확인해 성공 처리, 정말 실패면 주문을 `failed`로 낙인찍지 않고 재시도 가능하게 `pending` 유지 |
| **결제 — 동시 승인/취소 요청을 주문 단위 잠금으로 방지 + 만료 회수** | **①** | `server/test/reliability-and-cost.test.mjs`(4차 신규) |
| **결제 — 과거 주문 취소·지연 웹훅이 최신 유효 이용권을 안 건드림** | **①** | `server/test/reliability-and-cost.test.mjs`(4차 신규) — `accounts.active_order_id`로 "지금 이용권을 실제로 부여한 주문"을 추적, 그 주문이 아니면 취소·웹훅이 와도 회수 안 함 |
| **결제 — 중복/지연 웹훅 멱등 처리** | **①** | `server/test/reliability-and-cost.test.mjs`(4차 신규) — 같은 성공 웹훅이 두 번 와도 부작용 없음 |
| **결제 — 부분 취소 ≠ 전액 취소(자동 이용권 회수 안 함, 정책 미확정 별도 보고)** | **①**(코드) + 정책 미확정(`docs/BUSINESS_DECISIONS.md` 5-0절) | `server/test/reliability-and-cost.test.mjs`(4차 신규) — 소비자 화면에는 부분 취소 UI 자체가 없음(완성 안 된 기능을 노출하지 않음) |
| **결제 — 서비스 전체 월간 비용 예산 소진 시 신규 결제 자체를 차단** | **①** | `server/adapters/payment-toss.mjs`의 `isServiceCostBudgetExhausted`(4차 신규 — 유료 고객이 결제만 하고 코스를 못 만드는 상황 예방) |
| 결제 실패 후 작업 화면 복귀, 중복 클릭 방지 | **①** | `scripts/test-purchase-flow.mjs` |
| **운영(production) 환경 — 테스트 기능 완전 차단** | **①** | `server/test/production-boot.test.mjs` 8개 |
| "키 있음"과 "실제 연결 확인됨" 구분 표시 | **①** | `/api/health`의 `services` vs `verified` |
| 서비스별 독립 연결 상태 | **①** | `server/test/config.test.mjs` 18개 |
| 측정 이벤트(유입~구매 퍼널) | **①** | `server/test/server.test.mjs` |
| 한글/가나 완성형 폰트, 전송량 최적화 | **①** | `scripts/test-font-coverage.mjs` |
| cp1_→cs1_ 저장소 마이그레이션 | **①** | `scripts/test-storage-migration.mjs` |
| 소개 페이지 + 사전 신청 | **①** | `scripts/test-landing-page.mjs` 11개 |
| **비용 SKU 단가 — 공식 등급·달러 단가·계산용 환율·안전 여유 분리** | **①** | `server/config.mjs`의 `buildCostEstimateMicros`, `server/test/config.test.mjs` — Text Search **Pro**($32/1000)·Routes Compute Essentials($5/1000)/Pro($10/1000) 등급을 실제 사용 필드 기준으로 반영(5차), FX는 계산용 가정치(1,400원/$)로 명시 분리, 안전 여유(`costSafetyMarginRatio`)는 예산 상한에만 적용하고 단가 자체엔 안 섞음 |
| **비용 예약 — 세그먼트 전체를 하나의 트랜잭션으로 all-or-nothing 확정** | **①** | `server/cost-ledger.mjs`의 `chargeCostBatch`(`BEGIN IMMEDIATE`), `server/test/cost-budget-allornothing.test.mjs` — "첫 세그먼트는 예산 안에 들어도 전체 합계가 넘으면 그 무엇도 기록 안 함"을 실제로 재현·확인(5차, ChatGPT가 재현한 부분기록 버그 수정) |
| **계정별 월간 비용 한도 신설** | **①** | `server/config.mjs`의 `costBudget.perAccountMonthlyMicros` |
| **장소 조회 — 캐시 키에 지역 힌트 포함(동명 장소 캐시 오염 방지)** | **①** | `server/routes/places.mjs`, `server/test/reliability-and-cost.test.mjs` §6 — Tokyo/Kyoto 같은 질의·다른 지역 힌트가 서로 결과를 오염시키지 않고 각자 재조회됨을 확인(5차) |
| **장소 조회 — 동시 중복 요청 in-flight 병합** | **①** | 〃 — 완전히 같은 조건의 동시 요청 2건이 실제 외부 호출은 1건만 나감을 확인(5차) |
| **장소 조회 — 실패/설정미비 응답은 오래 캐시하지 않음** | **①** | `server/routes/places.mjs`의 `shouldCache` — `ok:true`·`not-found`만 캐시, `network-error`/`no-api-key-configured` 등은 캐시 안 함(5차) |
| **장소 조회 일괄 확인 화면 연결(`/api/places/lookup-batch`)** | **①** | `src/design/spots.js`의 `daBatchLookupFlow` — "오늘 동선"에서 좌표 미확인 장소가 있을 때만 노출, 가져오기·목록열람만으로는 절대 안 뜸(5차 신규 — 배치 서버와 화면을 실제로 연결) |
| **결제 — `paymentMatchesOrder` 필드 누락 시 무조건 통과하던 버그 수정 + paymentKey 대조 추가** | **①** | `server/adapters/payment-toss.mjs`, `server/test/reliability-and-cost.test.mjs`(a) — 주문번호·금액·통화·결제키 중 하나라도 없으면 불일치로 거부(5차) |
| **결제 — 여러 pending 주문으로 중복구매 차단 우회 방지(confirm-time 검사)** | **①** | 〃(b) — 두 주문이 경쟁적으로 만들어져도, 이미 활성 이용권을 부여한 다른 주문이 있으면 confirm 단계에서 토스 호출 전에 거부 |
| **결제 — 부분취소 판정을 공급자 응답(상태·잔액·누적취소액) 기준으로** | **①** | 〃(c) — 클라이언트가 부분 취소를 요청해도 공급자 응답이 잔액 0이면 전액으로 정확히 기록 |
| **결제 — 결제 가능 여부 판정 확장(일일예산·최소생성비·라우팅불가)** | **①** | `server/adapters/payment-toss.mjs`의 `isServiceUnavailableForNewSales` — 월간 한도 완전 소진뿐 아니라 일일 한도·최소 코스 생성비 부족·운영에서 경로 키 없음까지 신규 판매 차단 사유로 봄, 새 주문만 막고 진행 중인 confirm은 안 건드림 |
| **결제 — 이미 승인된 결제의 복구는 신규판매 차단과 분리** | **①** | 〃(e) — 같은 주문의 재확인(복구)은 차단 로직에 안 걸림을 확인 |
| **결제 — `createOrderRoute`가 실패 응답을 200으로 덮어쓰던 버그 수정** | **①** | `server/routes/payment.mjs`(f) |
| **타임아웃 — 응답 본문 읽기 단계까지 보호(헤더만 받고 끝나던 버그 수정)** | **①** | `server/net.mjs`의 `fetchWithTimeout`, `server/test/reliability-and-cost.test.mjs` §8(g) — 헤더 수신 후 본문 스트림이 영원히 멈추는 응답도 결국 타임아웃으로 정리됨을 재현 확인 |
| **초기 테스트 상품 — 무료체험 위치확인 최대 10곳+코스 1회, 유료 이용권 위치확인 최대 50곳+코스 30회(30일)** | **①**(6차 신규) | `server/entitlement-usage.mjs`, `server/config.mjs`의 `entitlementUsage` — 성공한 결과에만 차감(실패·추정 결과는 미차감), 이미 위치가 확인된 장소를 재조회해도 새 장소 한도를 안 깎음(영구 dedupe), `server/test/entitlement-usage.test.mjs`(14개)·`server/test/entitlement-course-limit.test.mjs`(6개)에서 확인. **이 숫자는 출시 전 검증된 시장가격이 아니라 초기 테스트 상품 스펙**(`docs/BUSINESS_DECISIONS.md` 참고) |
| **초기 테스트 상품 — 30일 유료 이용권은 주문(order_id) 단위로 집계, 달력월 경계와 무관** | **①**(6차 신규) | `server/entitlement-usage.mjs`의 `currentPeriod` — 사용량이 `accounts.active_order_id`에 고정된 버킷에 쌓여 달력월이 바뀌어도 초기화 안 됨, `server/test/entitlement-period-month-boundary.test.mjs`(8개)에서 1월→2월 경계를 직접 재현해 확인 |
| **내부 비용 안전상한 — 무료체험 계정 700원/유료 이용권 3,500원(고객 잔액 표시 아님)** | **①**(6차 신규) | `server/config.mjs`의 `costSafetyCap`, `server/cost-ledger.mjs`의 `chargeCostBatch` — 실제 원가가 이 상한을 넘으려는 순간 그 이상의 실제 유료 호출 자체를 막음, `server/test/cost-safety-cap.test.mjs`(3개)에서 확인. 현재 단가 기준 계산상 무료체험 최악 사용량은 약 455원, 유료 최악은 약 2,450원으로 상한 안에 들어오지만(`docs/BUSINESS_DECISIONS.md` 참고), 실제 공급자 단가가 바뀌면 이 여유가 줄어들 수 있어 계속 지켜봐야 함 |
| **신규 판매 가능 여부 — 전체 예산에서 기존 유료 고객에게 약속된 잔여 몫까지 먼저 뺀 뒤 판단** | **①**(6차 신규) | `server/adapters/payment-toss.mjs`의 `totalCommittedRemainingMicros`/`isServiceUnavailableForNewSales` — 활성 유료 고객이 늘어 약속된 몫 합계가 예산을 압박하면 새 결제를 거부(이미 쓴 것은 계산에 안 들어감, 이용권 만료는 계산에서 빠짐), `server/test/new-sale-committed-budget.test.mjs`(3개)에서 확인 |
| **구매 화면 — 가격·기간·자동갱신 여부·포함 사용량 표시** | **①**(6차 신규) | `src/design/spots.js`의 `showPaywallSheet`, `server/routes/entitlement.mjs`의 `priceWithIncludedUsage` — 서버 설정값을 그대로 실어 보내 화면에 하드코딩된 숫자가 없음, `scripts/test-purchase-flow.mjs`에서 실제 화면 텍스트로 확인 |
| **계정(프로필) 화면 — 남은 위치확인·코스생성 횟수 표시(API/SKU 등 개발 용어 없이)** | **①**(6차 신규) | `src/design/spots.js`의 `profile()`, `GET /api/account/usage` — "남은 위치 확인: N곳(전체 M곳 중)" 형태로 사람 말로 표시, `scripts/test-purchase-flow.mjs`에서 실제 서버 사용량과 화면 텍스트가 일치함을 확인 |
| **재방문 여행자 — 여행 목록·전환 화면(같은 도시 다른 여행도 카드로 구분)** | **①**(6차 — 화면 연결 완료) | `src/design/spots.js`의 `tripPickerSheet`/`chooseTrip`/`tripBlockHTML`, `scripts/test-revisit-flow.mjs` — 같은 도시에 여행이 2개 이상이면 "오늘 동선"·"오늘의 코스" 화면에 지금 여행 이름이 표시되고 "바꾸기"로 카드 목록에서 고를 수 있음을 실제 화면에서 확인. 여행이 하나뿐이면(마이그레이션된 기존 계정 포함) 예전과 완전히 같은 화면 |
| **재방문 여행자 — 새 여행 만들기(이름·날짜·숙소, 과거 여행 보존)** | **①**(6차) | `src/design/spots.js`의 `newTripFormSheet`, `scripts/test-revisit-flow.mjs` — 같은 도시로 새 여행을 만들어도 여행이 2개로 늘어나고 과거 여행의 코스가 그대로 남아 있음을 확인, `scripts/test-sync-protection-screens.mjs` (f) — 서버 오류로 만들기가 실패하면 성공한 것처럼 안 넘어가고 화면에 남아 재시도로 성공함을 확인 |
| **재방문 여행자 — 방문 표시 버튼(방문완료·취소·다시가고싶음)·방문 상태 필터·반복 방문일/메모** | **①**(6차) | `src/design/spots.js`의 `visitBlockHTML`/`visitAction`, `#visitFilters`(전체/미방문/방문함/다시가고싶음) — 장소 상세에서 코스에 담는 것과 완전히 분리된 버튼으로 확인, 방문 기록이 하나라도 생기면 목록 화면에 방문 상태 필터가 나타나 실제로 좁혀짐을 `scripts/test-revisit-flow.mjs`에서 확인 |
| **재방문 여행자 — 다음 여행 코스 후보 제안 화면 연결(이월, 새 화면 안 만듦)** | **①**(6차) | `src/design/spots.js`의 `carryForwardSheet`(기존 "오늘 동선" 화면에 얹음) — 같은 도시에 다른 여행이 있고 동선이 비어 있을 때만 "지난 여행에서 담아 둔 곳 이어가기" 진입점이 뜨고, 미방문 우선으로 정렬된 후보를 실제로 오늘 동선에 담을 수 있음을 확인. 사용자가 이미 고른 곳은 이 목록과 무관하게 항상 코스에 반영됨(서버가 애초에 필터링 안 함) |
| **재방문 여행자 — 코스 생성이 현재 tripId를 실어 그 여행 아래 저장** | **①**(6차) | `src/design/spots.js`의 `ensureTripForCity`/`runRealCourseGeneration` — 여행이 없는 새 도시는 조용히 하나 자동 생성(진입장벽 없음), 두 여행에서 각각 만든 코스가 서버에서 완전히 분리 저장되고 서로 안 섞임을 `GET /api/trips/:tripId/courses`로 직접 확인 |
| **재방문 여행자 — 무료/유료 경계(기록 읽기·쓰기는 항상 무료)** | **①** | `server/test/trips-and-visits.test.mjs` §4 — 여행 여러 개 생성·도시 전환·방문 기록 읽기/쓰기를 반복해도 무료체험이 전혀 안 깎이고, 유료 이용권이 없어도 방문 기록 API가 그대로 동작함을 확인 |
| **재방문 기록 보호 동기화 — 버전 확인 후 충돌 시 재병합(조용한 전체 덮어쓰기 방지) + 로그인/저장/로그아웃 실제 연결** | **①**(6차 — 화면 연결 완료) | `server/routes/trips.mjs`의 `syncTrips`, `server/routes/visits.mjs`의 `syncVisits`, `server/test/trips-visits-sync.test.mjs`(서버 5개 시나리오) — 클라이언트 쪽은 `src/design/spots.js`의 `daSyncPush`가 로그인 직후(`daSyncPullAndMerge`)와 매 로컬 저장마다(`daSyncPushSafe`) `/api/trips/sync`·`/api/visits/sync`를 실제로 부르도록 연결(예전엔 이 엔드포인트를 클라이언트가 아예 안 불렀다), 로그아웃 시 `foodMap.trips`/`foodMap.visits` 로컬 삭제. `scripts/test-sync-protection-screens.mjs` (b)(c)(e) — 서로 다른 기기의 여행 추가가 둘 다 보존됨, 방문 취소 후 오래된 기기 재연결에도 안 되살아남, 계정 전환/로그아웃 시 다른 계정 데이터가 안 새어나감을 실제 화면에서 확인 |
| **`/api/places`·`/api/courses` 전체치환 데이터손실 — 해결됨(7차)** | **①**(7차 — 6차에서 발견만 하고 남겨 뒀던 것을 실제로 고침) | `server/routes/account-data.mjs`의 `syncPlaces`/`syncCourses` — trips/visits와 같은 버전 비교+보수적 병합을 적용(뒤처진 기기의 수정은 조용히 덮어쓰지 않고 `conflicts`로 보고). 삭제는 명시적 `deletedIds`로만 이뤄지고(배열 누락으로 추측 삭제 안 함), 이미 지워진 장소는 오래된 기기가 다시 들고 나타나도 안 되살아남(무덤 표시). `server/test/places-courses-sync.test.mjs`(16개), `scripts/test-sync-protection-screens.mjs` (a) — 이제 실제로 통과함(6차엔 여기서 실패했다) |
| **신규 장소 확인 한도 우회 차단(7차)** | **①**(7차) | `server/entitlement-usage.mjs`의 예약(reserve)/확정(finalize) 2단계 — 예전엔 "신규 여부"를 클라이언트가 불러주는 로컬 장소 식별자만으로 판정해, 같은 식별자에 검색어만 바꿔 보내면 서로 다른 실제 장소를 무료로 확인받는 우회가 가능했다(ChatGPT가 실제로 재현: 한도 1로 두고 6곳을 확인받았는데 사용량은 1로만 기록). 이제 공급자가 실제로 돌려준 장소 식별자로 재판정한다(같은 로컬 id+다른 검색어→실제로 다른 장소면 각각 과금, 다른 로컬 id+같은 실제 장소→비과금). `server/test/place-lookup-entitlement-bypass.test.mjs`(16개, 재현 조건 3가지 전부) |
| **하루 비용 한도와 유료 이용권 약속의 충돌 해결(7차)** | **①**(7차) | `server/cost-ledger.mjs`의 `chargeCostBatch` — 계정별 하루 비용 한도(기본 500원)가 무료/유료 구분 없이 적용돼, 위치확인 단가(약 44.8원) 기준 11건 만에 소진돼 유료 이용권의 "하루 50곳" 약속이 애초에 불가능했다. 이제 이용권 기간 전체 누적 안전상한(무료 700원/유료 3,500원)보다 낮게 잡히지 않는다 — 이용권 몫을 하루 안에 몰아 써도 되지만 총량은 여전히 이용권 기간 누적 한도가 지킨다. `server/test/paid-daily-burst-budget.test.mjs`(11개, 출고 기본값 그대로 유료 고객 50곳+코스 1회를 하루에 마침을 확인) |
| **착장 판단용 날씨 카드(7차 신규)** | **②**(모의 검증 — WeatherAPI.com 실제 키 미연결) | `server/adapters/weather.mjs`, `server/routes/weather.mjs`(`/api/weather`), `src/design/weather-card.js` — "오늘 동선" 화면 상단에 현재 날씨·오늘 예보(최고/최저/저녁)·시간대별 강수확률/바람·규칙 기반 착장 문구를 보여준다. 로그인 불필요(이용권/비용 원장 전혀 안 건드림), 지역 단위(~1km) 캐시 공유로 도시 선택마다 새 호출 안 함, 실패 시 마지막 캐시를 시각과 함께 대체. `server/test/weather-route.test.mjs`(12개)·`weather-stale-fallback.test.mjs`(6개), `scripts/test-weather-card.mjs`(13개, 실제 Chromium) |
| **동기화 충돌 보호 재설계 — baseVersion(8차)** | **①**(8차 — ChatGPT 재현 결함 수정) | `server/routes/account-data.mjs`(`syncPlaces`/`syncCourses`)·`trips.mjs`·`visits.mjs` — 예전엔 `incomingVersion >= existing.version`이면 수락해, 같은 원본에서 동시에 편집한 두 기기가 둘 다 "버전+1"을 보내면 뒤에 도착한 기기가 앞 기기의 수정을 조용히 지웠다. 이제 서버만 새 버전을 발급하고 `baseVersion === existing.version`(정확히 일치)일 때만 수락 — 불일치는 전부 충돌로 보고하고 서버의 현재 값을 함께 돌려준다. 클라이언트(`src/design/import-adapter.js`·`spots.js`)는 로컬에서 버전을 더 이상 임의로 올리지 않고, 충돌이 나면 3-way 재병합(`daRemergePlaceConflict` — 내가 안 건드린 필드는 서버 값 채택, 내가 고친 필드는 유지)으로 양쪽 수정을 모두 보존한 뒤 자동 재시도한다. 삭제도 `{id, baseVersion}`로 같은 보호를 받는다(뒤처진 기기의 삭제 의도가 방금 확정된 좌표를 지우지 못함). `server/test/sync-conflict-protection.test.mjs`(24개), `scripts/test-sync-conflict-devices.mjs`(9개, 실제 Chromium 두 기기 — 동시 다른 필드 편집·수정vs삭제 충돌·저장 중 추가 편집 3가지 실화면 재현) |
| **장소확인 빠른경로 재판정(8차)** | **①**(8차 — ChatGPT 재현 결함 수정) | `server/entitlement-usage.mjs` — 예전엔 "같은 로컬 슬롯+같은 검색 지문"이면 빠른 경로로 곧바로 "신규 아님" 처리하고, 실제로 돌아온 장소가 바뀌었는지 전혀 대조하지 않았다(캐시 만료 후 재조회로 공급자가 실제 다른 장소를 줘도 링크만 바뀌고 사용량은 그대로였다 — ChatGPT 재현). 이제 빠른 경로라도 실제 반환 `placeId`를 매번 대조해, 바뀌었으면 신규 판정 절차를 다시 거친다. 한도가 이미 다 찬 상태에서도 reserve가 곧바로 거절하지 않고 finalize까지 판정을 미뤄, "다른 로컬 id로 이미 확인된 실제 장소"의 재사용은 한도와 무관하게 여전히 성공한다. 잠정 예약(사용량 +1)이 서버 프로세스 종료로 finalize 없이 유실돼 영구 소비되던 문제도 `entitlement_place_reservations` 표(generation_locks와 같은 만료 회수 패턴)로 고쳤다. `server/test/place-lookup-fast-path.test.mjs`(12개, 재현 조건 그대로), `server/test/place-lookup-reservation-recovery.test.mjs`(17개, 프로세스 종료 시뮬레이션 포함) |
| **날씨 시간대 버그 수정(8차)** | **①**(8차 — ChatGPT 재현 결함 수정, 파싱 로직 자체는 실제 검증됨) | `server/adapters/weather.mjs`, `server/routes/weather.mjs` — 예전엔 공급자의 `last_updated`·`hour.time`(시간대 표기 없는 "목적지 현지 시각" 문자열)을 `new Date()`로 그대로 파싱해, 시간대 표기 없는 문자열이 "서버의 로컬 시간대"로 해석되는 규격 특성상 서버가 UTC로 돌면 일본 현지 21시가 "21:00Z"로 잘못 해석되고 화면에서 다시 +9시간 밀려(다음날 새벽) 표시됐다. 이제 공급자의 epoch 필드(`last_updated_epoch`·`hour.time_epoch`·`location.localtime_epoch`)만으로 절대 시각을 만들고, "오늘인지"·"지금 몇 시인지"도 서버 시간대가 아니라 목적지의 `tz_id`로 재지역화해 계산한다. 사용자가 고른 여행 날짜의 예보와 오늘의 현재값을 서버가 분리해 내려주고(공급자가 실제 보장하는 3일 밖 날짜는 오늘 값을 그 날짜인 척 보여주지 않고 정직하게 범위 밖 표시), 위경도 범위 검증과 동일 지역 동시요청 병합도 추가했다. `server/test/weather-timezone.test.mjs`(16개 — 도쿄·방콕·뉴욕·현지 자정 경계·날짜 커버리지·동시요청 병합을 `globalThis.fetch` 모의로 실제 파싱 로직까지 실행해 검증. WeatherAPI.com 실제 키 연결 자체는 여전히 미검증) |
| **현지 거리·옷차림 영상(8차 신규, 범위 제한)** | **②**(모의 검증 — 실제 영상 미등록, 아래 참고) | `src/design/street-video.js` — 날씨 카드 아래 "현지 거리 · 옷차림 보기" 버튼. 클릭했을 때만 공식 유튜브 임베드 플레이어(`youtube.com/embed`, `autoplay=0`)를 불러오고(미리 로드 안 함), 닫으면 iframe `src`를 비워 재생을 실제로 멈춘다. 촬영 장소·제공 채널·현지 시간과 "영상 시청 시 데이터가 사용돼요" 안내를 표시하고, "현지인"이라 단정하지 않고 "현지 거리의 옷차림"으로만 표현한다. LIVE 상태를 직접 단정하는 배지는 아예 안 만든다. IFrame Player API(`onError`)로 임베드 거부·방송 종료를 실제로 감지해 원본 유튜브 링크로 대체한다. 서버가 영상을 저장·중계하지 않는다(서버 라우트 자체가 없음). **`STREET_VIDEOS`(도시별 검증된 영상 표)는 빈 표로 배포됨** — 실제 방송 존재·임베드 가능 여부·카메라 각도(옷차림이 보이는지)를 이번 세션에서 검증할 방법이 없어(가짜 videoId를 지어내지 말라는 지시) 검증된 영상이 없는 모든 도시에서 버튼이 실제로 숨겨진다. `scripts/test-street-video.mjs`(22개, 실제 Chromium) — 이 테스트가 직접 주입한 합성(명백히 테스트 전용) 픽스처로 플레이어 구조·표시 문구·닫기 동작·오류 대체 화면만 검증했다. **실제 영상 등록은 사람이 직접 방송을 확인한 뒤 별도로 진행해야 하는, 아직 안 끝난 일이다.** |

**요약**: ChatGPT가 4차·5차·6차·7차에서 지적한 문제는 모두 실제 코드
수정 + 재현 테스트 통과까지 끝났다. 이번 8차에서는 7차 ZIP을 실제로
재현·검토해 드러난 동기화 충돌 보호·장소확인 빠른경로·날씨 시간대
세 가지 결함을 전부 재현 테스트부터 작성해 고쳤고, 범위를 제한한
현지 거리·옷차림 영상 기능을 신규로 추가했다(실제 영상 등록은
미검증 — 위 표 참고). 자세한 내용은 3-3절.

**요약(7차)**: ChatGPT가 4차·5차·6차에서 지적한 문제는 모두 실제 코드 수정
+ 재현 테스트 통과까지 끝났다. 이번 7차에서는 (1) 6차에서 발견만
하고 남겨 뒀던 `/api/places`·`/api/courses` 전체치환 데이터손실을
실제로 고쳤고(trips/visits와 같은 버전 보호), (2) ChatGPT가 재현한
신규 장소 확인 한도 우회를 막았으며(공급자의 실제 확정 결과로
재판정), (3) 계정별 하루 비용 한도가 무료/유료 구분 없이 적용돼 유료
이용권의 "하루 50곳" 약속을 사실상 불가능하게 만들던 버그를
고쳤고, (4) 착장 판단용 날씨 카드를 신규로 추가했다(WeatherAPI.com
무료 등급, 서버가 키를 들고 소비자는 입력 안 함). 남은 ③(실제 키
연결) 미검증은 이전 차수와 동일하게 다섯 공급자(Toss/Resend/Google
Places/Google Routes/WeatherAPI)의 네트워크 제약 때문이며, 코드가
없어서가 아니다(2절 참고).

---

## 2. 이번 세션에서 못 하는 검증 — 사용자가 직접 확인할 최소 절차

### 2-1. 실제 키로 첫 연결 확인(가장 중요 — 3차와 동일하게 여전히 미검증)

- **상태**: Resend/토스페이먼츠/Google Places+Routes/WeatherAPI
  다섯 서비스 모두 실제 키로 검증된 적이 없다(WeatherAPI는 7차
  신규). 이번 세션도 공식 문서 사이트 전부 접속이 막혀 있었다
  (EGRESS_BLOCKED — weatherapi.com도 마찬가지로 확인 안 됨,
  `www.weatherapi.com/pricing.aspx`·`/docs/`의 요금·형식은 ChatGPT가
  확인해 전달한 내용 기준).
- **확인 절차**: `docs/BUSINESS_DECISIONS.md` 6절 표대로 키를 하나씩
  넣어 가며 `/api/health`의 `services`/`verified`와 실제 화면 동작을
  확인한다.
- **특히 4차에서 새로 생긴 확인 포인트**: 토스 승인 응답에
  `totalAmount`/`currency` 필드가 실제로 우리가 가정한 이름·형식으로
  오는지(`paymentMatchesOrder` 함수가 이 이름을 그대로 씀 —
  다르면 정상 승인도 위조 의심으로 거부될 수 있다), Places API(New)의
  `v1/places:searchText` 응답이 `places[].location.latitude/longitude`
  형식이 맞는지, Routes 경유지 25개 상한이 실제로 그 숫자가 맞는지
  (ChatGPT 확인 기준이지 이 세션이 재확인한 게 아니다).

### 2-2. 실제 Google Takeout 데이터

- **상태**: 179건 실사용 데이터셋이 이 샌드박스에 없어 재실행 못 함.

### 2-3. 모바일 Safari(iOS)

- **상태**: 실제 iPhone·Safari 미검증. 4차에서 새로 추가된 배치
  조회·비용 한도 초과 메시지가 실기기 화면에서 자연스럽게 보이는지도
  함께 확인 필요.

### 2-4. 느린 네트워크

- **상태**: 폰트 로딩만 검증됨. 4차에서 추가된 외부 요청 타임아웃
  (`EXTERNAL_REQUEST_TIMEOUT_MS`, 기본 8초)이 실제로 느린 네트워크에서
  사용자 경험에 어떤 영향을 주는지(너무 짧아 정상 요청도 끊기는 건
  아닌지)는 실기기·실네트워크 확인이 필요하다.

### 2-5. 현지 거리·옷차림 영상 — 실제 영상 등록(8차 신규, 출시 전 필수)

- **상태**: 미검증·미등록. `src/design/street-video.js`의
  `STREET_VIDEOS`가 빈 표라 지금은 **모든 도시에서 버튼 자체가
  보이지 않는다**(의도된 안전한 기본값 — 검증 안 된 영상을 지어내지
  않기 위해). 실제 방송 존재·현재 임베드 가능 여부·카메라 각도(사람
  옷차림이 실제로 잘 보이는지)를 이번 세션은 실제로 볼 방법이 없어
  검증하지 못했다.
- **해야 할 일(사람이 직접)**: 도시별로 촬영 장소가 명확하고 임베드가
  허용된 유튜브 영상을 최소 1개씩 직접 재생해서 확인한 뒤,
  `src/design/street-video.js`의 `STREET_VIDEOS` 표에 `{videoId,
  title, channel, filmingLocation, tzId, sourceUrl}`로 추가한다.
  실시간 방송이면 방송이 끝나거나 채널이 영상을 내리면 그 즉시
  깨지므로(IFrame Player API가 `onError`로 감지해 원본 링크로는
  대체하지만, "볼 수 있는 영상"이 아예 없어지는 건 막지 못한다) 정기
  점검이 필요하다는 점도 함께 남긴다.
- **9차 재검토 — 안정성 보강(재현된 버그 수정)**: `loadIframeApi`가
  스크립트 로드 실패(`onerror`)·응답 없음(타임아웃, 8초) 둘 다 처리가
  전혀 없어서, 느린 해외 연결이나 광고 차단 환경에서 패널이 "닫기"
  버튼도 못 뜬 채 영원히 빈 채로 남을 수 있었다 — 실제로 재현해 확인한
  뒤 둘 다 원본 링크 안내로 정직하게 대체되게 고쳤다. 또한 패널을 열
  때마다 세대(generation) 번호를 올려, 닫기→다른 영상 빠른 재열기
  사이에 첫 번째 열기의 응답이 뒤늦게 도착해도 그 낡은 콜백이 고정
  id를 쓰는 새 iframe에 몰래 올라타 중복 `YT.Player`를 만드는 사고를
  막았다(전부 `scripts/test-street-video.mjs`의 8~10번에서 실제
  재현으로 확인). "항상 원본 링크를 함께 제공"하라는 지시에 맞춰,
  임베드 시도 중에도 원본 유튜브 링크를 패널에 상시 노출하도록 바꿨다.

---

## 3. 이번 4차 갱신에서 고친 문제 목록(ChatGPT 재현 기준)

| # | 지적된 문제 | 고친 내용 | 재현 테스트 |
|---|---|---|---|
| 1 | 운영+경로키없음에서 `routedReal:true` 가짜 성공 생성 가능 | `services.routing==='test'`일 때만 시뮬레이터 호출, `'unavailable'`이면 절대 안 부름 | `server/test/reliability-and-cost.test.mjs` §1 |
| 2 | `/api/payment/cancel`이 계정 대조 없이 취소 | accountId로 주문 소유자 필수 대조 | 〃 §2 |
| 3 | 승인 응답 유실 시 무조건 실패 처리 | 조회 API로 재확인 후 판단, 미확정이면 `pending` 유지 | 〃 §1-2 |
| 4 | 부분 취소=전액 취소로 혼동 가능 | 상태·이용권 처리 분리, UI엔 미노출 | 〃 §2 |
| 5 | 과거 주문 취소가 최신 이용권 훼손 가능 | `active_order_id`로 주문별 권리 관리 | 〃 §2 |
| 6 | 중복/지연 웹훅으로 이중 지급·오취소 가능 | 상태 전이 멱등화 + 주문 단위 잠금 | 〃 §2 |
| 7 | 결제 승인 동시 요청 시 중복 호출 가능 | order 단위 잠금(만료 회수 포함) | 〃 §3 |
| 8 | 체험 차감·코스 저장이 트랜잭션으로 안 묶임 | 하나의 BEGIN/COMMIT/ROLLBACK으로 통합 | 〃 §4 |
| 9 | generation_locks에 만료·소유권 검증 없음 | job_id 소유권 + 시간 기반 회수 | 〃 §4 |
| 10 | 같은 멱등키·다른 요청 본문 미검출 | request_hash 비교 후 충돌(409) | 〃 §4 |
| 11 | 좌표·장소개수·시간예산 서버 미검증 | 범위·상한 검증 추가 | 〃 §4 |
| 12 | Legacy Find Place 첫 후보 그대로 확정 | Places API(New) + 지역 힌트 판별 | `server/test/provider-contracts.test.mjs` |
| 13 | phase 파라미터가 클라이언트 자기 신고 | 단일 조회는 항상 requery 한도, 큰 한도는 배치 엔드포인트 전용 | `server/test/server-v2.test.mjs` |
| 14 | 장소 조회 계정별 호출 한도 자체가 무의미(재확인) | 캐시 dedup + 계정별/전체 순서 수정 | 〃, `reliability-and-cost.test.mjs` §6 |
| 15 | API 비용을 서버가 전혀 통제 안 함 | SKU별 비용 원장 + 일일/월간 한도(chargeCost) | 〃 §7 |
| 16 | Routes 경유지 25개 상한 미반영 | 세그먼트 분할(경계 보존) + 11개 이상 고요금 SKU | `server/test/routes-waypoint-limits.test.mjs` |
| 17 | 예산 부족 시 일부만 실제·일부만 추정으로 뒤섞일 위험 | all-or-nothing(예산 부족하면 전부 추정) | `server/test/cost-budget-allornothing.test.mjs` |
| 18 | 활성 이용권 있어도 중복 결제 가능 | createOrder가 서버에서 직접 거부 | `reliability-and-cost.test.mjs` §2 |
| 19 | 서비스 전체 예산 소진 상태에서도 결제만 받을 수 있음 | 월간 예산 소진 시 신규 주문 자체를 차단 | `payment-toss.mjs`의 `isServiceCostBudgetExhausted` |

---

## 3-1. 이번 5차 갱신에서 고친 문제 목록(ChatGPT 재현 기준)

| # | 지적된 문제 | 고친 내용 | 재현 테스트 |
|---|---|---|---|
| 1 | 비용 SKU가 최저 등급으로 잘못 추정(실제는 Text Search Pro 등급) | 공식 등급·달러 단가·계산용 환율·안전 여유를 분리해 설정, 실제 요청 필드 기준으로 등급 반영 | `server/test/config.test.mjs` |
| 2 | `chargeCost`가 세그먼트별로 따로 불려 부분기록(실제 호출 0번인데 비용 1건 남음) | `chargeCostBatch`로 전체 합계를 하나의 트랜잭션(`BEGIN IMMEDIATE`)에서 확인 후 all-or-nothing 기록 | `server/test/cost-budget-allornothing.test.mjs` |
| 3 | 계정별 월간 비용 한도 없음 | `costBudget.perAccountMonthlyMicros` 신설 | `server/test/config.test.mjs` |
| 4 | 장소 조회 캐시 키가 지역을 안 담아 동명 장소 캐시 오염(Tokyo→Kyoto) | 캐시 키에 `expectedArea` 포함 | `server/test/reliability-and-cost.test.mjs` §6 |
| 5 | 동시에 같은 질의를 보내면 중복 외부 호출 발생 | in-flight 요청을 하나의 Promise로 병합 | 〃 §6 |
| 6 | 실패/설정미비 응답이 정상 결과처럼 오래 캐시됨 | `shouldCache`로 안정적인 답(`ok`/`not-found`)만 캐시 | `server/routes/places.mjs` |
| 7 | `/api/places/lookup-batch`가 서버엔 있지만 화면에서 안 불림 | `src/design/spots.js`의 `daBatchLookupFlow`로 "오늘 동선" 화면에 연결(가져오기·목록열람만으론 안 뜸) | `src/design/spots.js` |
| 8 | `paymentMatchesOrder`가 필드 누락 시 검사를 건너뛰고 통과시킴 | 누락 시 불일치로 처리, `paymentKey` 대조 추가 | `server/test/reliability-and-cost.test.mjs`(a) |
| 9 | 여러 pending 주문을 만들어 개별 confirm하면 중복구매 차단 우회 가능 | confirm-time에도 활성 이용권(다른 주문) 검사 추가 | 〃(b) |
| 10 | 부분취소 판정을 요청값(cancelAmount)만으로 결정 | 공급자 응답의 상태·잔액·누적취소액 기준으로 판정 | 〃(c) |
| 11 | 결제 가능 여부 판정이 월간 예산 완전소진만 봄 | 일일 한도·최소 생성비 부족·라우팅 서비스 불가까지 신규판매 차단 사유로 확장 | 〃(d) |
| 12 | 신규판매 차단 로직이 이미 승인된 결제 복구와 안 분리됨 | 조기 `alreadyProcessed` 반환이 (b)/(d) 검사보다 먼저 오도록 구조적으로 분리 | 〃(e) |
| 13 | `createOrderRoute`가 실패 응답의 status를 200으로 덮어씀 | 실패(`!r.ok`)면 원래 status를 그대로 반환 | 〃(f) |
| 14 | `fetchWithTimeout`이 헤더만 받으면 타이머를 꺼서 본문 읽기 단계가 무보호 | 본문 읽기(`json`/`text`/`arrayBuffer`)도 각각 새 타이머로 보호 | 〃 §8(g) |

---

## 3-2. 이번 7차 갱신에서 고친 문제 목록(ChatGPT 재현 기준)

| # | 지적된 문제 | 고친 내용 | 재현 테스트 |
|---|---|---|---|
| 1 | `/api/places`·`/api/courses`가 전체 삭제 후 재삽입 — 오래된 기기의 저장이 최신 수정을 덮어씀(6차에서 발견만 하고 미해결) | `account_places`/`account_courses`에 `version`/`deleted` 컬럼 추가, trips/visits와 같은 버전 비교+보수적 재병합(`syncPlaces`/`syncCourses`). 삭제는 명시적 `deletedIds`로만(배열 누락으로 추측 삭제 안 함) | `server/test/places-courses-sync.test.mjs`(16개), `scripts/test-sync-protection-screens.mjs` (a) — 이제 실제로 통과 |
| 2 | `daSyncPush`가 일부 응답 실패를 확인 안 하고, `daLogout`이 동기화 완료 보장 없이 로컬 데이터를 삭제 | `daSyncPush`가 4개 채널(places/courses/trips/visits) 응답을 각각 확인해 성공한 채널만 반영, `daLogout`이 로그아웃 전 마지막 동기화를 시도하고 실패 시 사용자 확인을 받음. 계정 전환 중 응답 뒤섞임 방지(세션 epoch), 겹치는 push 응답 순서 보호(push-seq) | `server/test/places-courses-sync.test.mjs`, `scripts/test-sync-protection-screens.mjs` 전체 |
| 3 | 같은 클라이언트 장소 식별자에 검색어만 바꿔 보내면 서로 다른 실제 장소를 무료로 확인받는 우회(무료 한도 1로 재현: 6곳 확인, 사용량 1로만 기록) | "신규 여부"를 클라이언트 문자열이 아니라 공급자가 실제로 돌려준 장소 식별자(real_place_id)로 재판정(예약→호출→확정 2단계). 같은 실제 장소 재사용은 계속 비과금, 다른 클라이언트 id가 같은 실제 장소로 확인돼도 비과금 | `server/test/place-lookup-entitlement-bypass.test.mjs`(16개 — 같은 id+다른 검색어, 다른 id+같은 실제 장소, 동시 성공/실패/중복 요청 전부 재현) |
| 4 | 계정별 하루 비용 한도(500원)가 무료/유료 구분 없이 적용돼, 위치확인 단가(약 44.8원) 기준 11건 만에 소진 — 유료 이용권의 "하루 50곳" 약속이 사실상 불가능 | 이용권 기간 전체 누적 안전상한(무료 700원/유료 3,500원)보다 계정별 일일/월간 한도가 낮게 잡히지 않게 함(`chargeCostBatch`). 짧은 시간창 남용 방지는 여전히 별도(rate-limit.mjs의 횟수 기반 한도)가 맡음 | `server/test/paid-daily-burst-budget.test.mjs`(11개 — 출고 기본값 그대로 유료 고객이 하루에 50곳+코스 1회를 실제로 마침을 확인) |
| 5 | 이용권 잔여는 있는데 내부 원가 안전상한에 걸릴 때 "cost-budget-exceeded"라는 뭉뚱그린 오류만 나감 | "이용권 자신의 원가 상한 도달"(`entitlement-cost-cap-reached`)과 "서비스 전체 운영상 일시 제한"(`cost-budget-exceeded`)을 구분해서 반환 | `server/test/cost-safety-cap.test.mjs` |
| 6 | 착장 판단용 날씨 기능 없음(신규 요청) | "오늘 동선" 화면 상단에 날씨 카드 추가(WeatherAPI.com 무료 등급) — 현재 날씨·오늘 예보(최고/최저/저녁)·시간대별 강수확률/바람·규칙 기반 착장 문구. 로그인 불필요, 이용권/비용 원장 전혀 안 건드림, 지역 단위 캐시 공유(도시 선택마다 새 호출 안 함), 실패 시 마지막 캐시로 정직하게 대체 | `server/test/weather-route.test.mjs`(12개)·`weather-stale-fallback.test.mjs`(6개), `scripts/test-weather-card.mjs`(13개, 실제 Chromium) |

---

## 3-3. 이번 8차 갱신에서 고친 문제 목록(ChatGPT 재현 기준)

| # | 지적된 문제 | 고친 내용 | 재현 테스트 |
|---|---|---|---|
| 1 | `account_places` 동기화가 `incomingVersion >= existing.version`이면 수락 — 같은 원본에서 시작한 두 기기가 동시에 편집(둘 다 "버전+1"을 보냄)하면 뒤에 도착한 기기가 앞 기기의 수정을 조용히 지움(`conflicts`가 빈 배열로 재현됨) | 서버만 새 버전을 발급하고 `baseVersion === existing.version`(정확히 일치)일 때만 수락. 클라이언트는 로컬에서 버전을 임의로 올리지 않고(`_stampPlaceVersions` 재설계), 충돌 시 3-way 재병합(`daRemergePlaceConflict`)으로 양쪽 수정 보존 후 자동 재시도. 같은 내용 재전송은 버전을 안 올림(no-op 감지). 삭제도 `{id, baseVersion}`로 같은 보호 적용, 코스/여행/방문 동기화도 같은 `===` 비교로 통일 | `server/test/sync-conflict-protection.test.mjs`(24개 — 정확 버전 경합, 미래 버전 사칭 거부, no-op 무증분, 삭제vs수정 충돌, 코스/여행/방문 경합), `scripts/test-sync-conflict-devices.mjs`(9개, 실제 Chromium 두 기기 — 동시 다른 필드 편집·수정vs삭제·저장 중 추가 편집) |
| 2 | "같은 로컬 슬롯+같은 검색 지문"이면 빠른 경로로 곧바로 "신규 아님" 처리 — 실제로 돌아온 장소가 바뀌었는지 전혀 대조 안 함(무료 한도 1로 재현: actual-A 확인 후 같은 조건의 다음 결과가 actual-B로 바뀌어도 링크만 바뀌고 사용량은 그대로 1) | 빠른 경로라도 실제 반환 `placeId`를 매번 대조 — 바뀌었으면 신규 판정을 처음부터 다시 거침(한도 없으면 성공 처리 안 함). 한도가 다 찬 상태에서도 reserve가 곧바로 거절 안 하고 finalize까지 판정을 미뤄 "다른 로컬 id+같은 실제 장소" 비과금 재사용이 한도와 무관하게 여전히 성공. `finalizePlaceLookupResult`가 이제 `{ok, reason}`을 반환해 이미 성공한 외부 호출도 한도초과로 뒤집어 402 응답 가능. 잠정 예약이 프로세스 종료로 유실돼 영구 소비되던 문제도 `entitlement_place_reservations` 표(만료 회수 패턴)로 고침 | `server/test/place-lookup-fast-path.test.mjs`(12개, 재현 조건 그대로), `server/test/place-lookup-reservation-recovery.test.mjs`(17개, 프로세스 종료 시뮬레이션) |
| 3 | `server/adapters/weather.mjs`가 공급자의 `last_updated`·`hour.time`(시간대 표기 없는 "현지 시각" 문자열)을 `new Date()`로 그대로 파싱 — 서버가 UTC로 돌면 일본 현지 12:00이 "12:00Z"로 잘못 해석돼 화면에서 21:00으로 표시(재현 확인) | epoch 필드(`last_updated_epoch`·`hour.time_epoch`·`location.localtime_epoch`)만으로 절대 시각 생성, "오늘인지"·"지금 몇 시인지"도 목적지 `tz_id`로 재지역화. 사용자가 고른 여행 날짜의 예보와 오늘의 현재값을 서버가 분리해 내려주고, 공급자가 보장하는 3일 밖 날짜는 정직하게 범위 밖 표시. 위경도 범위 검증과 동일 지역 동시요청 병합 추가 | `server/test/weather-timezone.test.mjs`(16개 — 도쿄·방콕·뉴욕·현지 자정 경계·날짜 커버리지·동시요청 병합, `globalThis.fetch` 모의로 실제 파싱 로직 실행) |
| 4 | 현지 거리·옷차림 영상 기능 없음(이미 요청됐던 것, 이번엔 범위 제한해 신규 구현) | 날씨 카드 아래 버튼 → 클릭 시에만 공식 유튜브 임베드 플레이어 로드(자동재생 금지, 닫으면 정지), 촬영 장소·채널·현지 시간·데이터 사용 안내 표시, "현지인" 단정 안 함, LIVE 자체 단정 안 함, 임베드 거부·방송 종료는 `onError`로 감지해 원본 링크로 대체, 서버 저장·중계 없음, 검증된 영상 없는 도시는 버튼 숨김 | `scripts/test-street-video.mjs`(22개, 실제 Chromium — **이 세션이 직접 주입한 합성 픽스처로 구조만 검증. `STREET_VIDEOS`는 빈 표로 배포돼 실제 영상은 아직 하나도 등록되지 않았다 — 사람이 방송을 직접 확인해 등록해야 하는 일이 남아 있다**) |

---

## 4. 알려진 개선 여지(출시를 막지는 않지만 남겨 둔 것)

- **부분 환불 정책이 아직 없다** — `docs/BUSINESS_DECISIONS.md` 5-0절에
  별도로 보고했다. 정책이 정해지기 전까지 소비자 화면에 부분 취소
  기능을 노출하지 않는다.
- 비용 SKU 단가(`COST_*_KRW_MICROS`)와 예산 한도는 전부 **학습 기억
  기준 추정치**다 — 실제 계약 단가로 반드시 갱신해야 한다
  (`docs/BUSINESS_DECISIONS.md` 3절).
- Routes 경유지 상한(25개)·고요금 임계값(11개)은 ChatGPT가 확인한
  값을 그대로 코드에 반영한 것으로, 이 세션이 공식 문서로 재확인한
  게 아니다 — 실제 값과 다르면 `ROUTES_MAX_INTERMEDIATES_PER_CALL`/
  `ROUTES_HIGH_VOLUME_THRESHOLD` 환경변수만 바꾸면 된다.
- 장소 조회의 "동명 장소 판별"은 지역 힌트(주소 문자열 포함 여부)
  기준의 단순 매칭이다 — 실제 서비스에서 오판별이 잦으면 더 정교한
  판별(도시 좌표 반경 등)이 필요할 수 있다.
- 재조회 사용 패턴(월 몇 %) 가정은 여전히 임의값이다 — 체험단 운영
  중 관찰 필요.
- **(해결됨, 6차)** ~~재방문 여행자 지원의 화면 연결이 아직 안
  됐다~~ — 6차에서 `src/design/spots.js`에 전부 연결했다(7절 참고).
  다만 코스 생성 요청에 `tripId`가 없을 때 예전처럼
  계정+도시+날짜 구조(`account_courses`)로 저장되는 하위 호환 경로는
  의도적으로 그대로 남겨 뒀다(마이그레이션 이전 기존 데이터·
  `tripId`를 안 보내는 외부 호출 대비).
- **(해결됨, 7차)** ~~`/api/places` 전체치환 동기화에 버전 보호가
  없다(6차 신규 발견)~~ — 7차에서 `account_places`/`account_courses`
  에 `version`/`deleted` 컬럼을 추가하고 trips/visits와 같은 버전
  비교+보수적 재병합(`server/routes/account-data.mjs`의
  `syncPlaces`/`syncCourses`)을 적용했다. 삭제는 명시적 `deletedIds`
  로만 이뤄지고, 이미 지워진 장소는 오래된 기기가 다시 들고 나타나도
  안 되살아난다. `scripts/test-sync-protection-screens.mjs` (a)가
  이제 실제로 통과한다(6차엔 여기서 의도적으로 FAIL로 남겼었다).
- **방문 기록 동기화의 충돌 병합 규칙은 이번에 새로 설계한 것**이라
  (버전 비교 + 날짜는 합집합·무덤표시, 단일 값은 최종 수정시각 기준)
  실사용 트래픽에서 검증된 적은 없다 — 지정된 5개 시나리오는 전부
  재현·통과했지만, 실제로 여러 기기를 오래 쓰는 사용자가 늘면 더
  다양한 충돌 패턴이 나올 수 있다.
- **여행 삭제 API가 없다** — 잘못 만든 여행을 지우는 기능은 이번
  범위에 포함하지 않았다(사용자 지시에 삭제 요구가 없었고, "기존
  기록을 절대 지우지 않는다"는 지시와 충돌 소지를 줄이기 위해 의도적
  으로 생략). 필요해지면 별도로 논의해야 한다.
- 기존 city+date 코스 마이그레이션(`schema_migrations`)은 **딱 한 번만
  실행**된다 — 이미 마이그레이션이 끝난 뒤에 생기는 계정 데이터는
  건드리지 않는다(정상 동작이지만, 운영 DB에 처음 배포할 때 반드시
  이 마이그레이션이 실제로 한 번 실행되는지 로그로 확인해야 한다).

---

## 5. 검증한 테스트 결과 (이번 세션에 다시 실행해 직접 확인)

```
node server/test/server.test.mjs                          # 전체 통과
node server/test/config.test.mjs                           # 18개 — 전체 통과
node server/test/server-v2.test.mjs                         # 24개 — 전체 통과(4차: phase 무력화, 배치 엔드포인트 한도 검증 추가)
node server/test/generation-trial-charging-success.test.mjs # 전체 통과
node server/test/generation-trial-charging-failure.test.mjs # 전체 통과
node server/test/production-boot.test.mjs                   # 8개 — 전체 통과
node server/test/provider-contracts.test.mjs                # 39개 — 전체 통과(4차: Places API(New) 계약 검증 12개 추가)
node server/test/reliability-and-cost.test.mjs              # 2 시나리오(routing-missing/routing-available) 합계 60여개 — 전체 통과(5차: 결제·타임아웃 경계 6건 + 캐시 재현 테스트 추가, 시나리오 분리로 재구성)
node server/test/routes-waypoint-limits.test.mjs            # 12개 — 전체 통과(4차 신규 — 경유지 분할·고요금 SKU)
node server/test/cost-budget-allornothing.test.mjs          # 5개(2 시나리오) — 전체 통과(5차: insufficient/sufficient 시나리오 분리 재작성)
node server/test/trips-and-visits.test.mjs                  # 21개 — 전체 통과(5차 신규 — 여행 분리·방문 기록·마이그레이션·무료경계)
node server/test/next-trip-suggestions.test.mjs              # 10개 — 전체 통과(5차 신규 — 미방문우선·다시가고싶음·이월·명시적선택)
node server/test/trips-visits-sync.test.mjs                  # 17개 — 전체 통과(5차 신규 — 지정된 동기화 충돌 시나리오 5건)
node server/test/entitlement-usage.test.mjs                  # 14개 — 전체 통과(6차 신규 — 위치확인 한도·재사용 미차감·실패 미차감)
node server/test/entitlement-course-limit.test.mjs           # 6개 — 전체 통과(6차 신규 — 유료 코스 생성 한도·멱등 재생성 미중복차감)
node server/test/cost-safety-cap.test.mjs                    # 3개 — 전체 통과(6차 신규 — 내부 원가 안전상한 실제 차단)
node server/test/new-sale-committed-budget.test.mjs          # 3개 — 전체 통과(6차 신규 — 기존 유료고객 약속 잔여몫 반영)
node server/test/entitlement-period-month-boundary.test.mjs  # 8개 — 전체 통과(6차 신규 — 30일 이용권 달력월 경계 면역)
node server/test/places-courses-sync.test.mjs                # 16개 — 전체 통과(7차 신규 — 버전 충돌 거부·삭제 무덤 비부활·필드 보존·코스 버전 보호)
node server/test/place-lookup-entitlement-bypass.test.mjs    # 16개 — 전체 통과(7차 신규 — 같은id+다른검색어/다른id+같은실제장소/동시요청 3가지 재현 조건)
node server/test/paid-daily-burst-budget.test.mjs            # 11개 — 전체 통과(7차 신규 — 출고 기본값으로 유료고객 하루 50곳+코스1회 실제 완료)
node server/test/weather-route.test.mjs                      # 12개 — 전체 통과(7차 신규 — 로그인 불필요·이용권 미차감·지역 캐시 공유·좌표 검증)
node server/test/weather-stale-fallback.test.mjs             # 6개 — 전체 통과(7차 신규 — 공급자 실패 시 캐시 대체)
node server/test/sync-conflict-protection.test.mjs           # 24개 — 전체 통과(8차 신규 — baseVersion 정확 일치, 미래버전 사칭 거부, no-op 무증분, 삭제vs수정 충돌, 코스/여행/방문 경합)
node server/test/place-lookup-fast-path.test.mjs             # 12개 — 전체 통과(8차 신규 — 빠른경로 실제 placeId 재대조, 한도초과 지연판정)
node server/test/place-lookup-reservation-recovery.test.mjs  # 17개 — 전체 통과(8차 신규 — 잠정예약 프로세스 종료 복구, 이중해제 방지)
node server/test/weather-timezone.test.mjs                   # 16개 — 전체 통과(8차 신규 — 도쿄/방콕/뉴욕/현지자정경계/날짜커버리지/동시요청병합, epoch 기반 파싱 실제 실행)
node scripts/test/run-all.mjs               # t1~t49, 개인용+판매용 양쪽 — 전체 통과
node scripts/design-integration-check.mjs   # 전체 통과
node scripts/test-storage-migration.mjs     # 전체 통과
node scripts/test-zip-import.mjs            # 전체 통과
node scripts/test-course-generation.mjs     # 3가지 시나리오 합계 24개 — 전체 통과
node scripts/test-purchase-flow.mjs         # 27개 — 전체 통과
node scripts/test-multi-day.mjs             # 28개 — 전체 통과
node scripts/test-place-lookup.mjs          # 11개 — 전체 통과(Places API(New) 응답 형식 반영 확인)
node scripts/test-account-sync.mjs          # 12개 — 전체 통과
node scripts/test-revisit-flow.mjs           # 23개 — 전체 통과(6차 신규 — 여행 목록/전환·새 여행·방문 버튼/필터·이월후보·다른 기기 로그인 동기화, 실제 Chromium 화면)
node scripts/test-sync-protection-screens.mjs # 16개 — 전체 통과(6차 신규, 7차: (a)도 실제로 고쳐져 이제 16/16 전부 통과 — 6차엔 (a)만 의도된 실패였다)
node scripts/test-consumer-flow-e2e.mjs      # 17개 — 전체 통과(6차 신규 — 실제 CSV 파일 300곳 가져오기→배치 위치확인→첫 코스→여행 저장→방문 표시→같은 도시 다음 여행→미방문 우선 코스→이용권 잔여횟수까지 한 번에 이어서 확인, 300곳 가져오기 시 비용 원장 0건도 실제 파일 입력으로 재확인)
node scripts/test-landing-page.mjs          # 전체 통과
node scripts/test-weather-card.mjs          # 13개 — 전체 통과(7차 신규 — 실제 Chromium: 비회원도 날씨 확인, 현재/예보 라벨 구분, 이용량 미차감, 모바일 스크린샷)
node scripts/test-sync-conflict-devices.mjs # 9개 — 전체 통과(8차 신규 — 실제 Chromium 두 기기: 동시 다른 필드 편집 3-way 재병합·수정vs삭제 충돌·저장 중 추가 편집 보존)
node scripts/test-street-video.mjs          # 27개 — 전체 통과(8차 신규, 9차 갱신 — 로드 실패(onerror)·타임아웃·낡은 콜백 정리 3건 추가 검증)
node server/test/place-lookup-reservation-idempotency.test.mjs  # 17개 — 전체 통과(9차 신규 — 이중확정·스윕후지연응답 실제 재현)
node server/test/entitlement-overlimit-verify-cap.test.mjs      # 9개 — 전체 통과(9차 신규 — 한도초과 후 검증 시도 일일 상한)
node server/test/weather-merge-cap.test.mjs                     # 4개 — 전체 통과(9차 신규 — 병합요청 호출상한 이중소비 재현·수정)
node scripts/test-weather-outfit-note-date-scope.mjs            # 7개 — 전체 통과(9차 신규 — 착장문구 날짜혼선 재현·수정)
node server/test/affiliates.test.mjs                            # 14개 — 전체 통과(9차 신규 — 최소 제휴 준비 서버측)
node scripts/test-affiliates.mjs                                # 15개 — 전체 통과(9차 신규 — 최소 제휴 준비 실브라우저)
node scripts/test-sort-and-metadata.mjs                         # 22개 — 전체 통과(9차 신규 — 정렬+메타데이터 분리)
node scripts/test-tags-and-category.mjs                         # 17개 — 전체 통과(9차 신규 — 세계 공통 상위분류+세부 다중 태그)
node scripts/test-test-location-mode.mjs                        # 14개 — 전체 통과(9차 신규 — 테스트 위치 모드)
node server/test/invite-codes.test.mjs                          # 15개 — 전체 통과(9차 신규 — 초대 코드 게이트가 켜졌을 때의 동작)
node server/test/feedback.test.mjs                              # 20개 — 전체 통과(9차 신규 — 불편함 보내기·설문·관리자 API)
node server/test/admin-not-configured.test.mjs                  # 3개 — 전체 통과(9차 신규 — ADMIN_TOKEN 미설정 시 501 안전장치)
node scripts/test-feedback-and-survey-ui.mjs                    # 16개 — 전체 통과(9차 신규 — 불편함 보내기·설문 실브라우저 + 카드 제거 순서 버그 실제 재현·수정)
node scripts/audit.mjs                      # 개인정보·하드코딩 키 잔존 검사 — 전체 통과
node scripts/verify.mjs                     # 보호 블록·저장 키 무결성 — 전체 통과
```

**우선순위 지시("전체 회귀 재실행보다 재현된 문제·실제 사용자 흐름
검증을 우선하라")에 따라**, 이번 세션은 ChatGPT가 지적한 19가지
문제(3절 표) 각각을 실제 코드로 재현하는 전용 테스트부터 작성해
통과시켰고, 그 다음 전체 회귀(위 목록)를 통째로 돌려 다른 회귀가
없는지 확인했다. `server/test/provider-contracts.test.mjs`처럼
`globalThis.fetch`만 가로채는 테스트도 요청 생성 코드(URL·헤더·바디
형태, 위조 방지 검사)는 실제로 실행된다 — ②로 표시한 항목이 가짜
테스트라는 뜻이 아니다.

**8차도 같은 원칙**: 3-3절의 4가지 결함을 먼저 재현 테스트로
확인(수정 전 코드에 돌려 실제로 실패하는 것까지 확인)한 뒤 고쳤고,
마지막에 서버 테스트 27개 파일 + e2e 스크립트 15개 파일 전체를 한
번 더 통째로 돌려 다른 회귀가 없는지 확인했다(전부 전체 통과). 현지
거리·옷차림 영상은 실제 방송 존재·임베드 가능 여부를 검증할 방법이
없어 이 세션이 직접 주입한 합성 픽스처로만 구조를 검증했다는 점을
다시 한 번 명시한다 — **"실제 키만 넣으면 완료"가 아니라 "실제 영상
목록을 사람이 직접 확인해 채워 넣어야 기능이 실제로 나타난다."**

## 6. 화면 캡처(합성 데이터)

`src/design/assets/marketing/1-collection.png`, `2-course.png` —
실제 앱 화면을 Playwright로 캡처한 것이며, 담긴 장소·사진은 전부 이
저장소에 이미 있던 샘플/디자인 예시 자산이다(실제 개인정보 없음).
`2-course.png`는 실제 키 연결이 막혀 있어(2절 참고) 성공 응답을
흉내 낸 장면이라는 점을 `src/design/landing.html`에 그대로 캡션으로
밝혀 뒀다 — 4차 갱신에서도 이 캡션 원칙은 그대로 유지한다.

**6차 신규 — 이번에 새로 화면에 연결한 것들만 `docs/screenshots/`에
따로 캡처했다**(`scripts/shot-r6-flows.mjs`, 전부 지어낸 이름·이메일만
쓴 합성 데이터 — 실제 장소명·개인정보 없음). 7장:
`after_방문표시_장소상세.png`, `after_방문상태필터_목록.png`,
`after_새여행만들기.png`, `after_여행선택.png`, `after_이월후보.png`,
`after_이용권_포함사용량.png`, `after_프로필_잔여횟수.png` — 방문
버튼·방문 상태 필터·새 여행 만들기·여행 전환·이월 후보·이용권 포함
사용량·계정 잔여 횟수가 실제 서버 응답을 반영해 화면에 표시되는
모습을 담았다. **이 스크린샷은 화면 자체가 실제 데이터로 정상
그려진다는 것만 보여준다 — 실제 iPhone Safari에서의 표시나 실제
공급자(Toss/Resend/Google) 연결을 검증하는 게 아니다**(2절과 동일한
구분 원칙).

**7차 신규 — 착장 판단용 날씨 카드**: `docs/screenshots/after_날씨카드_오늘동선.png`
(`scripts/test-weather-card.mjs`가 검증과 함께 캡처, 가상 지명·가상
장소만 사용 — 실제 개인정보 없음). "오늘 동선" 화면 상단에 현재
날씨·오늘 예보·시간대별 강수확률/바람·규칙 기반 착장 문구가 표시되고,
카드 하단에 "테스트 데이터(예시) · 실제 공급자 연결 전"이라고 스스로
밝히는 모습까지 그대로 담겼다(가짜 데이터를 진짜처럼 감추지 않음).
**이 스크린샷도 화면 자체가 정상 그려진다는 것만 보여준다 — 실제
WeatherAPI.com 연결이나 실제 iPhone Safari 표시를 검증하는 게
아니다.**

**8차 신규 — 현지 거리·옷차림 영상**: `docs/screenshots/after_현지거리영상_합성데이터.png`
(`scripts/test-street-video.mjs`가 검증과 함께 캡처). 날씨 카드
아래에 버튼이 뜨고, 클릭하면 패널이 열려 촬영 장소·제공 채널·현지
시간·"영상 시청 시 데이터가 사용돼요" 안내가 표시되는 구조를 담았다.
**이 스크린샷의 영상 자리(검은 박스)는 실제 방송이 아니다** — 이
테스트가 직접 주입한 합성 픽스처(`(합성) 예시 채널`처럼 이름 자체에
표시)이고, 실제 유튜브 네트워크 호출은 테스트에서 의도적으로 막아
뒀다. `STREET_VIDEOS`가 빈 표로 배포되므로 지금 실제 화면에서는
이 버튼 자체가 어떤 도시에서도 보이지 않는다 — 이 스크린샷은 "실제
영상을 등록하면 이런 구조로 보인다"는 것만 보여준다.

---

## 7. 재방문 여행자 화면 연결 — 6차에서 완료

5차에서 서버(스키마·API·마이그레이션·동기화)만 끝내고 ⑤(화면
미연결)로 남겨 뒀던 5가지를 이번 6차에서 `src/design/spots.js`에 전부
연결했다. 새 백엔드 설계 없이 기존 서버 API를 그대로 부르는 화면
배선·문구 작업이었다:

1. **여행 목록·전환 화면 — 완료.** `/api/trips` 목록을 `tripPickerSheet`
   로 보여주고, 같은 도시에 여행이 2개 이상일 때만 카드로 구분해
   고를 수 있게 했다(여행이 하나뿐이면 예전 화면과 동일). "오늘
   동선"·"오늘의 코스" 화면 상단에 지금 여행 이름을 표시한다
   (`tripBlockHTML`).
2. **새 여행 만들기 흐름 — 완료.** `newTripFormSheet`가 이름·시작일·
   종료일·숙소를 선택 입력으로 물어보고 `POST /api/trips`를 부른다.
   "도시 바꾸기"(장소 필터용 `chooseCity`)와는 완전히 분리된 별도
   버튼이라 오해될 소지가 없다.
3. **방문 표시 버튼 — 완료.** 장소 상세(`detail()`)에 "오늘 날짜로
   방문 완료 표시"·"마지막 방문 취소"·"다시 가고 싶어요" 버튼을
   추가했다(`visitBlockHTML`/`visitAction`). 코스 담기(`selected`)와
   완전히 분리된 상태값이라 자동 방문처리가 안 된다. 방문 기록이 하나
   라도 생기면 목록 화면에 방문 상태 필터(전체/미방문/방문함/
   다시가고싶음)가 나타난다.
4. **"다음 여행 코스 만들기" 진입점 — 완료.** 새 화면을 따로 안 만들고
   기존 "오늘 동선" 화면 안에 `carryForwardSheet`로 이월 후보 목록만
   얹었다(지시대로 "첫 화면 설정을 늘리지 않음"). 같은 도시에 다른
   여행이 있고 동선이 비어 있을 때만 진입점이 뜬다.
5. **로그인 시 동기화 전환 — 완료.** `daSyncPush`가 이제
   `/api/trips/sync`·`/api/visits/sync`를 로그인 직후와 매 로컬 저장
   때마다 실제로 부른다(예전엔 클라이언트가 이 엔드포인트를 아예 안
   불렀다). `/api/places`·`/api/courses` 전체치환 PUT은 `tripId`가
   없는 레거시 코스만 계속 담당하도록 좁혀서, trip에 딸린 코스가 그
   경로로 새어 나가 버전 보호 없이 덮어써지는 일을 막았다.

전부 `scripts/test-revisit-flow.mjs`(23개, 실제 Chromium 화면)로
검증했다. 남은 것은 4절에 적은 **`/api/places` 자체의 버전 보호
부재**(다음 라운드 후보)뿐이다.
