'use strict';
/**
 * SQLite 기반 저장소(node:sqlite, Node 22 내장 — 별도 설치 불필요).
 *
 * 2026-09-09 코드 검토: "계정당 개인화 코스 생성 성공 1회. 서버가
 * 사용자 계정별로 성공한 생성 횟수를 저장하고, 요청이 올 때마다 서버가
 * 잔여 횟수를 확인한 뒤 잠그고 처리하고 풀어야 동시 요청·재시도로 두 번
 * 차감되지 않는다." — trial_usage 테이블의 account_id를 PRIMARY KEY로
 * 두어, "이 계정은 이미 1회를 썼다"는 사실 자체를 딱 한 행만 존재할 수
 * 있게 만든다. 동시에 두 요청이 동시에 INSERT를 시도해도 SQLite가 그중
 * 하나만 성공시키고 나머지는 제약 위반으로 실패시킨다 — 애플리케이션
 * 코드가 직접 잠금을 구현할 필요가 없다(DB 엔진이 원자적으로 보장한다).
 * node:sqlite의 DatabaseSync는 동기 API라 한 프로세스 안에서는 두
 * 요청이 진짜로 동시에 SQL을 실행할 수조차 없다(이벤트 루프가 직렬화한다)
 * — 그래도 PRIMARY KEY 제약을 쓰는 이유는, 나중에 여러 프로세스로
 * 수평 확장해도(각자 다른 이벤트 루프) 안전성이 애플리케이션 코드가
 * 아니라 DB 엔진 수준에서 보장되게 하기 위해서다.
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { config, ensureDataDir } from './config.mjs';

let db = null;

export function openDb(dbPath) {
  if (db) return db;
  const target = dbPath || config.dbPath;
  if (target !== ':memory:') ensureDataDir();
  db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      plan_expires_at TEXT,
      -- 2026-09-10 재검토(4차): "과거 주문 취소가 다른 유효 주문의
      -- 이용권을 없애지 않도록" — 지금 이 계정의 plan을 실제로 부여한
      -- 주문이 어느 것인지 기억해 둔다. 실제 토스 취소/웹훅이 이 값과
      -- 다른(이미 지나간) 주문을 취소하려 하면 지금의 이용권은 건드리지
      -- 않는다(payment-toss.mjs의 revokeEntitlementIfCurrentOrder 참고).
      active_order_id TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS courses (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trial_usage (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      consumed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES accounts(id),
      type TEXT NOT NULL,
      raw TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      props TEXT NOT NULL,
      account_id TEXT,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      channel TEXT,
      created_at TEXT NOT NULL
    );

    /* 2026-09-10 재검토(3차) 반영 — "브라우저에서 코스를 계산하고 서버는
       나중에 소진 기록만 남기는" 구조를 "서버가 인증→이용권 확인→생성→
       결과 저장→성공 확정까지 전부 집행"하는 구조로 바꾸기 위한 표들.

       account_places/account_courses: 장소 보관함·날짜별 일정을 계정별로
       서버에 보관한다(로드맵 신규 — "브라우저에만 저장되어 계정별 서버
       보관이 연결되지 않았다"는 지적 반영). 클라이언트의 foodMap.places/
       foodMap.courses 배열과 1:1로 대응한다. */
    /* 2026-09-10 재검토(7차) — version/deleted: 전체치환 PUT이 오래된
       기기의 스냅샷으로 최신 수정을 덮어쓰던 문제를 고치기 위해 추가.
       account-data.mjs의 syncPlaces/syncCourses 참고. */
    CREATE TABLE IF NOT EXISTS account_places (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      place_id TEXT NOT NULL,
      data TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (account_id, place_id)
    );
    CREATE TABLE IF NOT EXISTS account_courses (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      city TEXT NOT NULL,
      date TEXT NOT NULL,
      data TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (account_id, city, date)
    );

    /* generation_locks: 계정당 동시에 하나의 코스 생성만 진행 중일 수
       있다(PRIMARY KEY account_id — trial_usage와 같은 원자성 확보
       방식). generation_results: idempotencyKey로 같은 요청이 재시도돼도
       실제 작업을 다시 안 하고 저장된 결과를 그대로 돌려준다(멱등성). */
    -- 2026-09-10 재검토(4차): job_id로 "누가 이 잠금을 걸었는지" 검증한다
    -- (잠금 소유권 검증 — 오래된 잠금을 회수한 새 요청의 잠금을 원래
    -- 요청이 뒤늦게 지워버리는 사고 방지). started_at은 그대로 두어
    -- "얼마나 오래됐는지"로 죽은 프로세스의 잠금을 회수하는 기준으로 쓴다
    -- (config.generationLockTimeoutSeconds).
    CREATE TABLE IF NOT EXISTS generation_locks (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      job_id TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    -- request_hash: 같은 idempotencyKey로 실제로 다른 요청 본문(장소·
    -- 날짜 등)이 들어오면 저장된 옛 결과를 그대로 돌려주지 않고 충돌로
    -- 처리한다(2026-09-10 재검토 4차 — "같은 멱등키와 다른 요청 본문은
    -- 충돌 처리").
    CREATE TABLE IF NOT EXISTS generation_results (
      idempotency_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      request_hash TEXT,
      status TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    /* rate_counters: 시간창 고정 카운터 하나를 여러 용도로 공유한다
       (로그인 코드 요청 쿨다운, 코스 생성 시도 한도, 장소 조회 한도 —
       각각 scope 접두어로 구분: 'gen:<accountId>', 'lookup:import:
       <accountId>', 'lookup:requery:<accountId>', 'lookup:global',
       'login:<email>'). 실패한 시도도 카운트에 들어간다 — "성공만
       차감"(trial_usage)과 "시도 자체를 제한"(여기)은 다른 문제다. */
    CREATE TABLE IF NOT EXISTS rate_counters (
      scope TEXT NOT NULL,
      window_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, window_key)
    );
    /* lookup_cache: 완전히 같은 질의 문자열의 아주 짧은 중복 호출(예:
       화면을 실수로 여러 번 누름)만 줄이는 용도 — 장기 캐싱은 공급자
       약관을 확인하기 전까지 하지 않는다(코드 주석 참고). */
    CREATE TABLE IF NOT EXISTS lookup_cache (
      query_key TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    /* weather_cache: 2026-09-10 재검토(7차) 4절 — 착장 판단용 날씨 카드.
       같은 지역(위경도를 약 1km 단위로 반올림한 값)의 날씨는 이 지역을
       고른 모든 사용자가 공유해서 캐시한다("도시를 고를 때마다 매번
       호출" 방지 — weather.mjs의 regionKey 참고). lookup_cache와 표를
       분리한 이유는 TTL 정책이 다르기 때문이다(장소조회는 짧은 중복
       클릭만 줄이면 되고, 날씨는 자연 갱신 주기에 맞춰 더 길게 둔다). */
    CREATE TABLE IF NOT EXISTS weather_cache (
      region_key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    /* login_attempts: 코드 검증 실패 횟수를 세어 일정 횟수 넘으면 잠깐
       잠근다(무한 추측 방지 — rate_counters의 "요청 쿨다운"과는 다른
       문제라 별도 표로 둔다). */
    CREATE TABLE IF NOT EXISTS login_attempts (
      email TEXT PRIMARY KEY,
      fail_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    );

    /* orders: 결제 위젯에 넘길 주문을 서버가 먼저 만들어 둔다(금액·
       orderId를 서버가 authoritative하게 쥐고 있어야 나중에 confirm
       단계에서 "클라이언트가 부른 금액"이 아니라 "서버가 원래 정한
       금액"과 실제 승인 금액을 대조할 수 있다).

       2026-09-10 재검토(4차) 추가 컬럼:
       - entitlement_days: 이 주문이 실제로 승인됐을 때 며칠짜리
         이용권을 주는지 그 순간의 가격 정책을 그대로 못박아 둔다(나중에
         config.price.periodDays가 바뀌어도 이미 승인된 과거 주문의
         만료일 계산이 흔들리지 않게).
       - paid_at: 이용권 만료일 계산의 기준 시각(entitlement_days와
         함께 checkEntitlement가 주문에서 직접 계산한다).
       - cancelled_amount: 부분 취소 금액(전액 취소와 구분 — status가
         'cancelled'면 전액, 'partially_cancelled'면 이 값만큼만). */
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_key TEXT,
      entitlement_days INTEGER,
      paid_at TEXT,
      cancelled_amount INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    /* payment_locks: 같은 주문에 대한 승인(confirm)·취소(cancel) 요청이
       동시에 들어와도 실제 PG 호출은 한 번만 진행되게 한다(2026-09-10
       재검토 4차 — "공급자가 지원하는 멱등 처리 적용" 앞단 방어. 토스
       API 자체의 멱등키 지원 여부는 이 세션에서 문서를 재확인하지
       못했으므로, 우리 서버가 스스로 동시 중복 호출을 막는 이 잠금이
       1차 방어선이다). generation_locks와 같은 PRIMARY KEY 원자성 패턴. */
    CREATE TABLE IF NOT EXISTS payment_locks (
      order_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    /* cost_ledger: 실제 비용이 드는 외부 호출을 "하기로 결정한 시점"에
       그 예상 비용을 기록하는 원장(append-only). cost-ledger.mjs 참고 —
       성공/실패/타임아웃과 무관하게 한 번 기록되면 지우지 않는다(비용을
       0으로 되돌리는 취소 개념이 없다 — 실제로 얼마가 청구됐는지는
       공급자만 알고, 우리는 "쓰기로 결정한 예상액"만 관리한다). */
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      service TEXT NOT NULL,
      sku TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      estimated_cost_micros INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      -- 2026-09-10 재검토(6차): 이 비용이 어느 이용권 기간(free 또는
      -- 특정 주문의 order_id) 소속인지 표시한다 — 계정별 내부 원가
      -- 안전상한(무료 700원 누적/유료 이용권당 3,500원 누적)을 이
      -- period_id 기준으로 집계한다(server/entitlement-usage.mjs).
      period_id TEXT
    );

    /* 2026-09-10 재검토(5차) — "재방문 여행자 지원"(5절): 장소 보관함
       (account_places)은 계정 단위로 그대로 두고, 여행은 각자 고유한
       tripId·이름·날짜·숙소·코스 저장을 갖는다. 같은 도시로 여러 번
       떠난 여행도 각각 따로 저장·열람·전환할 수 있어야 하고, 새 여행을
       만들거나 도시를 바꿔도 기존 기록은 절대 지워지지 않는다.

       version: R5-7(재방문 기록을 보호하는 동기화)이 쓰는 낙관적 동시성
       번호 — 기기가 마지막으로 받아 간 버전과 지금 서버 버전이 다르면
       "조용한 전체 덮어쓰기" 대신 충돌로 보고 재병합한다(trips.mjs 참고). */
    CREATE TABLE IF NOT EXISTS trips (
      trip_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      city TEXT NOT NULL,
      name TEXT,
      start_date TEXT,
      end_date TEXT,
      lodging TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    /* trip_courses: 예전 account_courses(계정+도시+날짜)를 대신해
       "여행(trip_id)+날짜"로 코스를 저장한다 — 같은 도시라도 서로 다른
       여행이면 완전히 분리된 자리에 저장된다. */
    CREATE TABLE IF NOT EXISTS trip_courses (
      trip_id TEXT NOT NULL REFERENCES trips(trip_id),
      date TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (trip_id, date)
    );
    /* place_visits: 장소 하나(계정 전체 보관함 기준 — 특정 여행에 종속
       되지 않는다)의 방문 기록. visited/want_revisit은 서로 독립된
       불리언이라 동시에 둘 다 켤 수 있다("방문함"이면서 "다시 가고
       싶음"). visited_dates는 실제 방문 완료 처리를 할 때마다 쌓이는
       날짜 배열(같은 장소를 여러 번 방문한 기록·개인 메모를 보존하기
       위해 배열로 둔다) — 코스에 장소를 담는 행위 자체는 이 표를 절대
       건드리지 않는다(자동 방문처리 금지 지시).
       removed_visit_dates: "실수로 표시한 걸 취소"한 날짜의 흔적(무덤
       표시) — R5-7 동기화에서, 오래된 기기가 이미 지워진 날짜를 다시
       들고 나타나도 union 병합이 되살리지 못하게 막는 근거로 쓴다. */
    CREATE TABLE IF NOT EXISTS place_visits (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      place_id TEXT NOT NULL,
      visited INTEGER NOT NULL DEFAULT 0,
      want_revisit INTEGER NOT NULL DEFAULT 0,
      visited_dates TEXT NOT NULL DEFAULT '[]',
      removed_visit_dates TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (account_id, place_id)
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    /* 2026-09-10 재검토(6차) — "고객에게 약속한 사용량"(이용권 횟수)을
       실제 비용 원장(cost_ledger)과 분리해서 집행한다
       (server/entitlement-usage.mjs). period_id는 무료체험이면 고정
       문자열 'free'(계정당 평생 한 번), 유료면 그 이용권을 부여한
       주문의 order_id다 — "30일 이용권"이 달력월과 무관하게 그 주문
       하나에 계속 묶여 있어서, 월 경계를 넘어도 조용히 초기화되지
       않는다(새 주문 = 새 period_id일 때만 사용량이 새로 시작된다).
       place_lookups_used/course_successes_used는 오직
       entitlement-usage.mjs를 통해서만 올라간다(성공/신규 조건을
       그 파일이 전부 확인한 뒤에만 커밋). */
    CREATE TABLE IF NOT EXISTS entitlement_usage (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      period_id TEXT NOT NULL,
      place_lookups_used INTEGER NOT NULL DEFAULT 0,
      course_successes_used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, period_id)
    );
    /* entitlement_place_confirmed: 이 계정이 이 "실제" 장소(공급자가
       확정해 돌려준 real_place_id — 예: Google Places의 place.id)를
       실제로 처음 확인한 적이 있는지 — 계정당 영구(기간과 무관) 기록.
       "이미 위치가 확인된 기존 장소를 재사용/재조회하는 것은 신규 장소
       한도를 또 깎지 않는다"는 지시를 정확히 지키는 근거표: 여기 행이
       있으면 그 real_place_id는 어느 기간에 다시 조회돼도, 어느 클라
       이언트 로컬 id로 다시 나타나도 절대 신규로 안 센다.
       2026-09-10 재검토(7차) — 예전엔 이 표의 키가 클라이언트가 그냥
       불러주는 문자열(로컬 place id)이었다. 그러면 "같은 로컬 id로 서로
       다른 검색어를 보내 서로 다른 실제 장소를 확인해도 사용량이 1번만
       올라가는" 우회가 가능했다(클라이언트 문자열은 실제로 어떤 장소가
       확정됐는지와 아무 강제 연결이 없었기 때문). 이제 이 표는 반드시
       공급자가 실제로 돌려준 식별자로만 채워지고, "신규인지" 판정은
       외부 호출 결과가 돌아온 뒤(entitlement-usage.mjs의 finalize 단계)
       에만 확정된다 — 호출 전에는 잠정 예약만 한다. */
    CREATE TABLE IF NOT EXISTS entitlement_place_confirmed (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      real_place_id TEXT NOT NULL,
      first_period_id TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      PRIMARY KEY (account_id, real_place_id)
    );
    /* entitlement_place_local_link: 클라이언트의 로컬 place id 하나가
       "마지막으로 어떤 검색 조건(query_fingerprint)으로, 어떤 실제
       장소(real_place_id)를 확인했는지"의 캐시. 과금 판정의 근거표가
       아니다(그건 위 entitlement_place_confirmed) — 오직 "완전히 같은
       로컬 슬롯에 완전히 같은 검색 조건이 다시 들어오면, 외부 호출
       결과를 기다릴 것도 없이 이미 신규가 아님을 안다"는 빠른 경로용
       캐시일 뿐이다. 검색 조건이 조금이라도 달라지면 이 캐시를 못 믿고
       다시 확인 절차(예약→호출→실제 식별자로 재판정)를 거친다. */
    CREATE TABLE IF NOT EXISTS entitlement_place_local_link (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      local_place_id TEXT NOT NULL,
      real_place_id TEXT,
      query_fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, local_place_id)
    );
    /* entitlement_place_reservations: 2026-09-10 재검토(8차) 2절 —
       reservePlaceLookupSlot이 사용량을 잠정으로 +1 한 순간부터
       finalizePlaceLookupResult(성공/실패 어느 쪽이든)가 그 잠정 상태를
       해소할 때까지의 "진행 중" 표시. 이 행이 남아 있다는 것 자체가
       "아직 최종 판정이 안 끝났다"는 뜻이다. 서버 프로세스가 외부 호출
       도중 죽으면 이 행만 영원히 남고 사용량 +1은 절대 안 풀린다 —
       generation_locks/payment_locks와 같은 이유로 만료 회수가
       필요하다(락처럼 소유권 다툼이 있는 자원은 아니라 job_id 없이
       예약 자체의 존재 여부·나이만으로 판단한다). */
    CREATE TABLE IF NOT EXISTS entitlement_place_reservations (
      reservation_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      period_id TEXT NOT NULL,
      local_place_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entitlement_place_reservations_account
      ON entitlement_place_reservations(account_id);

    /* 2026-09-11 재검토(9차) 6-4절 — 소규모 베타·피드백 체계.
       app_flags: 운영자가 켜고 끄는 소수의 전역 스위치(지금은
       recruitment_paused 하나). 결제·데이터손실급 심각 이슈가 생기면
       코드를 새로 배포하지 않고도 신규 모집만 즉시 멈출 수 있게 한다. */
    CREATE TABLE IF NOT EXISTS app_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    /* invite_codes: 소규모 베타 모집용 초대 코드. max_uses(코드 하나당
       총 사용 가능 횟수)·expires_at(만료)을 갖는다. 실제로 이 게이트를
       켤지 말지는 config.requireInviteCodeForSignup(기본 꺼짐 — 가격이
       미정인 지금은 실제 모집을 시작하지 않는다는 지시 반영)이 결정한다.
       invite_code_redemptions: 코드 하나가 계정 하나에 실제로 쓰인
       기록 — PRIMARY KEY(code, account_id)라 같은 계정이 같은 코드를
       두 번 "쓴 것으로" 만들 수 없고, 애초에 이 표는 새 계정이 생기는
       그 순간에만 채워지므로(auth.mjs의 loginOrCreateAccount 참고) 한
       이메일(=한 계정)이 여러 번 "신규 등록"으로 코드를 반복 소모하는
       것 자체가 구조적으로 불가능하다. */
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      max_uses INTEGER NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invite_code_redemptions (
      code TEXT NOT NULL REFERENCES invite_codes(code),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      redeemed_at TEXT NOT NULL,
      PRIMARY KEY (code, account_id)
    );
    /* feedback: "불편함 보내기"(type별 한 줄 설명 + 선택 연락처 +
       최소 진단정보)와 코스 생성 직후 짧은 설문(type='survey_usage')을
       같이 담는다. diagnostic은 JSON 문자열이지만 서버가 허용된 키만
       저장한다(server/feedback.mjs의 화이트리스트 참고 — 전체
       저장목록·정밀 GPS·결제정보가 실려 오는 걸 구조적으로 막는다). */
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      contact TEXT,
      diagnostic TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'received',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
  `);

  migrateLegacyCoursesIntoTrips(d);
}

/* 2026-09-10 재검토(5차) — "기존 city+date 코스 데이터와 단일 일정
   데이터가 손실 없이 마이그레이션되어야 한다"(5-① 지시)는 요구를
   실제로 수행한다. schema_migrations로 딱 한 번만 실행되게 막는다(서버가
   재시작될 때마다 같은 데이터를 중복으로 여행을 또 만들지 않도록).

   규칙: 계정×도시 조합 하나당 새 여행 하나를 만든다(예전 구조는 "여행"
   개념이 없이 도시+날짜만 있었으므로, 같은 도시로의 모든 기존 날짜를
   하나의 여행으로 묶는 것이 가장 손실 없는 변환이다 — 이후로 그
   계정이 같은 도시에 다시 가면 완전히 새로운 여행이 별도로 생긴다).
   예전 단일 코스(courses 테이블, 멀티데이 도입 이전 구조)도 city/date
   필드가 있으면 같은 그룹에 합치고, 없으면 'unknown' 도시의 별도
   여행으로 만들어 데이터 자체는 절대 버리지 않는다. */
function migrateLegacyCoursesIntoTrips(d) {
  const already = d.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get('trips_v1_from_account_courses');
  if (already) return;

  const groups = new Map(); // key: accountId + '||' + city -> { accountId, city, rows: [{date, data, updatedAt}] }
  const getGroup = (accountId, city) => {
    const key = accountId + '||' + city;
    let g = groups.get(key);
    if (!g) { g = { accountId, city, rows: [] }; groups.set(key, g); }
    return g;
  };

  for (const r of d.prepare('SELECT account_id, city, date, data, updated_at FROM account_courses').all()) {
    getGroup(r.account_id, r.city).rows.push({ date: r.date, data: r.data, updatedAt: r.updated_at });
  }
  for (const r of d.prepare('SELECT account_id, data, updated_at FROM courses').all()) {
    let obj = null;
    try { obj = JSON.parse(r.data); } catch (e) { obj = null; }
    const city = (obj && obj.city) || 'unknown';
    const date = (obj && obj.date) || String(r.updated_at).slice(0, 10);
    const g = getGroup(r.account_id, city);
    if (!g.rows.some((x) => x.date === date)) g.rows.push({ date, data: r.data, updatedAt: r.updated_at });
  }
  if (!groups.size) {
    d.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('trips_v1_from_account_courses', nowIso());
    return;
  }

  const now = nowIso();
  const insertTrip = d.prepare('INSERT INTO trips (trip_id, account_id, city, name, start_date, end_date, lodging, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)');
  const insertCourse = d.prepare('INSERT INTO trip_courses (trip_id, date, data, updated_at) VALUES (?, ?, ?, ?)');
  for (const g of groups.values()) {
    const dates = g.rows.map((r) => r.date).sort();
    const tripId = 'trip_migrated_' + uuid();
    insertTrip.run(tripId, g.accountId, g.city, `${g.city} 여행(이전 기록)`, dates[0], dates[dates.length - 1], now, now);
    for (const r of g.rows) insertCourse.run(tripId, r.date, r.data, r.updatedAt);
  }
  d.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('trips_v1_from_account_courses', now);
}

export function uuid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}
