# 운영 서버 설정 순서 (OPERATIONS_SETUP)

작성: 2026-09-10(6차 재검토) · 갱신: 2026-09-11(10차 — 테스트 위치
허용 절차 변경, AI 보조 분류 항목 추가) · 브랜치 `design-integration`

이 문서는 **실제 서비스를 켜기 전에** 사람이 직접 해야 하는 일을
순서대로 정리한다. 개발 담당(이 세션)은 outbound 네트워크가 막혀 있어
(`docs/RELEASE_STATUS.md` 2절) 아래 순서를 실제로 밟아본 적이
없다 — 이 문서는 "코드가 무엇을 기대하는지"를 정확히 옮긴 것이지,
실제로 이 순서대로 켰을 때 문제가 없다고 보장하는 게 아니다.

**핵심 원칙 하나**: `/api/health`가 "키가 설정돼 있다"고 보여주는 것과
"그 키로 실제 연결에 성공했다"는 것은 다른 이야기다. 이 문서의 순서를
전부 따라도, **각 서비스로 실제 요청을 한 번 이상 보내서 성공 응답을
받아보기 전까지는 "연결됐다"고 말할 수 없다.** 아래 3단계에 그
확인 방법을 서비스별로 따로 적어 뒀다.

---

## 0. 시작 전에 준비할 것

아래 네 공급자의 계정을 먼저 만들어 둔다(계정 생성 자체는 무료):

1. **토스페이먼츠**(결제) — https://www.tosspayments.com 가맹점 가입
2. **Resend**(이메일 발송) — https://resend.com 가입
3. **Google Cloud / Google Maps Platform**(장소 조회 + 경로 계산) —
   https://console.cloud.google.com 에서 프로젝트 생성 후
   Places API(New)·Routes API 활성화, **결제 수단 등록 필요**
   (Google Maps Platform은 무료 크레딧이 있어도 결제 수단 등록을
   요구한다)

이 중 하나라도 계정 생성 단계에서 막히면, 그 서비스는 나중에 "④
사용자 설정 필요" 상태로 남겨 두고(2절 참고) 나머지부터 먼저 켤 수
있다 — 서비스별로 독립적으로 켜지는 구조다(`server/config.mjs`).

---

## 1. 환경변수 입력 순서

**서버(`node server/index.mjs`)는 시작될 때 한 번만 환경변수를 읽는다
— 값을 바꾸면 서버를 재시작해야 반영된다.** 아래 순서로 하나씩
채운다(위에서부터 순서대로 해도 되고, 이미 갖고 있는 키부터 먼저
넣어도 된다 — 순서 자체가 서로를 막지는 않는다. 단, **6번(운영
모드 전환)은 항상 맨 마지막에 한다** — 그 전까지는 테스트 기능이
실수로 운영에 노출되는 걸 막아 주는 안전판 역할을 한다).

### 1-1. 필수 — 서버가 아예 못 뜨는 값

| 환경변수 | 값 | 확인 방법 |
|---|---|---|
| `DB_PATH` | 실제 서버가 쓸 SQLite 파일 경로(예: `/data/travelhub.db`) | 이 경로가 있는 디스크에 **지속 저장소**가 붙어 있어야 한다(컨테이너 재시작 시 파일이 사라지면 전체 계정 데이터가 날아간다) |
| `PORT` | 서버가 들을 포트(예: `3000`) | 리버스 프록시(nginx 등)가 이 포트로 연결하는지 확인 |

### 1-2. 이메일 로그인(Resend)

| 환경변수 | 값 |
|---|---|
| `EMAIL_ADAPTER` | `resend` |
| `EMAIL_API_KEY` | Resend 대시보드 → API Keys에서 발급한 키(`re_`로 시작) |
| `EMAIL_FROM` | 실제 보낼 발신 주소(Resend에 도메인 인증을 마친 주소여야 함 — 인증 안 된 도메인은 발송 자체가 거부될 수 있다) |

### 1-3. 결제(토스페이먼츠)

