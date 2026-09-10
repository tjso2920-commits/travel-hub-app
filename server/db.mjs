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
      plan_expires_at TEXT
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
    CREATE TABLE IF NOT EXISTS account_places (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      place_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, place_id)
    );
    CREATE TABLE IF NOT EXISTS account_courses (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      city TEXT NOT NULL,
      date TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, city, date)
    );

    /* generation_locks: 계정당 동시에 하나의 코스 생성만 진행 중일 수
       있다(PRIMARY KEY account_id — trial_usage와 같은 원자성 확보
       방식). generation_results: idempotencyKey로 같은 요청이 재시도돼도
       실제 작업을 다시 안 하고 저장된 결과를 그대로 돌려준다(멱등성). */
    CREATE TABLE IF NOT EXISTS generation_locks (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      started_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generation_results (
      idempotency_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
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
       금액"과 실제 승인 금액을 대조할 수 있다). */
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function uuid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}
