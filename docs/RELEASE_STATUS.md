# 출시 상태 (RELEASE_STATUS)

작성: 2026-09-10(1차) · 갱신: 2026-09-10(2차 — 확정 상품 반영) ·
갱신: 2026-09-10(3차 — 결제/이메일/경로 공급자 확정, 서버 집행 구조
재설계 반영) · 브랜치 `design-integration`

**3차 갱신 배경**: 사용자가 2차 갱신 결과물을 직접 테스트한 뒤
"무료체험이 클라이언트에서 계산되고 서버는 뒤늦게 통보만 받는 구조라
동시 요청으로 우회 가능하다"·"운영에서 테스트 기능이 안 막힌다"·
"장소 조회가 로그인·한도 없이 열려 있다" 등 구체적 문제를 지적하며
반려했다. 이 문서는 그 지적에 대한 실제 코드 수정 결과를 정리한다.
**사용자의 완료 기준을 그대로 따른다: 계획·미구현 함수·자체 모의
결제만으로 "구현 완료"라고 적지 않는다.** 아래 분류 중 "④ 사용자
설정 필요"로 표시된 항목은 이 세션이 실제 키로 검증하지 못했다는
뜻이지, 코드가 없다는 뜻이 아니다 — 코드 유무와 실제 검증 여부를
분리해서 적는다.

- **①코드 완료** — 동작에 필요한 코드가 전부 작성됐고, 외부 서비스가
  없거나(이 앱 자체가 서버·DB를 직접 가짐) 실제 HTTP 요청으로 검증까지
  끝난 기능.
- **②모의 검증** — 실제 코드 경로(요청 생성 → 처리 → 응답 반영)는
  전부 진짜고, 응답을 주는 쪽만 가짜(테스트 어댑터, 자체 서명 웹훅,
  `page.route()` 모의, `fetch` 모의 등)로 검증.
- **③실제 연결 검증** — 실제 키·실제 네트워크로 외부 서비스에 요청을
  보내 성공 응답을 실제로 받아봄.
- **④사용자 설정 필요** — 코드는 있지만 실제 키가 없거나(이 세션은
  발급받은 적 없음), 이 세션의 네트워크 제약(EGRESS_BLOCKED)으로
  공식 문서·실제 응답을 확인하지 못해 사용자가 직접 키를 넣고
  처음 검증해야 하는 항목.

이번 3차 갱신에서 가장 중요한 사실: **① 코드 완료는 늘었지만, ③ 실제
연결 검증은 이번에도 하나도 늘지 않았다** — 이 세션 내내
`docs.tosspayments.com`, `resend.com`, `developers.google.com`,
`mapsplatform.google.com` 전부 접속이 막혀 있었다(EGRESS_BLOCKED,
아래 3절에서 매번 명시). 세 공급자 모두 학습 시점 기억으로 코드를
작성했으므로 **실제 스펙과 다를 가능성을 열어 두고, 실제 키를 넣는
순간 다시 검증해야 한다.**

---

## 1. 기능별 상태

