/**
 * server/test/*.test.mjs 전체를 하나씩(서로 간섭 없게 별도 프로세스로)
 * 돌리고 결과를 모아 보여 준다. 하나라도 실패하면 0이 아닌 코드로 끝난다.
 *
 * 실행: node scripts/run-server-tests.mjs   (npm run server-test-all)
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..', 'server', 'test');
const files = readdirSync(DIR).filter((f) => f.endsWith('.test.mjs')).sort();
const failed = [];
const started = Date.now();
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8', timeout: 180000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const fails = out.split('\n').filter((l) => /^FAIL /.test(l));
  // 종료 코드가 0이어도 FAIL 줄이 있으면 실패로 본다(스스로 exit 코드를 안 올리는 옛 테스트 대비).
  const ok = r.status === 0 && fails.length === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)${ok ? '' : ' — ' + (fails.slice(0, 3).join(' | ') || `exit ${r.status}${r.signal ? ' ' + r.signal : ''}`)}`);
  if (!ok) failed.push(f);
}
console.log(`\n${files.length - failed.length}/${files.length} 통과 (${((Date.now() - started) / 1000).toFixed(0)}초)`);
if (failed.length) { console.log('실패: ' + failed.join(', ')); process.exit(1); }
