'use strict';
/**
 * 2026-09-11 재검토(13차) 2절 — Google 로그인 검증:
 *  1) 실제 RS256 서명·클레임 검증이 진짜로 동작함(가짜 JWKS를 주입해
 *     네트워크 없이도 실제 검증 로직 그대로 통과/거절을 확인).
 *  2) "이메일 문자열만 보고 합치지 않는다" — Google이 서명·검증한
 *     email_verified:true인 이메일만 계정 연결에 쓰이고, 그 반대(서명
 *     위조·audience 불일치·미검증 이메일)는 전부 거절됨.
 *  3) 같은 이메일로 이미 있는 계정(이메일 코드 로그인으로 만든)과
 *     Google 로그인이 실제로 같은 accountId로 이어짐 — 로그인 방식이
 *     바뀌어도 무료체험/이용권 등 계정별 상태가 그대로 유지됨.
 *  4) GOOGLE_CLIENT_ID가 없으면 서비스 자체가 정직하게 unavailable임
 *     (가짜로 통과시키지 않음).
 *
 * 실행: node server/test/google-auth.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.GOOGLE_CLIENT_ID = 'test-client-id-1234.apps.googleusercontent.com';

import crypto from 'node:crypto';

const { config, buildConfig } = await import('../config.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { googleSignIn, verifyLoginCode, requestLoginCode } = await import('../auth.mjs');
const { sentEmailsForTest } = await import('../adapters/email.mjs');
const { verifyGoogleIdToken } = await import('../adapters/google-auth.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

// 실제 RSA 키 쌍을 만들어 Google의 JWKS를 흉내낸다 — 네트워크 없이도
// verifyGoogleIdToken의 실제 서명 검증 코드 경로를 그대로 통과시킨다.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'test-kid-1';
jwk.alg = 'RS256';
jwk.use = 'sig';
const fetchJwks = async () => ({ keys: [jwk] });

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signIdToken(payloadOverrides, opts) {
  opts = opts || {};
  const header = { alg: 'RS256', kid: opts.kid || 'test-kid-1', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://accounts.google.com',
    aud: config.googleAuth.clientId,
    sub: '1234567890',
    email: 'user@example.com',
    email_verified: true,
    name: '테스트유저',
    iat: nowSec,
    exp: nowSec + 3600,
    ...payloadOverrides,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput); signer.end();
  const sig = signer.sign(privateKey);
  return `${signingInput}.${base64url(sig)}`;
}

// =====================================================================
// 1) 실제 서명·클레임 검증 — 정상 토큰은 통과, 각 위조/불일치는 거절.
// =====================================================================
{
  const good = signIdToken({ email: 'verify-good@example.com' });
  const r = await verifyGoogleIdToken(good, { fetchJwks });
  t('1) 정상 서명된 토큰은 실제로 검증을 통과함', r.ok === true && r.email === 'verify-good@example.com');

  // 서명 이후 payload를 조작(위조) — 서명이 그 내용과 안 맞아야 한다.
  const tampered = good.split('.');
  const tamperedPayload = base64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: config.googleAuth.clientId, sub: 'x', email: 'attacker@example.com', email_verified: true, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));
  const forged = `${tampered[0]}.${tamperedPayload}.${tampered[2]}`;
  const rForged = await verifyGoogleIdToken(forged, { fetchJwks });
  t('1) payload를 조작하면 서명 검증에서 실제로 걸림(공격자 이메일로 위조 실패)', rForged.ok === false && rForged.reason === 'invalid-signature');

  const wrongAud = signIdToken({ aud: 'completely-different-client-id' });
  const rWrongAud = await verifyGoogleIdToken(wrongAud, { fetchJwks });
  t('1) audience(클라이언트 ID)가 다르면 거절됨(다른 앱용 토큰 재사용 방지)', rWrongAud.ok === false && rWrongAud.reason === 'invalid-audience');

  const expired = signIdToken({ exp: Math.floor(Date.now() / 1000) - 10 });
  const rExpired = await verifyGoogleIdToken(expired, { fetchJwks });
  t('1) 만료된 토큰은 거절됨', rExpired.ok === false && rExpired.reason === 'expired');

  const wrongIss = signIdToken({ iss: 'https://evil.example.com' });
  const rWrongIss = await verifyGoogleIdToken(wrongIss, { fetchJwks });
  t('1) 발급자(iss)가 Google이 아니면 거절됨', rWrongIss.ok === false && rWrongIss.reason === 'invalid-issuer');

  const notVerified = signIdToken({ email_verified: false });
  const rNotVerified = await verifyGoogleIdToken(notVerified, { fetchJwks });
  t('1) Google 자신도 이메일 소유권을 확인 못 했으면(email_verified:false) 거절됨', rNotVerified.ok === false && rNotVerified.reason === 'email-not-verified');

  const unknownKid = signIdToken({}, { kid: 'nonexistent-kid' });
  const rUnknownKid = await verifyGoogleIdToken(unknownKid, { fetchJwks });
  t('1) JWKS에 없는 kid는 거절됨', rUnknownKid.ok === false && rUnknownKid.reason === 'unknown-key');

  // 2026-09-11 재검토(14차) 2절 — sub가 없는 토큰은(정상적인 Google
  // ID 토큰이라면 있을 수 없지만) 계정 연결의 기본 키가 없다는
  // 뜻이므로 여기서부터 거절돼야 한다.
  const noSub = signIdToken({ sub: undefined });
  const rNoSub = await verifyGoogleIdToken(noSub, { fetchJwks });
  t('1) sub가 없는 토큰은 거절됨(missing-subject)', rNoSub.ok === false && rNoSub.reason === 'missing-subject');

  const withHd = signIdToken({ hd: 'company.example.com' });
  const rWithHd = await verifyGoogleIdToken(withHd, { fetchJwks });
  t('1) hd(Workspace 도메인) 클레임이 실려 오면 그대로 반환됨', rWithHd.ok === true && rWithHd.hd === 'company.example.com');
  const withoutHd = signIdToken({ email: 'gmail-user@example.com' });
  const rWithoutHd = await verifyGoogleIdToken(withoutHd, { fetchJwks });
  t('1) hd가 없으면 null로 반환됨(개인 계정)', rWithoutHd.ok === true && rWithoutHd.hd === null);
}

// =====================================================================
// 2) 신규 계정 생성 — Google 로그인만으로 첫 로그인하면 새 계정이 실제로
//    만들어지고, 같은 이메일로 다시 로그인하면 같은 계정으로 이어짐
//    (새 계정을 또 만들지 않음).
// =====================================================================
{
  const idToken = signIdToken({ email: 'google-newacc@example.com', sub: 'sub-newacc' });
  const r1 = await googleSignIn(idToken, undefined, { fetchJwks });
  t('2) 첫 Google 로그인은 실제로 새 계정을 만듦', r1.ok === true && r1.isNew === true && !!r1.accountId);

  const idToken2 = signIdToken({ email: 'google-newacc@example.com', sub: 'sub-newacc' });
  const r2 = await googleSignIn(idToken2, undefined, { fetchJwks });
  t('2) 같은 이메일로 다시 Google 로그인하면 같은 계정으로 이어짐(재가입 안 함)', r2.ok === true && r2.isNew === false && r2.accountId === r1.accountId);
  t('2) 각각 실제로 다른 세션 토큰을 받음(토큰 자체는 매번 새로 발급)', r1.token !== r2.token);
}

// =====================================================================
// 3) 로그인 방식이 바뀔 때 — ChatGPT 재현(14차 2절): owner@example.com
//    계정이 이미 있는 상태에서 같은 이메일에 email_verified:true·hd
//    없음·한 번도 못 본 sub인 Google 토큰을 보내면, 예전 코드는 추가
//    확인 없이 그 계정에 그대로 로그인시켰다(계정 탈취 경로). 이제는
//    소유확인(기존 세션 또는 이메일 코드) 없이는 거절돼야 하고, 확인을
//    거치면 새 계정을 만들지 않고 정확히 그 계정에 연결되며, 계정별
//    상태(무료체험/이용권 등)는 그대로 유지돼야 한다.
// =====================================================================
{
  const email = 'owner@example.com';
  // 이메일 코드 로그인으로 먼저 계정을 만든다(공격 시나리오의 "이미
  // 있는 계정").
  await requestLoginCode(email, '127.0.0.1');
  const sent = sentEmailsForTest.filter((e) => e.to === email).pop();
  const code = sent.body.match(/(\d{6})/)[1];
  const rEmailLogin = verifyLoginCode(email, code);
  t('3) 준비 확인 — 이메일 코드 로그인으로 계정이 실제로 만들어짐', rEmailLogin.ok === true && rEmailLogin.isNew === true);
  const emailAccountId = rEmailLogin.accountId;

  // 이 계정에 "이미 뭔가 상태가 있다"를 흉내내기 위해 직접 accounts
  // 테이블에 값을 하나 심어 둔다(무료체험 소진 여부 대용 — 실제 스키마
  // 필드가 뭐든 "계정 식별자가 같다"는 사실 하나로 모든 계정별 상태가
  // 자동으로 이어진다는 게 이 검증의 핵심이다).
  const db = openDb();
  const marker = 'cross-method-marker-' + uuid();
  db.prepare('UPDATE accounts SET plan = ? WHERE id = ?').run(marker, emailAccountId);

  // 3-a) 공격 재현 — 소유확인 없이 같은 이메일·새 sub로 Google 로그인
  // 시도하면 반드시 거절돼야 한다(예전 코드는 여기서 그냥 성공했음).
  const attackToken = signIdToken({ email, sub: 'sub-attacker-unverified', hd: undefined });
  const rAttack = await googleSignIn(attackToken, undefined, { fetchJwks });
  t('3-a) 소유확인 없이 기존 계정과 같은 이메일로 Google 로그인하면 거절됨(계정 탈취 재현 차단)', rAttack.ok === false && rAttack.reason === 'ownership-verification-required');
  t('3-a) 거절 상태코드는 충돌(409)', rAttack.status === 409);
  const stillMarker = db.prepare('SELECT plan FROM accounts WHERE id = ?').get(emailAccountId);
  t('3-a) 거절된 시도는 기존 계정 상태를 전혀 건드리지 않음', stillMarker.plan === marker);
  const notLinked = db.prepare('SELECT sub FROM google_identities WHERE sub = ?').get('sub-attacker-unverified');
  t('3-a) 거절된 sub는 연결 표에도 남지 않음', !notLinked);

  // 3-b) 소유확인(기존 세션) 제공 — 이메일 코드 로그인 때 받은 세션
  // 토큰을 같이 보내면, 그 세션이 진짜 이 계정 소유자임을 증명하므로
  // 새 계정을 만들지 않고 정확히 이 계정에 연결돼야 한다.
  const idTokenWithSession = signIdToken({ email, sub: 'sub-owner-via-session' });
  const rWithSession = await googleSignIn(idTokenWithSession, undefined, { fetchJwks, sessionToken: rEmailLogin.token });
  t('3-b) 기존 로그인 세션으로 소유확인하면 새 계정 없이 기존 계정에 연결됨', rWithSession.ok === true && rWithSession.isNew === false && rWithSession.accountId === emailAccountId);

  const afterSessionLink = db.prepare('SELECT plan FROM accounts WHERE id = ?').get(emailAccountId);
  t('3-b) 계정별 상태(무료체험/이용권 등)가 로그인 방식이 바뀌어도 그대로 유지됨', afterSessionLink.plan === marker);

  // 3-c) 같은 sub로 다시 로그인하면(이미 연결됨) 추가 확인 없이 바로
  // 통과해야 한다 — "최초 연결 때만 확인, 그 뒤엔 반복 요구 금지".
  const idTokenAgain = signIdToken({ email, sub: 'sub-owner-via-session' });
  const rAgain = await googleSignIn(idTokenAgain, undefined, { fetchJwks });
  t('3-c) 이미 연결된 sub는 소유확인 없이 바로 로그인됨(반복 인증 요구 안 함)', rAgain.ok === true && rAgain.accountId === emailAccountId);

  // 3-d) 소유확인(이메일 코드) 제공 — 다른 계정에서, 세션 대신 방금
  // 받은 이메일 로그인 코드로도 소유확인이 되는지 확인한다.
  const email2 = 'owner2@example.com';
  await requestLoginCode(email2, '127.0.0.2');
  const sent2a = sentEmailsForTest.filter((e) => e.to === email2).pop();
  const code2a = sent2a.body.match(/(\d{6})/)[1];
  const rEmailLogin2 = verifyLoginCode(email2, code2a);
  const email2AccountId = rEmailLogin2.accountId;

  // 소유확인용 두 번째 코드 — requestLoginCode를 또 부르면 방금 막
  // 쓴 쿨다운(loginCodeCooldownSeconds)에 걸리므로, 실제 발송 경로가
  // 아니라 코드 검증 로직 자체만 확인하려는 이 테스트에서는 코드 행을
  // 직접 심는다(쿨다운은 requestLoginCode 자체의 별도 테스트에서 이미
  // 다룸 — 여기서 다시 검증하지 않음).
  const code2b = '918273';
  db.prepare('INSERT INTO login_codes (email, code, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)')
    .run(email2, code2b, nowIso(), new Date(Date.now() + 600000).toISOString());
  const idTokenWithCode = signIdToken({ email: email2, sub: 'sub-owner2-via-emailcode' });
  const rWithCode = await googleSignIn(idTokenWithCode, undefined, { fetchJwks, emailCode: code2b });
  t('3-d) 이메일 로그인 코드로도 소유확인이 되어 기존 계정에 연결됨', rWithCode.ok === true && rWithCode.isNew === false && rWithCode.accountId === email2AccountId);
}

// =====================================================================
// 4) GOOGLE_CLIENT_ID가 설정 안 됐으면 정직하게 unavailable — 가짜로
//    통과시키지 않는다.
// =====================================================================
{
  const cfgWithoutClientId = buildConfig({ APP_ENV: 'development', DB_PATH: ':memory:' });
  t('4) 클라이언트 ID가 없으면 googleAuth 서비스가 unavailable로 표시됨', cfgWithoutClientId.services.googleAuth === 'unavailable');

  const cfgProdWithout = buildConfig({ APP_ENV: 'production', DB_PATH: ':memory:' });
  t('4) 운영 환경에서도 클라이언트 ID가 없으면 서버 시작 자체는 막지 않되(부가 기능) 정직하게 unavailable임', cfgProdWithout.services.googleAuth === 'unavailable');
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
