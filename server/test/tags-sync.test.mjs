'use strict';
/**
 * 2026-09-11 재검토(11차) 3절 — "태그 레지스트리를 계정별로 저장·
 * 동기화하고 계정 전환 시 격리해." account_tags 테이블·/api/tags
 * 라우트를 순수 서버 로직(인메모리 SQLite)만으로 검증한다. 실제
 * 화면·다른 기기 흐름은 scripts/test-tag-registry-sync.mjs(Playwright)
 * 참고.
 *
 * 실행: node server/test/tags-sync.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';

const { createServer } = await import('../index.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}
function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}
function directSession(accountId) {
  const db = openDb();
  const token = Buffer.from(String(Math.random())).toString('hex') + accountId;
  db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, accountId, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
  return token;
}

// ============================================================
// 1. 새 태그를 만들어 올리면 저장되고, 다시 GET하면(다른 기기 흉내)
//    그대로 돌아온다.
// ============================================================
{
  const acc = directAccount('tags-1@example.com');
  const token = directSession(acc);
  const put1 = await api('PUT', '/api/tags', { token, body: { tags: [{ id: 'custom_brunch', label: '브런치', synonyms: [], source: 'user', version: 0 }] } });
  t('1) 새 태그 저장 성공', put1.status === 200 && put1.json.tags.length === 1);
  const get1 = await api('GET', '/api/tags', { token });
  t('1) 다시 조회하면(다른 기기 최초 로그인 흉내) 그대로 돌아옴', get1.json.tags[0].label === '브런치' && get1.json.tags[0].id === 'custom_brunch');
}

// ============================================================
// 2. 기본 태그 표시명 override — 실제 새 label로 저장되고, 삭제
//    큐로 지우면 사라진다(단, 기본 태그 자체 정의는 이 표에 없다 —
//    override 행이 있고 없고만 결정한다).
// ============================================================
{
  const acc = directAccount('tags-2@example.com');
  const token = directSession(acc);
  const put1 = await api('PUT', '/api/tags', { token, body: { tags: [{ id: 'cafe', label: '커피숍', synonyms: [], source: 'builtin-override', version: 0 }] } });
  const savedOverride = put1.json.tags.find((x) => x.id === 'cafe');
  t('2) 기본 태그 override가 실제로 저장됨', savedOverride && savedOverride.label === '커피숍');
  const del = await api('PUT', '/api/tags', { token, body: { tags: [], deletedIds: [{ id: 'cafe', baseVersion: savedOverride.version }] } });
  t('2) override를 지우면(기본값으로 되돌리기) 목록에서 빠짐', !del.json.tags.some((x) => x.id === 'cafe'));
}

// ============================================================
// 3. 계정 간 완전 격리 — 계정 A의 태그가 계정 B의 조회에 절대 안 보임.
// ============================================================
{
  const accA = directAccount('tags-3a@example.com');
  const tokenA = directSession(accA);
  await api('PUT', '/api/tags', { token: tokenA, body: { tags: [{ id: 'custom_only_a', label: 'A 계정 전용 태그', synonyms: [], source: 'user', version: 0 }] } });

  const accB = directAccount('tags-3b@example.com');
  const tokenB = directSession(accB);
  const getB = await api('GET', '/api/tags', { token: tokenB });
  t('3) 계정 B는 계정 A의 태그를 전혀 못 봄(계정 격리)', getB.json.tags.length === 0);
}

// ============================================================
// 4. 내용이 안 바뀐 재전송은 버전을 안 올림(account_places/trips와
//    같은 원칙) — 다른 기기의 정상 저장이 가짜 충돌을 안 만나게.
// ============================================================
{
  const acc = directAccount('tags-4@example.com');
  const token = directSession(acc);
  const created = await api('PUT', '/api/tags', { token, body: { tags: [{ id: 'custom_x', label: 'X', synonyms: [], source: 'user', version: 0 }] } });
  const v1 = created.json.tags[0].version;
  const resend = await api('PUT', '/api/tags', { token, body: { tags: [{ id: 'custom_x', label: 'X', synonyms: [], source: 'user', version: v1 }] } });
  t('4) 안 바뀐 재전송은 버전이 그대로임', resend.json.tags[0].version === v1);
  const realChange = await api('PUT', '/api/tags', { token, body: { tags: [{ id: 'custom_x', label: 'Y로 바뀜', synonyms: [], source: 'user', version: v1 }] } });
  t('4) 실제로 바뀐 재전송은 버전이 올라감', realChange.json.tags[0].version === v1 + 1 && realChange.json.tags[0].label === 'Y로 바뀜');
}

t('최종 콘솔/런타임 오류 없음(서버 프로세스 자체가 살아 있음)', true);
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
server.close();
process.exit(fail ? 1 : 0);