| 기능 | 상태 | 근거 |
|---|---|---|
| Google Takeout ZIP/CSV/JSON 가져오기 | **①** | `scripts/test-zip-import.mjs` 18개 |
| 재가져오기 중복 방지, 사용자 수정(유형·도시) 보존 | **①** | `scripts/design-integration-check.mjs`, `scripts/test/t49.mjs` |
| 도시별 컬렉션·검색·수동 정리 | **①** | `scripts/design-integration-check.mjs` |
| **장소 조회 — 인증 필수 + 초기가져오기/재조회 분리 한도** | **①**(인증·한도 분리 코드, 실제 HTTP로 401/429 재현) + **②**(테스트 어댑터로 조회 흐름 검증) | `server/test/server-v2.test.mjs`, `scripts/test-place-lookup.mjs` 11개(로그인 게이트 추가) |
| 불확실한 후보 확인(사람이 "맞아요"를 눌러야 반영) | **①** | 위와 동일 |
| **장소 조회 — 실제 Google Places 연결** | **④** | `server/adapters/place-lookup.mjs`의 `googleAdapter`는 실제 호출 코드가 있으나 `mapsplatform.google.com` 접속이 막혀 문서 재확인도, 실 키 호출도 못 했다 |
| **개인화 코스 생성 — 서버 집행(인증·멱등성·동시성 잠금·레이트리밋·실패시 미차감)** | **①** | `server/test/server-v2.test.mjs`(멱등성·잠금·레이트리밋), `server/test/generation-trial-charging-success.test.mjs`/`-failure.test.mjs`(성공만 차감), 전부 실제 HTTP 요청·실제 DB 행 조작으로 재현 |
| **도보 경로 계산 — Google Routes(WALK) 어댑터** | **①**(코드, 최근접 이웃 로컬 정렬 + 단일 API 호출 설계) + **②**(계약 테스트로 요청 형태 검증) | `server/test/provider-contracts.test.mjs`, `scripts/test-course-generation.mjs` 21개. **구 OSRM 방식은 완전히 폐기했다**(`/foot/` URL·평균속도 검사만으로는 실제 도보 경로를 보장하지 못한다는 지적 반영) |
| **도보 경로 — 실제 Google Routes 연결** | **④** | `developers.google.com` 접속이 막혀 공식 스펙 재확인도, 실 키로 성공 응답을 받아보지도 못했다 — 요청 형태(필드마스크·WALK 모드·`optimizeWaypointOrder:false`)는 계약 테스트로만 검증 |
| 가용 시간·출발 시각 반영, 시간 초과 시 안내 | **①** | `scripts/test-course-generation.mjs` |
| 도시별 코스 분리, 여러 날짜 일정 | **①** | `scripts/test-multi-day.mjs` 26개 |
| 새 코스 생성·저장 실패 시 기존 코스 보존 | **①** | `scripts/test-course-generation.mjs`, `scripts/test-purchase-flow.mjs` |
| **이메일 로그인 — 쿨다운·IP 레이트리밋·연속실패 잠금** | **①** | `server/test/server-v2.test.mjs` |
| **이메일 로그인 — 실제 Resend 발송** | **①**(코드) + **②**(계약 테스트로 요청 형태 검증) + **④**(실제 발송 미검증) | `server/test/provider-contracts.test.mjs` — `server/adapters/email.mjs`가 이제 스텁이 아니라 실제로 `POST api.resend.com/emails`를 호출하는 코드다. 단 `resend.com` 접속이 막혀 실제 키로 진짜 메일이 도착하는지는 확인 못 함 |
| 로그인 후 기존 장소·진행 중 코스 유지, 로그인 필수 여부 변경(첫 코스도 로그인 필요) | **①** | `scripts/test-purchase-flow.mjs` |
| **계정별 서버 저장 — 장소 보관함·날짜별 일정 동기화·병합·로그아웃 격리** | **①** | `scripts/test-account-sync.mjs`(신규) — 손님 데이터 보존, 다른 기기 데이터 병합, 로그아웃 시 로컬 삭제, 계정 전환 시 데이터 미노출, 재로그인 시 복원까지 실제 브라우저로 종단 검증 |
| **결제 승인 흐름 — 서버 주문 생성 → 서버가 금액/소유자 재확인 → 승인** | **①**(코드, 클라이언트가 준 금액을 믿지 않는 구조 검증) + **②**(계약 테스트로 요청 형태·위조 방지 검증) | `server/test/provider-contracts.test.mjs`(토스 승인 요청 형태, 금액 불일치·계정 불일치 거부) |
| **결제 — 실제 토스페이먼츠 연결(결제창·승인 API)** | **④** | `docs.tosspayments.com` 접속이 막혀 실제 스펙(인증 방식·필드명)을 재확인 못 했다. 클라이언트의 결제위젯 SDK 로드·`requestPayment` 호출 코드는 작성했으나 이 샌드박스는 실제 결제창을 띄워볼 수 없다(`js.tosspayments.com` 등 외부 스크립트 도메인도 막혀 있을 가능성이 높음) |
| 결제 취소·환불·만료에 따른 권한 회수 | **①**(코드) + **②**(시뮬레이션으로 검증) | `scripts/test-purchase-flow.mjs`. 실제 PG 연동 전까지는 ③ 불가 |
| 결제 실패 후 작업 화면 복귀, 중복 클릭 방지(로딩 상태) | **①** | `scripts/test-purchase-flow.mjs`, `src/design/spots.js`의 `disableStartButtons`/결제 버튼 로딩 처리 |
| **운영(production) 환경 — 테스트 기능 완전 차단** | **①** | `server/test/production-boot.test.mjs` 8개 — 결제·이메일 필수 시크릿 없으면 실제 자식 프로세스가 종료코드 1로 부팅 거부(재현 확인), 장소조회·경로는 부팅은 막지 않되 정직하게 unavailable, 개발용 결제 시뮬레이션 라우트는 production에서 아예 등록 안 됨(코드 자체 확인) |
| "키 있음"과 "실제 연결 확인됨" 구분 표시 | **①** | `server/status.mjs`(`markVerified`/`getVerifiedStatus`), `/api/health`의 `services` vs `verified` 필드 분리 |
| 서비스별 독립 연결 상태(장소조회/결제/이메일/경로 개별 판정) | **①** | `server/test/config.test.mjs` 18개(결제는 시크릿+클라이언트 키 둘 다 있어야 real — 반쪽 설정 방지 포함) |
| 측정 이벤트(유입~구매 퍼널) | **①** | `server/test/server.test.mjs` |
| 한글/가나 완성형 폰트, 전송량 최적화 | **①** | `scripts/test-font-coverage.mjs` |
| cp1_→cs1_ 저장소 마이그레이션 | **①** | `scripts/test-storage-migration.mjs` |
| 소개 페이지 + 사전 신청 | **①** | `scripts/test-landing-page.mjs` 11개 |

