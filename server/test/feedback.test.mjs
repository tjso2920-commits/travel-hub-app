'use strict';
/**
 * 2026-09-11 재검토(9차) 6-4절 — "불편함 보내기" + 코스 설문 + 소규모
 * 관리자 화면 API 검증. 초대 코드 게이트는 기본값(꺼짐)으로 둔 채라
 * 여기서는 그 부분을 안 건드린다(별도 파일 server/test/invite-codes.test.mjs
 * 가 켜졌을 때의 동작을 검증한다).
 *
 * 실행: node server/test/feedback.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ADMIN_TOKEN = 'test-admin-token-not-for-production';
process.env.FEEDBACK_PER_ACCOUNT_DAILY_LIMIT = '2';
process.env.FEEDBACK_PER_IP_DAILY_LIMIT = '3';
process.env.FEEDBACK_MAX_DESCRIPTION_LENGTH = '50';

const { submitFeedback, submitUsageSurvey, adminListFeedback, adminUpdateFeedbackStatus } = await import('../feedback.mjs');
const { createServer } = await import('../index.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}

// =====================================================================
// 1) 기본 유효성 검사 — 허용 안 된 유형·빈 설명·너무 긴 설명은 거절.
// =====================================================================
t('1) 허용 안 된 유형은 거절됨', submitFeedback({ type: 'not-a-type', description: '설명' }).reason === 'invalid-type');
t('1) 빈 설명은 거절됨', submitFeedback({ type: 'other', description: '   ' }).reason === 'empty-description');
t('1) 최대 길이를 넘는 설명은 거절됨', submitFeedback({ type: 'other', description: 'x'.repeat(51) }).reason === 'description-too-long');

// =====================================================================
// 2) 정상 제출 — diagnostic은 허용된 키(appBuild/screen/errorCode/
//    deviceType)만 남고, 나머지는 서버가 조용히 걸러낸다("전체
//    저장목록·정밀 GPS·결제정보 기본 미수집"을 구조로 보장).
// =====================================================================
const acc1 = directAccount('fb1@example.com');
const r2 = submitFeedback({
  accountId: acc1,
  type: 'import',
  description: 'ZIP 가져오기가 중간에 멈춰요',
  contact: 'fb1@example.com',
  diagnostic: { appBuild: 'r9-12', screen: '가져오기', deviceType: 'iOS', savedPlacesList: ['비밀 장소1', '비밀 장소2'], preciseGps: { lat: 33.1, lng: 130.1 } },
});
t('2) 정상 제출은 성공함', r2.ok === true);
const list2 = adminListFeedback({});
const item2 = list2.items.find((x) => x.id === r2.id);
t('2) 허용된 진단 키(appBuild/screen/deviceType)는 그대로 저장됨', item2.diagnostic.appBuild === 'r9-12' && item2.diagnostic.screen === '가져오기' && item2.diagnostic.deviceType === 'iOS');
t('2) 화이트리스트 밖의 키(savedPlacesList/preciseGps)는 서버가 저장 자체를 안 함', item2.diagnostic.savedPlacesList === undefined && item2.diagnostic.preciseGps === undefined);
t('2) 기본 상태는 "받음"', item2.status === 'received');

// =====================================================================
// 3) 계정당/IP당 하루 한도 — 남용 방지(제한 자체는 무료 DB 쓰기라
//    비용 위험은 없지만, 하루 한 번 훑어보는 운영 전제상 스팸 방지용).
// =====================================================================
submitFeedback({ accountId: acc1, type: 'other', description: '두 번째' });
const overLimit = submitFeedback({ accountId: acc1, type: 'other', description: '세 번째(한도 초과)' });
t('3) 계정당 하루 한도를 넘으면 거절됨', overLimit.ok === false && overLimit.reason === 'account-daily-limit-reached');

const ip = '203.0.113.5';
submitFeedback({ type: 'other', description: '익명1' }, ip);
submitFeedback({ type: 'other', description: '익명2' }, ip);
submitFeedback({ type: 'other', description: '익명3' }, ip);
const ipOverLimit = submitFeedback({ type: 'other', description: '익명4(한도 초과)' }, ip);
t('3) 로그인 없는 익명 제출도 IP 기준 하루 한도가 걸림', ipOverLimit.ok === false && ipOverLimit.reason === 'ip-daily-limit-reached');

// =====================================================================
// 4) 코스 생성 직후 설문 — 로그인 필수, type='survey_usage'로 저장되고
//    일반 제출 화이트리스트(ALLOWED_FEEDBACK_TYPES)에는 안 보인다.
// =====================================================================
const surveyNoAuth = submitUsageSurvey({ tripId: 't1', actuallyTraveled: true, biggestBlocker: '없음' });
t('4) 로그인 없이는 설문 제출이 거절됨', surveyNoAuth.ok === false && surveyNoAuth.reason === 'unauthorized');
const surveyOk = submitUsageSurvey({ accountId: acc1, tripId: 'trip-abc', actuallyTraveled: true, biggestBlocker: '이동 시간이 예상보다 길었어요' });
t('4) 로그인 상태에서는 설문 제출이 성공함', surveyOk.ok === true);
const listSurvey = adminListFeedback({ type: 'survey_usage' });
t('4) 설문은 survey_usage 유형으로 저장돼 일반 접수와 구분됨', listSurvey.items.some((x) => x.id === surveyOk.id && x.type === 'survey_usage'));

// =====================================================================
// 5) 관리자 목록/상태 변경 — 유형별 개수 집계, 상태 전이.
// =====================================================================
const listAll = adminListFeedback({});
t('5) 유형별 개수가 실제로 집계됨', listAll.typeCounts.import >= 1 && listAll.typeCounts.survey_usage >= 1);
const upd = adminUpdateFeedbackStatus(r2.id, 'in_progress');
t('5) 상태를 처리 중으로 바꿀 수 있음', upd.ok === true);
const afterUpd = adminListFeedback({ status: 'in_progress' });
t('5) 상태 필터로 조회하면 실제로 바뀐 항목이 보임', afterUpd.items.some((x) => x.id === r2.id));
const badStatus = adminUpdateFeedbackStatus(r2.id, 'not-a-status');
t('5) 허용 안 된 상태값은 거절됨', badStatus.ok === false && badStatus.reason === 'invalid-status');
const missingId = adminUpdateFeedbackStatus('no-such-id', 'resolved');
t('5) 없는 id는 404로 정직하게 거절됨', missingId.ok === false && missingId.status === 404);

// =====================================================================
// 6) 관리자 API 인증 — ADMIN_TOKEN 없이는 401, 맞는 토큰이면 200.
//    (ADMIN_TOKEN 자체가 비어 있을 때 501이 되는 경로는 이 프로세스가
//    이미 토큰을 설정해 버려서 여기서는 재현할 수 없다 — config.mjs가
//    프로세스당 1회만 읽히는 싱글턴이기 때문. requireAdmin의 그 분기는
//    코드 리뷰로 확인: config.adminToken이 falsy면 401보다 먼저 501을
//    돌려주고 토큰 비교 자체를 안 한다.)
// =====================================================================
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const noAuth = await fetch(`${base}/api/admin/feedback`);
t('6) 토큰 없이 관리자 API를 부르면 401', noAuth.status === 401);
const wrongAuth = await fetch(`${base}/api/admin/feedback`, { headers: { Authorization: 'Bearer wrong-token' } });
t('6) 틀린 토큰이면 401', wrongAuth.status === 401);
const rightAuth = await fetch(`${base}/api/admin/feedback`, { headers: { Authorization: 'Bearer test-admin-token-not-for-production' } });
t('6) 올바른 토큰이면 200', rightAuth.status === 200);

// 공개 피드백 엔드포인트 — 로그인 없이도 실제로 접수된다(HTTP 전체 경로).
const publicSubmit = await fetch(`${base}/api/feedback`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'usage', description: 'HTTP 경로로 실제 접수 확인' }),
});
const publicJson = await publicSubmit.json();
t('7) 로그인 없이도 /api/feedback로 실제 접수됨(HTTP 전체 경로)', publicSubmit.status === 200 && publicJson.ok === true);

server.close();

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
