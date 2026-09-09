/**
 * Regression test for the worker's missing graceful shutdown, found in a
 * production-reliability audit: src/worker/index.ts had no SIGTERM/SIGINT
 * handler at all, so a Railway deploy/restart just killed the process
 * mid-poll-interval with no warning — whatever job was `running` at that
 * instant sat there until reclaimStale()'s 5-minute window on the NEXT
 * worker instance's first tick. Fixed: a signal now stops the loop from
 * starting a new tick and wakes an in-progress sleep immediately, so the
 * process exits promptly instead of relying on the platform's kill timeout
 * (or, worse, a SIGKILL after it).
 *
 * Real process, real signal, real DB (the worker's first tick touches it
 * via reclaimStale/claimJob) — spawns the actual `npx tsx src/worker/index.ts`
 * entry point, same as approval-regression-test.ts's real-worker check.
 * Run via `npm run worker-shutdown:test`.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
function checkTrue(name: string, got: boolean) { check(name, got, true); }

function waitForOutput(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 100);
  });
}

async function main() {
  // Long tick interval on purpose — a SIGTERM landing quickly after "worker
  // up" is likely to hit the sleep between ticks, not mid-tick, which is
  // exactly the case the old code had no way to interrupt.
  const child = spawn('npx', ['tsx', 'src/worker/index.ts'], {
    env: { ...process.env, WORKER_TICK_MS: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d) => { out += String(d); });
  child.stderr?.on('data', (d) => { out += String(d); });

  try {
    const started = await waitForOutput(() => out.includes('worker up'), 15_000);
    check('the worker starts cleanly and logs its startup line', started, true);

    const signalledAt = Date.now();
    child.kill('SIGTERM');

    const exitInfo = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal })),
      ),
      new Promise<{ code: null; signal: null }>((resolve) => setTimeout(() => resolve({ code: null, signal: null }), 8000)),
    ]);
    const elapsed = Date.now() - signalledAt;

    checkTrue('the worker process actually exits after SIGTERM instead of being left running', exitInfo.code !== null || exitInfo.signal !== null);
    check('the worker exits cleanly (code 0) — a graceful stop, not a crash', exitInfo.code, 0);
    checkTrue(
      'the worker exits promptly on SIGTERM (well under the 10s tick interval it would otherwise have been asleep through) — this is the actual regression: before the fix, nothing woke the sleep and the process only died because the OS killed it, not because the code chose to exit',
      elapsed < 5000,
    );
    checkTrue('the signal receipt and clean shutdown were both logged, not a silent kill', out.includes('SIGTERM') && out.includes('shutting down cleanly'));
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall worker shutdown regression tests passed');
  process.exit(fails ? 1 : 0);
}

main();
