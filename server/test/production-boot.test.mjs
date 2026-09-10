'use strict';
/**
 * "명시적인 development/test/production 환경을 도입하고 production에서는
 * 키가 없는 기능을 unavailable로 처리하거나 필수 설정 누락으로 시작을
 * 거부하라"는 지시의 검증. buildConfig/assertBootReady는 순수 함수라
 * 여러 조합을 프로세스 재시작 없이 바로 검증할 수 있고(config.test.mjs와
 * 같은 방식), 실제로 index.mjs가 그 판정을 부팅 시점에 쓰는지는 자식
 * 프로세스를 하나 띄워 종료 코드까지 확인한다(로직만 맞고 실제로 안
 * 불러 쓰면 소용없다).
 * 실행: node server/test/production-boot.test.mjs
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { buildConfig, assertBootReady } = await import('../config.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

// --- 순수 함수 조합 검증 ---
{
  const r = assertBootReady(buildConfig({ APP_ENV: 'production' }));
  t('운영인데 필수 설정이 전혀 없으면 부팅 거부', r.ok === false && r.missing.length >= 3);
}
{
  const cfg = buildConfig({ APP_ENV: 'production', PAYMENT_PG_SECRET: 'x', TOSS_CLIENT_KEY: 'y', EMAIL_API_KEY: 'z' });
  const r = assertBootReady(cfg);
  t('결제·이메일은 갖췄지만 웹훅 시크릿이 기본값이면 여전히 거부', r.ok === false && r.missing.some((m) => m.includes('PAYMENT_WEBHOOK_SECRET')));
}
{
  const cfg = buildConfig({ APP_ENV: 'production', PAYMENT_PG_SECRET: 'x', TOSS_CLIENT_KEY: 'y', EMAIL_API_KEY: 'z', PAYMENT_WEBHOOK_SECRET: 'a-real-secret-value' });
  const r = assertBootReady(cfg);
  t('결제·이메일·웹훅 시크릿을 전부 갖추면 부팅 허용', r.ok === true);
  t('운영에서 장소조회 키가 없으면 unavailable(부팅은 안 막음 — 정직한 기능 제한만)', cfg.services.placeLookup === 'unavailable');
  t('운영에서 도보경로 키가 없으면 unavailable(추정으로 정직하게 대체 — 부팅은 안 막음)', cfg.services.routing === 'unavailable');
}
{
  const cfg = buildConfig({ APP_ENV: 'development' });
  const r = assertBootReady(cfg);
  t('개발 환경에서는 부팅 거부 로직이 아예 적용 안 됨(로컬 편의 유지)', r.ok === true);
}

// --- 실제 index.mjs가 이 판정을 부팅 시점에 쓰는지(자식 프로세스) ---
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const indexPath = path.join(here, '..', 'index.mjs');
  let exitCode = 0, stderr = '';
  try {
    execFileSync('node', [indexPath], {
      env: { ...process.env, APP_ENV: 'production', DB_PATH: ':memory:', PORT: '0', GOOGLE_PLACES_API_KEY: '', PAYMENT_PG_SECRET: '', EMAIL_API_KEY: '' },
      timeout: 5000,
    });
  } catch (e) {
    exitCode = e.status;
    stderr = String(e.stderr || '');
  }
  t('실제로 production 환경변수로 서버를 띄우면 필수 설정 없이는 종료코드 1로 즉시 종료됨', exitCode === 1);
  t('거부 사유를 표준에러에 남김', stderr.includes('서버 시작 거부'));
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