| 환경변수 | 값 |
|---|---|
| `PAYMENT_ADAPTER` | `toss` |
| `TOSS_CLIENT_KEY` | 토스페이먼츠 개발자센터의 **클라이언트 키**(결제창에 쓰임, `live_ck_`로 시작) |
| `PAYMENT_PG_SECRET` | 토스페이먼츠의 **시크릿 키**(서버 승인 API 호출용, `live_sk_`로 시작 — **절대 클라이언트에 노출되면 안 됨**, 이 값은 서버 프로세스 환경에만 넣는다) |
| `PAYMENT_WEBHOOK_SECRET` | 토스페이먼츠 웹훅 설정 화면에서 발급한 서명 검증용 시크릿 |
| `PAYMENT_EXPECTED_CURRENCY` | `KRW`(기본값, 보통 안 바꿔도 됨) |

### 1-4. 장소 조회(Google Places API New)

| 환경변수 | 값 |
|---|---|
| `PLACE_LOOKUP_ADAPTER` | `google` |
| `GOOGLE_PLACES_API_KEY` | Google Cloud Console에서 발급한 키 — **반드시 Places API(New)가 활성화된 프로젝트의 키**(Legacy Places API 전용 키는 이 코드가 요구하는 필드마스크를 못 준다) |

### 1-5. 경로 계산(Google Routes)

| 환경변수 | 값 |
|---|---|
| `ROUTING_ADAPTER` | `google` |
| `GOOGLE_ROUTES_API_KEY` | Google Cloud Console에서 발급한 키(Places 키와 같은 프로젝트여도 되고 달라도 됨 — Routes API가 활성화돼 있어야 함) |

### 1-5b. 착장 판단용 날씨(WeatherAPI.com) — 7차 신규