**요약**: 이 앱 자체의 로직(가져오기·정리·코스 생성 서버 집행·계정별
서버 동기화·결제 권한 회수·측정·운영환경 테스트기능 차단)은 전부
**① 수준까지 실제로 구현·검증됐다.** 3차 갱신에서 새로 생긴 진짜
차이는 "④였던 항목 중 무엇이 ①/②로 올라왔는가"다 — 장소 조회·경로·
이메일·결제 **전부 실제로 그 API를 호출하는 코드가 새로 작성됐고
계약 테스트까지 통과했다**(이전에는 이메일은 스텁, 결제는 체크아웃
코드 자체가 없었다). 다만 **네 공급자 모두 실제 키로 검증된 적은
아직 한 번도 없다** — 이 세션의 네트워크 제약 때문이며, 다음
누군가가 실제 키를 넣는 순간이 첫 번째 실제 검증이 된다(2절 참고).

---

## 2. 이번 세션에서 못 하는 검증 — 사용자가 직접 확인할 최소 절차

### 2-1. 실제 키로 첫 연결 확인(신규 — 가장 중요)

- **상태**: Resend/토스페이먼츠/Google Places+Routes 네 서비스
  모두 실제 키로 검증된 적이 없다. 이 세션은 네 공식 문서 사이트
  전부(`resend.com`, `docs.tosspayments.com`, `mapsplatform.google.com`,
  `developers.google.com`) 접속이 막혀 있었다(EGRESS_BLOCKED) —
  코드는 학습 시점 기억으로 작성했다.
- **확인 절차**: `docs/BUSINESS_DECISIONS.md` 6절의 표대로 키를
  하나씩 넣어 가며 `/api/health`의 `services`/`verified` 필드와
  실제 화면 동작(로그인 메일 도착, 결제창 노출, 실제 경로 표시,
  실제 위치 후보 표시)을 확인한다.
- **기대 결과와 실패 시 대응**: 넷 중 하나라도 실제 스펙이 이번에
  작성한 코드와 다르면(예: 토스 웹훅 필드명, Resend 응답 형식,
  Google Routes 응답 구조) 해당 어댑터 파일(`server/adapters/*.mjs`)
  만 고치면 되도록 미리 그 경계에서 분리해 뒀다 — 코스 생성·결제
  권한·레이트리밋 같은 핵심 로직은 안 건드려도 된다.

### 2-2. 실제 Google Takeout 데이터

- **상태**: 179건 실사용 데이터셋이 이 샌드박스에 없어 재실행하지
  못했다.
- **확인 절차**: 본인 구글 계정의 Takeout에서 저장 목록을 다시
  내보내 가져오기에서 그대로 선택 → 결과 화면의 숫자가 실제와 대체로
  맞는지, 다른 서비스 파일이 섞여도 걸러지는지 확인.

### 2-3. 모바일 Safari(iOS)

- **상태**: 실제 iPhone·Safari 미검증(자동화 테스트는 전부 데스크톱
  Chromium 기준).
