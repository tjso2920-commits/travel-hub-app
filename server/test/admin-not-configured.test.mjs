'use strict';
/**
 * 2026-09-11 재검토(9차) 6-4절 — ADMIN_TOKEN을 아예 설정 안 한 상태에서
 * 관리자 API를 부르면 "누구나 통과"가 아니라 "관리자 기능 자체가 아직
 * 준비 안 됨"(501)으로 정직하게 막혀야 한다(빈 문자열끼리 비교해 토큰
 * 없이도 통과하는 사고 방지). config.mjs가 프로세스당 1회만 읽히는
 * 싱글턴이라 이 시나리오만 별도 프로세스(파일)로 검증한다.
 *
 * 실행: node server/test/admin-not-configured.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ADMIN_TOKEN = ''; // 명시적으로 비움 — 기본값과 동일한 상태.

const { createServer } = await import('../index.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const noToken = await fetch(`${base}/api/admin/feedback`);
t('ADMIN_TOKEN 미설정 시 토큰 없이는 501(관리자 기능 미준비)', noToken.status === 501);
const emptyBearer = await fetch(`${base}/api/admin/feedback`, { headers: { Authorization: 'Bearer ' } });
t('ADMIN_TOKEN 미설정 시 빈 토큰을 보내도 501(빈 문자열끼리 비교해 통과하는 사고 방지)', emptyBearer.status === 501);
const anyToken = await fetch(`${base}/api/admin/feedback`, { headers: { Authorization: 'Bearer anything' } });
t('ADMIN_TOKEN 미설정 시 아무 토큰을 보내도 501(200으로 통과하지 않음)', anyToken.status === 501);

server.close();

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
