'use strict';
/**
 * Google Identity Services ID 토큰 검증(2026-09-11 재검토 13차 2절).
 *
 * 설계 원칙 — "클라 시크릿을 아예 안 쓴다": Google Identity Services가
 * 브라우저에서 직접 발급하는 ID 토큰(JWT, RS256)을 서버가 Google의
 * 공개 JWKS(https://www.googleapis.com/oauth2/v3/certs)로 서명을
 * 직접 검증한다. 인가 코드를 서버가 클라 시크릿으로 토큰과 교환하는
 * 방식이 아니므로, 이 서버 어디에도 "노출되면 안 되는 Google 비밀값"이
 * 존재하지 않는다 — GOOGLE_CLIENT_ID(공개 식별자)만 있으면 된다.
 *
 * 검증 항목(모두 통과해야 ok:true):
 *  - 서명이 실제로 유효함(RS256, JWKS의 kid로 찾은 공개키로 직접 검증).
 *  - exp가 지나지 않음, iat이 미래가 아님(약간의 시계 오차 허용).
 *  - iss가 Google이 실제로 쓰는 값 중 하나.
 *  - aud가 이 서버에 설정된 GOOGLE_CLIENT_ID와 정확히 일치함(다른 앱용
 *    토큰을 그대로 받아주는 사고 방지).
 *  - email_verified가 실제로 true(Google 자신도 확인 못 한 이메일은
 *    "소유권 증거"로 못 쓴다).
 *
 * 테스트 용이성 — fetchJwks를 주입할 수 있게 해서, 실제 네트워크 없이
 * 자체 서명한 테스트 토큰 + 테스트 JWKS로 이 파일의 실제 검증 로직을
 * 그대로(가짜 경로가 아니라) 검증할 수 있다.
 */
import crypto from 'node:crypto';
import { config } from '../config.mjs';

function base64UrlDecode(str) {
  str = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

async function fetchGoogleJwks() {
  const res = await fetch(config.googleAuth.jwksUri);
  if (!res.ok) throw new Error('jwks-fetch-failed:' + res.status);
  return res.json();
}

// Google은 키를 자주 바꾸지 않는다 — 로그인마다 매번 JWKS를 새로 받아오면
// 불필요한 외부 호출이 쌓인다(무료 엔드포인트라 비용은 없지만, weather.mjs
// 등과 같은 원칙으로 자연 갱신 주기를 감안해 캐시한다).
let cachedJwks = null;
let cachedJwksAt = 0;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

async function getJwks(fetchJwksOverride) {
  if (fetchJwksOverride) return fetchJwksOverride(); // 테스트 — 캐시를 거치지 않고 매번 주입된 값을 그대로 쓴다.
  const now = Date.now();
  if (cachedJwks && (now - cachedJwksAt) < JWKS_CACHE_TTL_MS) return cachedJwks;
  cachedJwks = await fetchGoogleJwks();
  cachedJwksAt = now;
  return cachedJwks;
}

export function resetJwksCacheForTest() { cachedJwks = null; cachedJwksAt = 0; }

/* idToken을 검증하고, 통과하면 { ok:true, email, sub, name, picture }를
   돌려준다. opts.fetchJwks(테스트 전용), opts.clientId/opts.issuers(테스트
   전용 — 기본은 config.googleAuth를 그대로 씀)로 오버라이드할 수 있다. */
export async function verifyGoogleIdToken(idToken, opts) {
  opts = opts || {};
  if (!idToken || typeof idToken !== 'string') return { ok: false, reason: 'missing-token' };
  const parts = idToken.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed-token' };

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'malformed-token' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported-alg' };

  let jwks;
  try { jwks = await getJwks(opts.fetchJwks); }
  catch (e) { return { ok: false, reason: 'jwks-unavailable' }; }
  if (!jwks || !Array.isArray(jwks.keys)) return { ok: false, reason: 'jwks-unavailable' };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown-key' };

  let publicKey;
  try { publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' }); }
  catch (e) { return { ok: false, reason: 'invalid-key' }; }

  const signedPart = `${parts[0]}.${parts[1]}`;
  let validSig = false;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signedPart);
    verifier.end();
    validSig = verifier.verify(publicKey, base64UrlDecode(parts[2]));
  } catch (e) { validSig = false; }
  if (!validSig) return { ok: false, reason: 'invalid-signature' };

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return { ok: false, reason: 'expired' };
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 60) return { ok: false, reason: 'invalid-iat' };

  const expectedIssuers = opts.issuers || config.googleAuth.issuers;
  if (!expectedIssuers.includes(payload.iss)) return { ok: false, reason: 'invalid-issuer' };

  const expectedAud = opts.clientId || config.googleAuth.clientId;
  if (!expectedAud || payload.aud !== expectedAud) return { ok: false, reason: 'invalid-audience' };

  // "이메일 문자열만 보고 계정을 합치지 않는다"의 핵심 조건 — Google
  // 자신도 이 이메일 소유권을 확인 못 했으면(email_verified:false)
  // 계정 연결의 증거로 쓰지 않는다.
  if (!payload.email || payload.email_verified !== true) return { ok: false, reason: 'email-not-verified' };

  return {
    ok: true,
    email: String(payload.email).trim().toLowerCase(),
    sub: String(payload.sub || ''),
    name: String(payload.name || '').slice(0, 200),
    picture: String(payload.picture || '').slice(0, 500),
  };
}