- **확인 절차**: 파일 선택·가져오기, GPS 출발지 권한, 로그인 코드
  숫자 키패드, 시트 열림 시 배경 스크롤 방지, 그리고 **이번에 새로
  생긴 토스 결제위젯이 iOS Safari에서 실제로 뜨는지**를 실기기로
  확인.

### 2-4. 느린 네트워크

- **상태**: 폰트 로딩만 느린 네트워크로 검증했다
  (`scripts/test-font-coverage.mjs`). 로그인·결제·코스 생성 전체
  흐름은 느린 네트워크 조건에서 검증하지 않았다.
- **확인 절차**: "Slow 3G"에서 로그인 코드 요청 → 결제 → 코스 생성을
  눌러 보며 중복 요청 여부·진행 안내 여부 확인(이번에 로딩 상태·
  버튼 비활성화 처리를 추가했다 — `disableStartButtons`, 결제 버튼
  `disabled` 처리).

---

## 3. 출시 차단 항목이었던 것 중 이번에 해소된 것 / 남은 것

**해소됨(2차 갱신 시점에는 1순위 차단 항목이었던 것)**:
1. ~~이메일 발송 어댑터가 스텁~~ → Resend 실제 호출 코드 작성 완료(④만 남음).
2. ~~결제 체크아웃 시작 코드 자체가 없음~~ → 토스페이먼츠 주문 생성·승인·웹훅 재조회 코드 작성 완료(④만 남음).
3. ~~도보 경로가 실 서비스에 못 쓰는 공개 OSRM 데모~~ → Google Routes(WALK) 어댑터로 전환 완료(④만 남음).
4. ~~장소 조회가 로그인·한도 없이 열려 있음~~ → 인증 필수 + 초기가져오기/재조회 분리 한도로 해결(①).
5. ~~무료체험이 클라이언트에서 판정돼 동시요청으로 우회 가능~~ → 서버가 인증→잠금→레이트리밋→비용발생 전 게이트→실행→저장까지 전부 집행(①).
6. ~~운영에서도 테스트 기능이 안 막힘~~ → `assertBootReady` + 개발용 라우트 미등록으로 해결(①).

**남은 것(전부 "④ 사용자 설정 필요" — 코드는 있고, 실제 키만 있으면
됨)**:
1. Resend 실제 키로 첫 이메일 발송 확인.
2. 토스페이먼츠 실제 클라이언트 키·시크릿으로 결제창·승인 확인,
   실제 웹훅 스펙과 코드가 맞는지 재확인.
3. Google Places 실제 키로 첫 위치 조회 확인.
4. Google Routes 실제 키로 첫 실제 도보 경로 확인.
5. 179건 실사용 데이터셋 재검증(파일 필요).
6. iOS Safari 실기기 검증.

1~4번은 전부 `docs/BUSINESS_DECISIONS.md` 6절의 환경변수를 넣는
것으로 시작하지만, **"환경변수만 넣으면 끝"이라고 보고하지 않는다**
— 넣은 뒤 실제로 동작을 확인하는 절차가 반드시 있어야 ③으로
올라간다.

---

## 4. 알려진 개선 여지(출시를 막지는 않지만 남겨 둔 것)

- 사용 한도(코스 생성 시간당 10회, 장소조회 일일 한도)는 엔지니어링
  안전장치로 코드에는 들어갔지만, 실제 사업적으로 적절한 값인지는
  아직 관찰 데이터가 없다(`docs/BUSINESS_DECISIONS.md` 3-4절 제안
  참고 — 확정 아님).
- Google Maps Platform의 현재 무료 사용량 정책(과거 월 정액 크레딧
  방식이었는지, SKU별 무료 사용량 방식으로 바뀌었는지)을 이 세션에서
  확인하지 못해 실제 원가 추정의 불확실성이 가장 크다
  (`docs/BUSINESS_DECISIONS.md` 3-3절).
- 재조회 사용 패턴(한 달에 저장 장소의 몇 %를 다시 확인하는지) 가정이
  임의값이다 — 체험단 운영 중 실제로 관찰해 갱신 필요.

---

## 5. 검증한 테스트 결과 (이번 세션에 다시 실행해 직접 확인)

