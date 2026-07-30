/**
 * 전체 검사 실행기.
 * 각 검사는 개인용과 판매용 두 파일에 대해 각각 돌린다.
 * 하나라도 실패하면 0이 아닌 코드로 종료한다.
 *
 * 검사가 23종이 되면서 순차 실행이 3분을 넘었다(2026-07-30). 각 검사는 자기 JSDOM 창에서
 * 독립적으로 돌고 서로의 상태를 공유하지 않으므로 병렬로 돌려도 안전하다.
 * 다만 출력은 순서가 뒤섞이면 읽기 어려우므로, 실행만 병렬로 하고 결과는 원래 순서대로 모아 찍는다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TARGETS = [
  ['개인용', 'private/personal.html'],
  ['판매용', 'src/index.html']
];
/** JSDOM 검사는 CPU 를 많이 쓴다. 코어 수를 넘기면 오히려 느려지므로 상한을 둔다. */
const LIMIT = Math.max(2, Math.min(6, os.cpus().length));

const files = readdirSync(HERE)
  .filter((f) => /^t\d+\.mjs$/.test(f))
  .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));

function run(file, target) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('scripts/test', file), target], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** 동시에 LIMIT 개까지만 돌린다. */
async function pool(jobs) {
  const results = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(LIMIT, jobs.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

let failed = 0;
const started = Date.now();

for (const [label, target] of TARGETS) {
  console.log(`\n=== ${label} (${target}) ===`);

  // 이 대상에서 건너뛸 검사를 먼저 가려낸다 — 프로세스를 띄우지 않는다.
  const plan = files.map((f) => {
    const head = readFileSync(path.join(HERE, f), 'utf8').slice(0, 40);
    const only = /^\/\/ TARGET: (personal|sales)/.exec(head);
    const skip = only && ((only[1] === 'personal') !== (label === '개인용'));
    return { f, skip, only };
  });

  const results = await pool(
    plan.map(({ f, skip }) => () => (skip ? Promise.resolve(null) : run(f, target)))
  );

  plan.forEach(({ f, skip, only }, i) => {
    if (skip) {
      console.log(`  SKIP  ${f.padEnd(9)} ${only[1]} 전용`);
      return;
    }
    const r = results[i];
    const out = (r.stdout || '').trim().split('\n');
    const last = out[out.length - 1] || '';
    const ok = r.status === 0;
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(9)} ${last}`);
    if (!ok) {
      out.filter((l) => l.startsWith('FAIL')).forEach((l) => console.log(`        ${l}`));
      if (r.stderr) console.log(`        ${r.stderr.trim().split('\n').slice(0, 3).join('\n        ')}`);
    }
  });
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(failed ? `\n실패 ${failed}건 (${secs}초)` : `\n전체 통과 (${secs}초, 동시 ${LIMIT}개)`);
process.exit(failed ? 1 : 0);