| 환경변수 | 값 |
|---|---|
| `WEATHER_API_KEY` | WeatherAPI.com에서 발급한 키(무료 등급으로 충분 — 공식 가격표
  https://www.weatherapi.com/pricing.aspx 확인: 상업적 사용 허용, 월
  100,000회, 현재 날씨+3일 예보 포함, https://www.weatherapi.com/docs/) |

이 키가 없어도 서버는 정상 시작된다(결제·이메일과 달리 **부팅을 막는
필수값이 아니다** — 날씨는 코스·동선 기능에 얹는 부가 기능이라, 키가
없으면 그냥 날씨 카드만 "일시적으로 이용할 수 없어요"로 뜬다). 다만
소비자에게 날씨 카드를 실제로 보여주려면 이 키를 넣어야 한다.

**소비자에게 절대 이 키를 입력하라고 요구하지 않는다** — 서버가 키를
들고 있고, 클라이언트(`src/design/weather-card.js`)는 좌표만 서버에
보낸다(Google Places/Routes 키와 같은 원칙). 이 공급자와 유료 계약을
새로 맺지 않는다 — 무료 등급 그대로 쓴다.

### 1-6. 운영 모드 전환(항상 맨 마지막)

| 환경변수 | 값 | 주의 |
|---|---|---|
| `APP_ENV` | `production` | **이 값을 넣기 전까지는 개발용 결제 시뮬레이션(`/api/dev/simulate-payment`) 같은 테스트 전용 경로가 그대로 열려 있다.** `production`으로 두면 그 경로들이 서버 자체에 아예 등록되지 않는다(`server/test/production-boot.test.mjs`로 확인된 동작) — 실제 손님을 받기 전 반드시 이 값을 넣는다 |
| `FORCE_TEST_MODE` | (설정 안 함 — 비워 둠) | 이 값이 `true`이면 장소 조회·경로 계산이 전부 가짜 테스트 어댑터로 동작한다. **운영 서버에는 이 변수 자체를 아예 넣지 않는다** |

### 1-6b. 특정 계정에 테스트 위치 허용(10차 변경 — 반드시 새로 읽을 것)

**9차까지는 브라우저 주소창에 `?testmode=1`만 붙이면 아무나 영구적으로
테스트 위치 기능을 켤 수 있었다 — 이건 보안 결함이었고 10차에서
막았다.** 이제는 서버 DB의 `accounts.test_access` 값이 `1`인 계정만
로그인마다 서버 재확인을 거쳐 테스트 위치 기능을 쓸 수 있다. 이 값은
운영자가 아래처럼 관리자 전용 API로만 켜고 끌 수 있다(환경변수 아님,
DB 값):

```bash
curl -X POST https://your-domain/api/admin/test-access \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"tester@example.com","enabled":true}'
```

`ADMIN_TOKEN`은 기존 관리자 인증 방식을 그대로 쓴다(별도 신규 환경변수
없음). QA·데모용 계정에만 켜 두고, 실제 손님 계정에는 절대 켜지
않는다. 끌 때는 `"enabled":false`로 같은 요청을 다시 보낸다 —
로그아웃·재로그인 없이도 다음 화면 전환부터 바로 반영된다(클라이언트가
매 로그인/화면마다 서버에 재확인하기 때문).

### 1-6c. AI 보조 자동분류(10차 신규) — 운영자가 할 일 없음

이 기능은 실제 AI 공급자가 아직 선정되지 않아 **운영 환경에서는
항상 비활성이고, 이를 켜는 환경변수 자체가 없다**(`server/config.mjs`
— `APP_ENV=production`이면 무조건 `disabled`). 개발 환경에서만
`AI_CLASSIFY_ADAPTER=mock`으로 가짜 어댑터를 켤 수 있는데, 이건
운영자가 신경 쓸 값이 아니다(운영 서버에 이 변수를 넣어도 코드가
무시한다). 실제 AI 공급자를 선정하면 이 절을 다시 채워야 한다 —
아직은 "구조만 있고 실제 연결은 없다"는 상태다(`docs/BUSINESS_DECISIONS.md`
3-3-6절 참고).

### 1-7. 선택 — 값 조정용(기본값 그대로 써도 된다)

가격·이용권 한도·비용 한도는 전부 기본값이 코드에 들어 있고, 아래
변수로만 바꿀 수 있다(코드 수정 불필요):

- `PRICE_AMOUNT_KRW`(기본 9900), `PRICE_PERIOD_DAYS`(기본 30),
  `PRICE_AUTO_RENEW`(기본 false)
- `ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT`(기본 10),
  `ENTITLEMENT_FREE_COURSE_LIMIT`(기본 1),
  `ENTITLEMENT_PAID_PLACE_LOOKUP_LIMIT`(기본 50),
  `ENTITLEMENT_PAID_COURSE_LIMIT`(기본 30) — **6차 신규, 이 문서
  작성 시점 기준 "초기 테스트 상품" 스펙이다(`docs/BUSINESS_DECISIONS.md`
  1절·3-3-1절) — 시장 검증된 확정값이 아니므로, 실제 손님 반응을 보고
  바꿀 수 있다는 걸 전제로 둔 값이다.**
- `COST_SAFETY_CAP_FREE_KRW_MICROS`(기본 700원 단위 micros),
  `COST_SAFETY_CAP_PAID_KRW_MICROS`(기본 3,500원 단위 micros) —
  6차 신규 내부 안전상한. **고객에게 보여주는 숫자가 아니다** — 회사가
  실제로 감당할 실비용의 절대 상한이다.
- `COST_GLOBAL_MONTHLY_KRW_MICROS` 등 나머지 비용 한도는
  `docs/BUSINESS_DECISIONS.md` 3-4절 참고.

---

## 2. 서버 시작

환경변수를 전부 넣은 뒤에만 서버를 시작한다:

```bash
DB_PATH=/data/travelhub.db PORT=3000 APP_ENV=production \
EMAIL_ADAPTER=resend EMAIL_API_KEY=re_xxx EMAIL_FROM=noreply@yourdomain.com \
PAYMENT_ADAPTER=toss TOSS_CLIENT_KEY=live_ck_xxx PAYMENT_PG_SECRET=live_sk_xxx PAYMENT_WEBHOOK_SECRET=whsec_xxx \
PLACE_LOOKUP_ADAPTER=google GOOGLE_PLACES_API_KEY=xxx \
ROUTING_ADAPTER=google GOOGLE_ROUTES_API_KEY=xxx \
WEATHER_API_KEY=xxx \
node server/index.mjs
```

(실제 운영에서는 위 값들을 커맨드라인에 직접 안 쓰고, 컨테이너
환경변수나 시크릿 매니저로 주입하는 걸 권장한다 — 커맨드라인 인자는
`ps` 등으로 다른 프로세스에서 보일 수 있다.)

---

## 3. 시작 후 반드시 할 것 — "키가 있다"와 "연결됐다"는 다르다

서버가 뜨면 `GET /api/health`를 열어 본다. 이 응답은 **"각 서비스에
키가 설정돼 있는지"만 보여준다** — `services.places: "configured"`가
"실제로 Google에 요청을 보내 성공 응답을 받았다"는 뜻이 아니다.
`verified` 필드가 있다면 그건 **이 세션이 코드로 미리 짐작한 값**이지
사람이 실제로 확인한 기록이 아니다. **아래 네 가지를 실제 화면에서
직접 눌러 봐야 "연결됐다"고 말할 수 있다**:

1. **이메일 로그인** — 실제 화면에서 이메일 주소를 넣고 "코드 받기"를
   누른 뒤, 그 이메일함에 실제로 6자리 코드가 도착하는지 확인한다.
2. **장소 조회** — 좌표가 없는 장소 하나를 실제로 가져온 뒤, 상세
   화면에서 "서버로 위치 후보 찾아보기"를 눌러 실제 후보(위도·경도·
   주소)가 나오는지 확인한다.
3. **경로 계산** — 좌표가 있는 장소 2곳 이상을 오늘 동선에 담고
   "코스 만들기"를 실제로 눌러, 결과 화면에 "실제 도보 경로 기준으로
   계산했습니다"라고 뜨는지 확인한다(직선거리 추정으로 뜨면 경로 키
   연결에 문제가 있다는 뜻).
