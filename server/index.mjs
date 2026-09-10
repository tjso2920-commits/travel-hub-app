'use strict';
/**
 * 최소 백엔드 진입점 — 로드맵 ⑧(유료 출시 준비) 실제 구현.
 *
 * 실행: node server/index.mjs (기본 포트 8787, PORT 환경변수로 변경)
 * 테스트: node server/test/server.test.mjs
 *
 * 2026-09-10 재검토(3차) — "무료체험과 유료 계산을 서버에서 집행하고,
 * 운영에서 테스트 기능을 확실히 차단하라." 이번 갱신으로:
 * - 개인화 코스 생성 자체가 서버 라우트(POST /api/course/generate)로
 *   옮겨졌다(routes/course-generation.mjs) — 브라우저가 계산하고
 *   나중에 소진만 알리는 예전 구조를 버렸다.
 * - 개발용 결제 시뮬레이션(/api/dev/simulate-payment)은 이제
 *   `config.appEnv !== 'production'`일 때만 **라우트 자체를 등록**한다
 *   (권한 검사로 막는 게 아니라 애초에 존재하지 않게 한다 — "키가
 *   빠졌다고 다시 열리면 안 된다"는 지시 반영).
 * - 실제 토스페이먼츠 주문/승인/취소, 실제 장소 조회 인증·한도, 계정별
 *   서버 저장(장소·날짜별 일정) 라우트가 추가됐다.
 */
import http from 'node:http';
import { config, assertBootReady } from './config.mjs';
import { openDb } from './db.mjs';
import { requestLoginCode, verifyLoginCode, accountForToken, logout } from './auth.mjs';
import { getCourse, saveCourse } from './routes/course.mjs';
import { trialStatus, consumeTrial } from './routes/trial.mjs';
import { checkEntitlement } from './routes/entitlement.mjs';
import { handleWebhook } from './routes/webhook.mjs';
import { handleTossWebhook } from './routes/webhook-toss.mjs';
import { lookupPlaceRoute, lookupPlacesBatchRoute } from './routes/places.mjs';
import { recordEvent } from './routes/events.mjs';
import { joinWaitlist } from './routes/waitlist.mjs';
import { generateCourseRoute } from './routes/course-generation.mjs';
import { getPlaces, putPlaces, getCourses, putCourses } from './routes/account-data.mjs';
import { paymentConfigRoute, createOrderRoute, confirmOrderRoute, cancelOrderRoute } from './routes/payment.mjs';
import { listTrips, createTrip, updateTrip, getTripCourses, putTripCourses, syncTrips } from './routes/trips.mjs';
import { getVisits, markVisited, unmarkVisited, setWantRevisit, setNotes, syncVisits } from './routes/visits.mjs';
import { suggestNextTripPlaces } from './routes/next-trip-suggestions.mjs';
import { usageSummaryForAccount } from './entitlement-usage.mjs';
import { getVerifiedStatus } from './status.mjs';

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

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Webhook-Signature');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  withCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

function clientIp(req) {
  // 리버스 프록시 뒤에 배포하면 X-Forwarded-For를 봐야 실제 클라이언트
  // IP가 나온다 — 프록시 설정에 따라 헤더 이름이 다를 수 있어 배포
  // 환경이 정해지면 이 함수만 맞추면 된다.
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress;
}

