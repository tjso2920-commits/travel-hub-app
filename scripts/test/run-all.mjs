/**
 * 전체 검사 실행기.
 * 각 검사는 개인용과 판매용 두 파일에 대해 각각 돌린다.
 * 하나라도 실패하면 0이 아닌 코드로 종료한다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TARGETS = [
  ['개인용', 'private/personal.html'],
  ['판매용', 'src/index.html']
];

const files = readdirSync(HERE)
  .filter((f) => /^t\d+\.mjs$/.test(f))
  .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));

let failed = 0;
for (const [label, target] of TARGETS) {
  console.log(`\n=== ${label} (${target}) ===`);
  for (const f of files) {
    const head = readFileSync(path.join(HERE, f), 'utf8').slice(0, 40);
    const only = /^\/\/ TARGET: (personal|sales)/.exec(head);
    // 개인용 전용·판매용 전용 검사는 해당 대상에서만 돌린다
    if (only && ((only[1] === 'personal') !== (label === '개인용'))) {
      console.log(`  SKIP  ${f.padEnd(9)} ${only[1]} 전용`);
      continue;
    }
    const r = spawnSync(process.execPath, [path.join('scripts/test', f), target], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    const out = (r.stdout || '').trim().split('\n');
    const last = out[out.length - 1] || '';
    const ok = r.status === 0;
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(9)} ${last}`);
    if (!ok) {
      out.filter((l) => l.startsWith('FAIL')).forEach((l) => console.log(`        ${l}`));
      if (r.stderr) console.log(`        ${r.stderr.trim().split('\n').slice(0, 3).join('\n        ')}`);
    }
  }
}

console.log(failed ? `\n실패 ${failed}건` : '\n전체 통과');
process.exit(failed ? 1 : 0);