4. **결제** — 실제로 소액(9,900원) 결제를 한 번 진행해, 토스페이먼츠
   대시보드에 그 거래가 실제로 찍히는지, 이 계정이 실제로
   `paid`(유료)로 바뀌는지 확인한다. 그 뒤 **테스트 결제라면 반드시
   토스페이먼츠 쪽에서 취소 처리**한다(실제 돈이 오갔다면).
5. **날씨(7차 신규)** — "오늘 동선" 화면을 열어 맨 위 날씨 카드가
   "테스트 데이터(예시)"가 아니라 "WeatherAPI.com 제공"으로 뜨는지,
   실제 그 도시의 실제 기온·날씨로 보이는지 확인한다. 카드 하단의
   "몇 시 기준" 표시가 실제 현재 시각과 크게 어긋나지 않는지도 함께
   본다(너무 오래된 값이면 `stale` 문구가 같이 뜬다).

이 다섯 가지를 실제 아이폰(Safari)에서도 한 번씩 해 보는 걸 권장한다 —
이 세션은 실제 iPhone 기기에서 확인한 적이 없다(`docs/RELEASE_STATUS.md`
2-3절).

---

## 4. 이미 마이그레이션된 계정이 있다면

서버가 처음 켜질 때 기존 `account_courses`(여행 분리 이전 데이터)를
`trips`/`trip_courses`로 자동 옮기는 마이그레이션이 **딱 한 번만**
실행된다(`server/db.mjs`의 `migrateLegacyCoursesIntoTrips`,
`schema_migrations` 테이블로 중복 실행을 막는다). 운영 DB에 처음
배포할 때 서버 로그에서 이 마이그레이션이 실제로 한 번 실행됐는지
확인한다 — 실행 안 됐다면 기존 사용자가 재방문 여행자 화면에서
"여행이 하나도 없다"고 보일 수 있다(데이터 자체는 안전하게 남아 있고
서버 재시작 시 다시 시도된다).

---

## 5. 하지 말아야 할 것

- `FORCE_TEST_MODE=true`를 운영 서버에 넣지 않는다.
- `APP_ENV=production` 없이 실제 손님에게 서버를 공개하지 않는다.
- `PAYMENT_PG_SECRET`을 클라이언트 코드·저장소·로그에 남기지 않는다.
- `/api/health`의 `services` 값만 보고 "전부 연결 확인 완료"라고
  보고하지 않는다(위 3절을 실제로 다 해봐야 한다).
