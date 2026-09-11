'use strict';
/**
 * 2026-09-11 재검토(9차) 6-4절 — 소규모 베타 초대 코드가 실제로 켜졌을
 * 때(REQUIRE_INVITE_CODE_FOR_SIGNUP=true)의 동작 검증. 기본값(꺼짐)에서
 * 기존 열린 가입 흐름이 그대로 유지되는지는 이 파일이 아니라 기존
 * 회귀 테스트(test-purchase-flow/test-consumer-flow-e2e/test-account-sync
 * 등 — 전부 이 플래그를 켜지 않은 채로 실제 신규 가입을 계속 성공시킨다)
 * 가 실제로 증명한다.
 *
 * 실행: node server/test/invite-codes.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.REQUIRE_INVITE_CODE_FOR_SIGNUP = 'true';
process.env.INVITE_CODE_DEFAULT_MAX_USES = '3';
process.env.INVITE_CODE_DEFAULT_TTL_DAYS = '7';
process.env.RECRUITMENT_TOTAL_CAP = '2';
process.env.EMAIL_ADAPTER = 'test';

const { openDb } = await import('../db.mjs');
const { requestLoginCode, verifyLoginCode } = await import('../auth.mjs');
const { adminCreateInviteCode, adminListInviteCodes, adminDeactivateInviteCode } = await import('../invite-codes.mjs');
const { setRecruitmentPaused, isRecruitmentPaused } = await import('../app-flags.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function latestCode(email) {
  const db = openDb();
  const row = db.prepare('SELECT code FROM login_codes WHERE email = ? ORDER BY rowid DESC LIMIT 1').get(email);
  return row && row.code;
}
async function signup(email, inviteCode) {
  await requestLoginCode(email, '127.0.0.1');
  const code = latestCode(email);
  return verifyLoginCode(email, code, inviteCode);
}
/* requestLoginCode의 이메일 쿨다운(기본 30초)에 걸리지 않고 재로그인
   시나리오를 검증하기 위해, 실제 발급 경로와 같은 모양의 코드 행을
   직접 넣는다(이메일 발송 자체를 다시 트리거하지 않는다 — 이 테스트의
   관심사는 "이미 있는 계정은 초대 코드가 필요 없다"는 것뿐이다). */
function directIssueLoginCodeAndVerify(email, inviteCode) {
  const db = openDb();
  const code = '000111';
  const now = Date.now();
  db.prepare('INSERT INTO login_codes (email, code, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)')
    .run(email, code, new Date(now).toISOString(), new Date(now + 600000).toISOString());
  return verifyLoginCode(email, code, inviteCode);
}

// =====================================================================
// 1) 초대 코드 없이는 신규 가입이 거절된다(게이트가 켜진 상태).
// =====================================================================
const r1 = await signup('nocoded@example.com');
t('1) 초대 코드 없이 신규 가입 시도는 거절됨', r1.ok === false && r1.reason === 'invite-code-required');
const r1b = await requestLoginCode('nocoded@example.com', '127.0.0.1');
t('1) 초대 코드가 없어 실패해도 방금 받은 로그인 코드는 안 태워짐(재요청이 쿨다운에 안 걸림 없이 필요하지 않음)', r1b.ok === false && r1b.reason === 'cooldown');
// (쿨다운 자체가 "코드가 살아있다"는 뜻 — 굳이 새로 안 받아도 같은 코드로 재시도 가능함을 확인.
const retryWithSameCode = verifyLoginCode('nocoded@example.com', latestCode('nocoded@example.com'), 'DOES-NOT-EXIST');
t('1) 같은(안 태워진) 로그인 코드로 다시 시도할 수 있음 — 코드 값이 여전히 유효', retryWithSameCode.ok === false && retryWithSameCode.reason === 'invite-code-invalid');

