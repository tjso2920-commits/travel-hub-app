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
  `);
}

export function uuid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}