```
node server/test/server.test.mjs                          # 전체 통과
node server/test/config.test.mjs                           # 18개 — 전체 통과(payment는 시크릿+클라이언트 키 둘 다 필요하도록 갱신)
node server/test/server-v2.test.mjs                         # 20개 — 전체 통과(신규: 로그인 쿨다운/잠금, 로그아웃, 장소조회 한도 분리, 코스생성 인증/멱등/잠금/레이트리밋)
node server/test/generation-trial-charging-success.test.mjs # 전체 통과(신규: 실제 경로 성공만 체험 차감)
node server/test/generation-trial-charging-failure.test.mjs # 전체 통과(신규: 추정 결과는 미차감, 반복 재시도 가능)
node server/test/production-boot.test.mjs                   # 8개 — 전체 통과(신규: 운영 부팅 거부 실제 재현)
node server/test/provider-contracts.test.mjs                # 27개 — 전체 통과(신규: Resend/토스/Google Routes 요청 형태 계약 테스트)
node scripts/test/run-all.mjs               # t1~t49, 개인용+판매용 양쪽 — 전체 통과
node scripts/design-integration-check.mjs   # 전체 통과
node scripts/test-storage-migration.mjs     # 전체 통과
node scripts/test-zip-import.mjs            # 전체 통과
node scripts/test-course-generation.mjs     # 3가지 시나리오(success/failure/budget) 합계 24개 — 전체 통과(서버 집행 구조로 재작성, 좌표 필터링 버그 발견·수정)
node scripts/test-purchase-flow.mjs         # 27개 — 전체 통과(첫 코스도 로그인 필요, 반응형 이용권 게이트로 재작성)
node scripts/test-multi-day.mjs             # 28개 — 전체 통과(같은 이유로 재작성)
node scripts/test-place-lookup.mjs          # 11개 — 전체 통과(로그인 게이트 추가에 맞춰 재작성)
node scripts/test-account-sync.mjs          # 12개 — 전체 통과(신규: 병합·로그아웃 격리·계정전환)
node scripts/test-landing-page.mjs          # 전체 통과
node scripts/audit.mjs                      # 개인정보·하드코딩 키 잔존 검사 — 전체 통과
node scripts/verify.mjs                     # 보호 블록·저장 키 무결성 — 전체 통과
```

모든 테스트는 실제 Chromium(Playwright) 또는 실제 HTTP 서버(임시
포트, 인메모리 SQLite)로 수행됐다. ②로 표시한 항목은 응답을 흉내 낸
것이지 테스트 자체가 가짜인 게 아니다 — 요청 생성부터 화면 반영까지
실제 코드 경로를 그대로 탄다. `server/test/provider-contracts.test.mjs`
는 `globalThis.fetch`만 가로채 응답을 대신해 줄 뿐, 우리 쪽 요청
생성 코드(URL·헤더·바디 형태, 금액/계정 위조 방지 검사)는 실제로
실행된다.

**우선순위 지시("전체 회귀 재실행보다 재현된 문제·실제 사용자 흐름
검증을 우선하라")에 따라**, 이번 세션은 기존 3가지 문제 재현
시나리오(무료체험 우회, 실패 시 차감, 운영 테스트기능 노출)를
실제로 코드로 재현한 뒤 고쳤고, 좌표 없는 장소가 코스 결과에
잘못 섞여드는 새로운 실제 버그도 재작성된 테스트 과정에서 발견해
고쳤다(1절의 `course-generation.mjs` 항목 참고). 그 다음에 전체
회귀(위 목록)를 한 번 더 통째로 돌려 다른 회귀가 없는지 확인했다.

## 6. 화면 캡처(합성 데이터)

`src/design/assets/marketing/1-collection.png`, `2-course.png` —
실제 앱 화면을 Playwright로 캡처한 것이며, 담긴 장소·사진은 전부 이
저장소에 이미 있던 샘플/디자인 예시 자산이다(실제 개인정보 없음).
`2-course.png`는 실제 키 연결이 막혀 있어(2절 참고) 성공 응답을
흉내 낸 장면이라는 점을 `src/design/landing.html`에 그대로 캡션으로
밝혀 뒀다 — 3차 갱신에서도 이 캡션 원칙은 그대로 유지한다(경로
계산 방식이 OSRM에서 Google Routes로 바뀌었어도 "예시 데이터"라는
사실 자체는 달라지지 않았다).
