/**
 * 내 PC에서 한 번에 켜기 — 2026-09-22(18차) 9절.
 *
 * 하는 일:
 *  1) Node 버전 확인 — 최소 22.16(서버가 쓰는 node:sqlite와 그 백업 기능이
 *     플래그 없이 되는 버전). 권장은 최신 LTS인 24. 이 저장소의 테스트는
 *     2026-09-22 세션에서 Node 22.22.2로 돌렸다(24에서의 실행은 미검증).
 *  2) 이 폴더의 local.env(있으면)에서 설정을 읽는다. 비밀키는 화면에
 *     찍지 않는다(이름만 "있음/없음"으로 보여 줌). local.env는 저장소·ZIP에
 *     절대 안 들어간다(.gitignore). 예시는 .env.example.
 *  3) 기본값: 개발 모드, 화면+API 한 주소(SERVE_STATIC), 이 PC 안에서만 열기
 *     (HOST=127.0.0.1), DB는 사용자 폴더의 travelhub/travelhub.db.
 *  4) 켜기 전에 기존 DB가 있으면 백업부터 한다(최근 10개만 남김). 기존 DB를
 *     지우거나 덮어쓰지 않는다.
 *  5) 서버를 켜고 접속 주소를 알려 준다. 끄려면 이 창에서 Ctrl+C.
 *
 * 실행: node scripts/start-local.mjs   (Windows는 start-windows.cmd 더블클릭)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 16)) {
  console.error(`Node.js ${process.versions.node}가 설치돼 있어요. 22.16 이상이 필요합니다(권장: 24 LTS).`);
  console.error('https://nodejs.org 에서 "24 LTS" 설치 파일을 받아 설치한 뒤 다시 실행해 주세요.');
  process.exit(1);
}

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else { const hash = val.search(/\s#/); if (hash >= 0) val = val.slice(0, hash).trim(); } // 값 뒤 "# 설명"은 떼어 낸다.
    if (val !== '') out[key] = val;
  }
  return out;
}

const fileEnv = readEnvFile(path.join(ROOT, 'local.env'));
const dataDir = path.join(os.homedir(), 'travelhub');
const env = {
  APP_ENV: 'development',
  SERVE_STATIC: 'true',
  HOST: '127.0.0.1',
  PORT: '8787',
  DB_PATH: path.join(dataDir, 'travelhub.db'),
  ...fileEnv,
};
// 창에서 직접 준 값(set PORT=... 등)이 있으면 그게 우선이다.
for (const k of ['APP_ENV', 'SERVE_STATIC', 'HOST', 'PORT', 'DB_PATH']) if (process.env[k]) env[k] = process.env[k];

if (env.APP_ENV === 'production') {
  console.error('이 스크립트는 내 PC 테스트용입니다. APP_ENV=production으로는 켜지 않습니다(운영 배포는 docs/OPERATIONS_SETUP.md).');
  process.exit(1);
}

// 기존 DB 백업(있을 때만) — 지우거나 덮어쓰지 않는다.
fs.mkdirSync(path.dirname(env.DB_PATH), { recursive: true });
if (fs.existsSync(env.DB_PATH) && fs.statSync(env.DB_PATH).size > 0) {
  const { DatabaseSync, backup } = await import('node:sqlite');
  const dir = path.join(path.dirname(env.DB_PATH), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(env.DB_PATH, '.db')}-${stamp}.db`);
  const src = new DatabaseSync(env.DB_PATH);
  await backup(src, dest);
  src.close();
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 10))) fs.unlinkSync(path.join(dir, old));
  console.log(`기존 데이터 백업: ${dest}`);
}

const SECRET_KEYS = ['GOOGLE_PLACES_API_KEY', 'GOOGLE_ROUTES_API_KEY', 'PAYMENT_PG_SECRET', 'TOSS_CLIENT_KEY', 'EMAIL_API_KEY', 'WEATHER_API_KEY', 'ANTHROPIC_API_KEY', 'ADMIN_TOKEN', 'PAYMENT_WEBHOOK_SECRET', 'GOOGLE_CLIENT_ID'];
console.log('\n설정:');
console.log(`  모드: ${env.APP_ENV} (개발 모드 — 인터넷에 공개하지 마세요)`);
console.log(`  데이터 파일: ${env.DB_PATH}`);
console.log(`  열린 주소: ${env.HOST === '127.0.0.1' ? '이 PC 안에서만' : env.HOST + ' (같은 와이파이의 폰에서도 접속 가능)'}`);
console.log('  연결된 키: ' + SECRET_KEYS.map((k) => `${k}=${env[k] ? '있음' : '없음'}`).join(', '));
if (env.HOST !== '127.0.0.1') {
  console.log('\n  주의: 개발 모드에는 테스트용 결제 흉내·가짜 로그인 코드 기록 같은 기능이 켜져 있습니다.');
  console.log('  공유기 포트 열기·외부 공개 터널로 인터넷에 내보내지 마세요. 같은 와이파이 안에서만 쓰세요.');
}

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.on('data', (d) => {
  const text = String(d);
  process.stdout.write(text);
  if (text.includes('서버 시작')) {
    console.log(`\n브라우저에서 여세요: http://localhost:${env.PORT}/   (새 앱 화면으로 이동합니다)`);
    console.log('끄려면 이 창에서 Ctrl+C 를 누르세요.\n');
  }
});
const stop = () => { child.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code || 0));
