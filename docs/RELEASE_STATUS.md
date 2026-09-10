# 출시 상태 (RELEASE_STATUS)

작성: 2026-09-10(1차) · 갱신: 2026-09-10(2차 — 확정 상품 반영) ·
갱신: 2026-09-10(3차 — 결제/이메일/경로 공급자 확정, 서버 집행 구조
재설계) · 갱신: 2026-09-10(4차 — ChatGPT가 실제로 재현한 문제 수정,
API 비용 통제 실제 구현, 경유지 상한 반영) · 브랜치 `design-integration`

**4차 갱신 배경**: ChatGPT가 3차 결과물을 직접 코드로 재현·검토한 뒤
구체적인 문제를 지적했다 — (1) 운영에서 경로 API 키가 없으면
`computeWalkingRoute`가 테스트 시뮬레이터로 빠져 `routedReal:true`인
가짜 실제 경로를 만들 수 있음(실제로 `APP_ENV=production`+키 없음
상태에서 재현됨), (2) `/api/payment/cancel`이 계정 소유자를 대조하지
않아 다른 계정의 주문을 취소할 수 있음, (3) 코스 생성의 체험 차감·
결과 저장이 트랜잭션으로 묶여 있지 않음, (4) 장소 조회가 Legacy Find
Place의 첫 후보를 그대로 확정함, (5) API 호출 비용을 서버가 전혀
통제하지 않아 9,900원 상품에서 수천 원 이상의 비용이 발생할 수 있는
구조, (6) Google Routes 경유지 개수 상한을 안 지킴. 이 문서는 그
지적 하나하나에 대한 실제 코드 수정 결과를 정리한다.

- **①코드 완료** — 동작에 필요한 코드가 전부 작성됐고, 외부 서비스가
  없거나 실제 HTTP 요청으로 검증까지 끝난 기능.
- **②모의 검증** — 실제 코드 경로는 전부 진짜고, 응답을 주는 쪽만
  가짜(테스트 어댑터, `fetch` 모의 등)로 검증.
- **③실제 연결 검증** — 실제 키·실제 네트워크로 외부 서비스에 요청을
  보내 성공 응답을 실제로 받아봄.
- **④사용자 설정 필요** — 코드는 있지만 실제 키가 없거나
  (EGRESS_BLOCKED로 이 세션이 발급받지 못함), 사용자가 직접 키를
  넣고 처음 검증해야 하는 항목.

**이번에도 ③(실제 연결 검증)은 늘지 않았다** — 네트워크 제약은
3차와 동일하게 남아 있다(`docs.tosspayments.com`, `resend.com`,
`developers.google.com`, `mapsplatform.google.com` 전부 이번 세션에도
다시 시도했지만 여전히 접속 불가). 4차의 진짜 변화는 **① 코드
완료·실제 재현 테스트 통과 항목이 늘어난 것**이다 — 특히 "설정
함수만 통과하고 실제 엔드포인트는 검증 안 됨" 같은 반쪽짜리 검증이
없도록, 지적된 각 문제를 실제 HTTP 요청·실제 DB 상태로 재현하는
전용 테스트를 새로 만들었다(5절).

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

**요약**: ChatGPT가 지적한 6가지 문제(가짜 실제경로, 결제 취소 권한
미대조, 트랜잭션 미보장, Legacy Places API, 비용 통제 부재, 경유지
상한 미반영) **전부 실제 코드 수정 + 재현 테스트 통과까지 이번
세션에서 끝냈다.** 남은 것은 3차와 동일하게 네 공급자(Toss/Resend/
Google Places/Google Routes)의 ③(실제 키 연결) — 이 세션의 네트워크
제약 때문이며, 코드가 없어서가 아니다(2절 참고).

---

## 2. 이번 세션에서 못 하는 검증 — 사용자가 직접 확인할 최소 절차

### 2-1. 실제 키로 첫 연결 확인(가장 중요 — 3차와 동일하게 여전히 미검증)

- **상태**: Resend/토스페이먼츠/Google Places+Routes 네 서비스
  모두 실제 키로 검증된 적이 없다. 이번 세션도 네 공식 문서 사이트
  전부 접속이 막혀 있었다(EGRESS_BLOCKED).
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
node server/test/reliability-and-cost.test.mjs              # 43개 — 전체 통과(4차 신규 — ChatGPT 재현 문제 전용 테스트)
node server/test/routes-waypoint-limits.test.mjs            # 12개 — 전체 통과(4차 신규 — 경유지 분할·고요금 SKU)
node server/test/cost-budget-allornothing.test.mjs          # 5개 — 전체 통과(4차 신규 — 예산 부족 시 all-or-nothing)
node scripts/test/run-all.mjs               # t1~t49, 개인용+판매용 양쪽 — 전체 통과
node scripts/design-integration-check.mjs   # 전체 통과
node scripts/test-storage-migration.mjs     # 전체 통과
node scripts/test-zip-import.mjs            # 전체 통과
node scripts/test-course-generation.mjs     # 3가지 시나리오 합계 24개 — 전체 통과
node scripts/test-purchase-flow.mjs         # 27개 — 전체 통과
node scripts/test-multi-day.mjs             # 28개 — 전체 통과
node scripts/test-place-lookup.mjs          # 11개 — 전체 통과(Places API(New) 응답 형식 반영 확인)
node scripts/test-account-sync.mjs          # 12개 — 전체 통과
node scripts/test-landing-page.mjs          # 전체 통과
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

## 6. 화면 캡처(합성 데이터)

`src/design/assets/marketing/1-collection.png`, `2-course.png` —
실제 앱 화면을 Playwright로 캡처한 것이며, 담긴 장소·사진은 전부 이
저장소에 이미 있던 샘플/디자인 예시 자산이다(실제 개인정보 없음).
`2-course.png`는 실제 키 연결이 막혀 있어(2절 참고) 성공 응답을
흉내 낸 장면이라는 점을 `src/design/landing.html`에 그대로 캡션으로
밝혀 뒀다 — 4차 갱신에서도 이 캡션 원칙은 그대로 유지한다.