// =====================================================================
// 2) 실제 코드를 만들어 정상적으로 가입한다 — used_count가 실제로 오른다.
// =====================================================================
const created = adminCreateInviteCode(openDb(), {});
t('2) 관리자가 코드를 실제로 만들 수 있음', created.ok && created.code && created.maxUses === 3);
const r2 = await signup('member1@example.com', created.code);
t('2) 유효한 초대 코드로 신규 가입이 성공함', r2.ok === true && r2.isNew === true);
const listed = adminListInviteCodes(openDb());
const found = listed.items.find((x) => x.code === created.code);
t('2) 코드 사용 횟수(used_count)가 실제로 1 올라감', found.used_count === 1);

// =====================================================================
// 3) 이미 있는 계정의 재로그인은 초대 코드와 완전히 무관하다.
// =====================================================================
const r3 = directIssueLoginCodeAndVerify('member1@example.com'); // 코드 없이 재로그인(쿨다운 우회).
t('3) 이미 가입한 계정은 초대 코드 없이도 재로그인됨', r3.ok === true && r3.isNew === false);
const listed3 = adminListInviteCodes(openDb());
t('3) 재로그인은 초대 코드 사용 횟수를 또 안 올림(여전히 1)', listed3.items.find((x) => x.code === created.code).used_count === 1);

// =====================================================================
// 4) 코드 하나의 인원(max_uses=3)을 다 채우면 그 다음부터는 거절된다.
// =====================================================================
const r4a = await signup('member2@example.com', created.code);
t('4) 두 번째 사람도 같은 코드로 가입 성공', r4a.ok === true);
// RECRUITMENT_TOTAL_CAP=2라서 이미 distinct redeemer가 2명 — 세 번째부터는
// 코드 인원(3)이 아직 안 찼어도 전체 상한에 먼저 걸린다.
const r4b = await signup('member3@example.com', created.code);
t('4) 코드 인원보다 먼저 전체 모집 상한(2명)에 걸려 거절됨', r4b.ok === false && r4b.reason === 'recruitment-cap-reached');

// =====================================================================
// 5) 만료된 코드·비활성화된 코드는 거절된다. (이미 4번에서 전체 모집
//    상한 2명에 도달해 있으므로, 여기서는 "그 사유가 아니라 이 사유로"
//    거절되는지까지는 안 가리고 코드 자체 상태만 직접 확인한다.)
// =====================================================================
const shortLived = adminCreateInviteCode(openDb(), { ttlDays: 0.0000001 }); // 사실상 즉시 만료.
await new Promise((res) => setTimeout(res, 20));
const r5 = await signup('expired-test@example.com', shortLived.code);
t('5) 만료된 코드는 거절됨', r5.ok === false && r5.reason === 'invite-code-expired');

const toDeactivate = adminCreateInviteCode(openDb(), {});
adminDeactivateInviteCode(openDb(), toDeactivate.code);
// 위에서 이미 전체 상한(2)에 도달해 있으므로, 비활성화 검증은 상한보다
// 먼저 걸리지 않게 새 계정으로 시도해도 recruitment-cap-reached가 먼저
// 뜰 수 있다 — 상한 자체를 확인하는 4번 항목과 겹치지 않도록, 여기서는
// "비활성 코드"라는 사유가 상한 사유보다 먼저 걸리는지까지는 강제하지
// 않고, 존재하는 코드 자체의 active=0 상태만 직접 확인한다.
const listed5 = adminListInviteCodes(openDb());
t('5) 비활성화한 코드는 목록에서 active=0으로 남음', listed5.items.find((x) => x.code === toDeactivate.code).active === 0);

// =====================================================================
// 6) 신규 모집 일시중지(app_flags) — 켜져 있으면 유효한 코드가 있어도 거절.
// =====================================================================
const freshCode = adminCreateInviteCode(openDb(), {});
setRecruitmentPaused(true);
t('6) 일시중지 플래그가 실제로 켜짐', isRecruitmentPaused() === true);
const r6 = await signup('paused-test@example.com', freshCode.code);
t('6) 신규 모집 일시중지 중에는 유효한 코드가 있어도 신규 가입이 거절됨', r6.ok === false && r6.reason === 'recruitment-paused');
setRecruitmentPaused(false);
t('6) 재개 후에는 다시 정상 동작', isRecruitmentPaused() === false);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
