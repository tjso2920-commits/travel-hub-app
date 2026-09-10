'use strict';
/**
 * 최소 백엔드 진입점 — 로드맵 ⑧(유료 출시 준비) 실제 구현.
 *
 * 2026-09-09 코드 검토: "서버가 필요하다는 게 맞지만, 실 운영 계정이
 * 없다는 이유로 실제 구현 가능한 서버 코드·DB 스키마·테스트 작성을
 * 멈추지 말 것." 이 파일이 그 결과물이다 — 프레임워크 없이 Node
 * 내장 http만으로 만들었다(외부 패키지 설치 없이 바로 실행·테스트
 * 가능해야 한다는 판단). 실제 운영 규모가 커지면 Express 등으로
 * 옮길 수 있지만, 지금 트래픽 규모에서는 과설계다.
 *
 * 실행: node server/index.mjs (기본 포트 8787, PORT 환경변수로 변경)
 * 테스트: node server/test/server.test.mjs
 *
 * 이 서버는 사전 배포(pre-production) 상태다 — 아래가 전부 테스트
 * 모드(가짜 어댑터)로 동작하며, 실제 운영에 필요한 것은 문서 맨 끝
 * "실제 전환에 필요한 것"에 한 번에 정리돼 있다.
 */
import http from 'node:http';
import { config } from './config.mjs';
import { openDb } from './db.mjs';
import { requestLoginCode, verifyLoginCode, accountForToken } from './auth.mjs';
import { getCourse, saveCourse } from './routes/course.mjs';
import { trialStatus, consumeTrial } from './routes/trial.mjs';
import { checkEntitlement } from './routes/entitlement.mjs';
import { handleWebhook } from './routes/webhook.mjs';
import { lookupPlaceRoute } from './routes/places.mjs';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) { req.destroy(); reject(new Error('body-too-large')); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

/* 세션이 필요한 라우트 공통 처리 — account_id는 항상 여기서만 나온다.
   요청 본문의 account_id 같은 필드는 라우트 핸들러들이 아예 읽지
   않는다(routes/course.mjs 주석 참고 — 남의 계정을 사칭하는 걸 막는
   유일하고 확실한 방법은 "클라이언트가 준 식별자를 신뢰하지 않는" 것). */
function requireAccount(req, res) {
  const accountId = accountForToken(bearerToken(req));
  if (!accountId) { sendJson(res, 401, { ok: false, reason: 'unauthorized' }); return null; }
  return accountId;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (req.method === 'POST' && pathname === '/api/auth/request-code') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await requestLoginCode(body.email);
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === 'POST' && pathname === '/api/auth/verify-code') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = verifyLoginCode(body.email, body.code);
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === 'GET' && pathname === '/api/course') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      return sendJson(res, 200, getCourse(accountId));
    }
    if (req.method === 'PUT' && pathname === '/api/course') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = saveCourse(accountId, body.course);
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === 'GET' && pathname === '/api/trial') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      return sendJson(res, 200, trialStatus(accountId));
    }
    if (req.method === 'POST' && pathname === '/api/trial/consume') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      return sendJson(res, 200, consumeTrial(accountId));
    }
    if (req.method === 'GET' && pathname === '/api/entitlement') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const result = checkEntitlement(accountId);
      return sendJson(res, result.ok ? 200 : 404, result);
    }
    if (req.method === 'GET' && pathname === '/api/places/lookup') {
      const result = await lookupPlaceRoute(url.searchParams.get('q'));
      return sendJson(res, result.status, result.ok ? result.result : result);
    }
    if (req.method === 'POST' && pathname === '/api/webhook/payment') {
      const raw = await readBody(req);
      const sig = req.headers['x-webhook-signature'];
      const result = handleWebhook(raw, sig);
      return sendJson(res, result.status, result);
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, testMode: config.testMode });
    }
    sendJson(res, 404, { ok: false, reason: 'not-found' });
  } catch (e) {
    sendJson(res, 500, { ok: false, reason: 'internal-error', message: config.testMode ? String(e && e.message) : undefined });
  }
}

export function createServer() {
  openDb();
  return http.createServer(handle);
}

// 직접 실행됐을 때만 리스닝 시작(테스트에서는 createServer()만 불러 쓴다).
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  server.listen(config.port, () => {
    console.log(`서버 시작: http://localhost:${config.port} (${config.testMode ? 'TEST 모드 — 가짜 어댑터' : '운영 모드'})`);
  });
}
