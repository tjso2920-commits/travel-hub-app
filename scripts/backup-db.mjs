'use strict';
/**
 * 운영 DB 온라인 백업 — SQLite 자체 백업 API를 그대로 쓴다(node:sqlite
 * 내장 backup() 함수, 별도 sqlite3 CLI 설치 불필요). 서버가 그 파일에
 * 계속 쓰기 중이어도 안전하게 스냅샷을 뜬다.
 *
 * 2026-09-12 재검토(15차, 3차 후속) 2절 — "코드로 준비할 수 있는
 * 백업 구성을 완성하라"는 지시 반영. 예전 OPERATIONS_SETUP.md는
 * `sqlite3 $DB_PATH ".backup ..."` 셸 명령을 쓰라고만 안내했는데,
 * 그 CLI가 없는 환경(예: sqlite3 패키지를 따로 안 깐 서버)에서는
 * 그대로 못 쓴다 — node:sqlite만으로 되는 방법으로 바꿨다.
 *
 * 실행: node scripts/backup-db.mjs [백업파일경로]
 * - DB_PATH 환경변수(백업 대상)가 필수.
 * - 백업파일경로를 생략하면 DB_PATH와 같은 폴더에
 *   `<원본이름>.backup-<타임스탬프>.db`로 만든다.
 */
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error('DB_PATH 환경변수가 필요합니다(백업할 운영 DB 경로).');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`DB_PATH가 가리키는 파일이 없습니다: ${dbPath}`);
  process.exit(1);
}

function defaultDestPath() {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath, path.extname(dbPath));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${base}.backup-${stamp}.db`);
}

const destPath = process.argv[2] || defaultDestPath();
if (fs.existsSync(destPath)) {
  console.error(`백업 대상 파일이 이미 있습니다(덮어쓰지 않음): ${destPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const pages = await backup(db, destPath);
  console.log(`백업 완료: ${destPath} (${pages}페이지)`);
} finally {
  db.close();
}