function requireAccount(req, res) {
  const accountId = accountForToken(bearerToken(req));
  if (!accountId) { sendJson(res, 401, { ok: false, reason: 'unauthorized' }); return null; }
  return accountId;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (req.method === 'OPTIONS') { withCors(res); res.writeHead(204); res.end(); return; }
  try {
    if (req.method === 'POST' && pathname === '/api/auth/request-code') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await requestLoginCode(body.email, clientIp(req));
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === 'POST' && pathname === '/api/auth/verify-code') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = verifyLoginCode(body.email, body.code);
      return sendJson(res, result.ok ? 200 : (result.reason === 'locked' ? 429 : 400), result);
    }
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const result = logout(bearerToken(req));
      return sendJson(res, 200, result);
    }

    // 계정별 서버 저장 — 장소 보관함·날짜별 일정(2026-09-10 신규).
    if (req.method === 'GET' && pathname === '/api/places') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      return sendJson(res, 200, getPlaces(accountId));
    }
    if (req.method === 'PUT' && pathname === '/api/places') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = putPlaces(accountId, body.places);
      return sendJson(res, result.status || 200, result);
    }
    if (req.method === 'GET' && pathname === '/api/courses') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      return sendJson(res, 200, getCourses(accountId));
    }
    if (req.method === 'PUT' && pathname === '/api/courses') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = putCourses(accountId, body.courses);
      return sendJson(res, result.status || 200, result);
    }
    // 예전 단일 코스 저장(로드맵 ⑧ 최초 설계) — 클라이언트가 실제로
    // 부르지 않게 됐지만(멀티데이 도입 이후 /api/courses가 그 자리를
    // 대신한다), 기존 테스트·하위 호환을 위해 남겨 둔다.
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

    // 개인화 코스 생성 — 인증 필수, 서버가 전부 집행(2026-09-10 신규).
    if (req.method === 'POST' && pathname === '/api/course/generate') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await generateCourseRoute(accountId, body);
      return sendJson(res, result.status || (result.ok ? 200 : 400), result);
    }

    // 재방문 여행자 지원(2026-09-10 재검토 5차 5절) — 여행 분리(trips)와
    // 방문 기록(visits). 전부 순수 기록 읽기/쓰기라 유료 API를 전혀 안
    // 부른다 — 무료체험·이용권 상태와 무관하게 항상 동작한다(5-④ 지시).
    if (req.method === 'GET' && pathname === '/api/trips') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      return sendJson(res, 200, listTrips(accountId));
    }
    if (req.method === 'POST' && pathname === '/api/trips') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = createTrip(accountId, body);
      return sendJson(res, result.status, result);
    }
    // 6절 — 재방문 기록을 보호하는 동기화(버전 확인 후 충돌이면 조용히
    // 덮어쓰지 않고 재병합). 예전 /api/places, /api/courses의 "전체
    // 치환 PUT"과 달리, 이 엔드포인트는 기기가 보낸 각 항목의 version을
    // 서버와 대조해 뒤처진 항목만 보수적으로 재병합한다.
    if (req.method === 'POST' && pathname === '/api/trips/sync') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = syncTrips(accountId, body.trips);
      return sendJson(res, result.status, result);
    }
    if (req.method === 'POST' && pathname === '/api/visits/sync') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = syncVisits(accountId, body.visits);
      return sendJson(res, result.status, result);
    }
    const tripCoursesMatch = pathname.match(/^\/api\/trips\/([^/]+)\/courses$/);
    if (tripCoursesMatch) {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const tripId = decodeURIComponent(tripCoursesMatch[1]);
      if (req.method === 'GET') {
        const result = getTripCourses(accountId, tripId);
        return sendJson(res, result.status || 200, result);
      }
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = putTripCourses(accountId, tripId, body.courses);
        return sendJson(res, result.status, result);
      }
    }
    const tripMatch = pathname.match(/^\/api\/trips\/([^/]+)$/);
    if (tripMatch && req.method === 'PUT') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const tripId = decodeURIComponent(tripMatch[1]);
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = updateTrip(accountId, tripId, body);
      return sendJson(res, result.status, result);
    }

    if (req.method === 'GET' && pathname === '/api/visits') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      return sendJson(res, 200, getVisits(accountId));
    }
    // 5-③ 다음 여행 코스 후보 제안 — 순수 DB 조회/정렬이라 유료 API를
    // 전혀 안 부른다(무료·유료 경계 5-④와 동일 원칙).
    if (req.method === 'GET' && pathname === '/api/trips/next-suggestions') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const mustIncludeIds = (url.searchParams.get('mustInclude') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const result = suggestNextTripPlaces(accountId, {
        fromTripId: url.searchParams.get('fromTripId') || undefined,
        preferUnvisited: url.searchParams.get('preferUnvisited') !== '0',
        includeWantRevisit: url.searchParams.get('includeWantRevisit') !== '0',
        mustIncludeIds,
      });
      return sendJson(res, result.status || 200, result);
    }
    const visitActionMatch = pathname.match(/^\/api\/visits\/([^/]+)\/(mark|unmark|want-revisit|notes)$/);
    if (visitActionMatch && req.method === 'POST') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const placeId = decodeURIComponent(visitActionMatch[1]);
      const action = visitActionMatch[2];
      const body = JSON.parse((await readBody(req)) || '{}');
      let result;
      if (action === 'mark') result = markVisited(accountId, placeId, { date: body.date, tripId: body.tripId, note: body.note });
      else if (action === 'unmark') result = unmarkVisited(accountId, placeId, { date: body.date });
      else if (action === 'want-revisit') result = setWantRevisit(accountId, placeId, !!body.wantRevisit);
      else result = setNotes(accountId, placeId, body.notes);
      return sendJson(res, result.status, result);
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
    // 2026-09-10 재검토(6차) — 계정 화면의 "잔여 횟수" 표시용. API/SKU
    // 같은 개발 용어 없이 소비자가 그대로 읽을 수 있는 값만 돌려준다
    // (server/entitlement-usage.mjs의 usageSummaryForAccount).
    if (req.method === 'GET' && pathname === '/api/account/usage') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      return sendJson(res, 200, usageSummaryForAccount(accountId));
    }

    // 장소 조회 — 인증 필수 + 계정별/서비스 전체 한도(2026-09-10).
    // 2026-09-10 재검토(4차): phase 쿼리 파라미터는 더 이상 한도 등급을
    // 정하지 않는다(클라이언트 자기 신고였다는 지적 반영) — area 힌트만
    // 동명 장소 판별에 쓴다. 더 큰 한도는 아래 배치 엔드포인트로만.
    if (req.method === 'GET' && pathname === '/api/places/lookup') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const result = await lookupPlaceRoute(accountId, url.searchParams.get('q'), url.searchParams.get('area'), url.searchParams.get('placeId'));
      return sendJson(res, result.status, result.ok ? result.result : result);
    }
    if (req.method === 'POST' && pathname === '/api/places/lookup-batch') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await lookupPlacesBatchRoute(accountId, body.items);
      return sendJson(res, result.status, result);
    }

    if (req.method === 'POST' && pathname === '/api/waitlist') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = joinWaitlist({ email: body.email, channel: body.channel });
      return sendJson(res, result.status, result);
    }
    if (req.method === 'POST' && pathname === '/api/events') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const accountId = accountForToken(bearerToken(req));
      const result = recordEvent({ name: body.name, props: body.props, accountId });
      return sendJson(res, result.status, result);
    }

    // 실제 결제(토스페이먼츠) — 주문 생성 → 위젯 → 승인 확인 → 취소.
    if (req.method === 'GET' && pathname === '/api/payment/config') {
      const result = paymentConfigRoute();
      return sendJson(res, result.status, result);
    }
    if (req.method === 'POST' && pathname === '/api/payment/order') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const result = createOrderRoute(accountId);
      return sendJson(res, result.status, result);
    }
    if (req.method === 'POST' && pathname === '/api/payment/confirm') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await confirmOrderRoute(accountId, body);
      return sendJson(res, result.status, result);
    }
    if (req.method === 'POST' && pathname === '/api/payment/cancel') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await cancelOrderRoute(accountId, body);
      return sendJson(res, result.status, result);
    }
    if (req.method === 'POST' && pathname === '/api/webhook/toss') {
      const raw = await readBody(req);
      const result = await handleTossWebhook(raw);
      return sendJson(res, result.status, result);
    }

    // 개발용 결제 시뮬레이션 — production에서는 이 블록 자체가 실행되지
    // 않는다(아래 참고). 라우트가 아예 없으니 어떤 요청을 보내도 404다.
    if (!config.isProd && req.method === 'POST' && pathname === '/api/dev/simulate-payment') {
      const accountId = requireAccount(req, res); if (!accountId) return;
      const body = JSON.parse((await readBody(req)) || '{}');
      const { simulatePayment } = await import('./routes/dev.mjs');
      const result = simulatePayment(accountId, body.outcome);
      return sendJson(res, result.status, result);
    }
    if (!config.isProd && req.method === 'POST' && pathname === '/api/webhook/payment') {
      const raw = await readBody(req);
      const sig = req.headers['x-webhook-signature'];
      const result = handleWebhook(raw, sig);
      return sendJson(res, result.status, result);
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      // "키 존재"(services.*)와 "실제로 연결해 본 적 있는지"(verified)를
      // 구분해서 보여준다(2026-09-10: "상태 표시는 키 존재와 실제 연결
      // 확인을 구분하라").
      return sendJson(res, 200, {
        ok: true,
        appEnv: config.appEnv,
        testMode: config.testMode,
        services: config.services,
        verified: getVerifiedStatus(),
      });
    }
    sendJson(res, 404, { ok: false, reason: 'not-found' });
  } catch (e) {
    sendJson(res, 500, { ok: false, reason: 'internal-error', message: !config.isProd ? String(e && e.message) : undefined });
  }
}

export function createServer() {
  openDb();
  return http.createServer(handle);
}

// 직접 실행됐을 때만 리스닝 시작(테스트에서는 createServer()만 불러 쓴다).
if (import.meta.url === `file://${process.argv[1]}`) {
  const ready = assertBootReady(config);
  if (!ready.ok) {
    console.error('서버 시작 거부 — 운영(production) 환경에 필수 설정이 없습니다:');
    ready.missing.forEach((m) => console.error('  - ' + m));
    console.error('docs/BUSINESS_DECISIONS.md 6절을 참고해 환경변수를 채운 뒤 다시 시작하세요.');
    process.exit(1);
  }
  const server = createServer();
  server.listen(config.port, () => {
    console.log(`서버 시작: http://localhost:${config.port} (환경: ${config.appEnv})`);
  });
}
