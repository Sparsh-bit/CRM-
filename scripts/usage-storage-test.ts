/**
 * Phase 10: UsageService (quota check/record/summary) and StorageService
 * (workspace-scoped local backend) integration test. Real Postgres, real
 * local filesystem. The R2 backend (src/lib/storage/r2.ts) is NOT
 * integration-tested here — no R2 credentials exist in this environment,
 * and faking a passing test against a mocked S3 client would be exactly the
 * kind of false confidence Phase 9/10 have both explicitly refused to
 * produce elsewhere; see docs/architecture.md's "Known limitations".
 * Run separately from `npm test` via `npm run usage-storage:test`.
 */
import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';

process.env.STORAGE_ROOT = path.join(os.tmpdir(), 'outreachpilot-storage-test-' + Date.now());

import { promises as fs } from 'node:fs';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { checkQuota, recordUsage, getUsageSummary, checkGaugeQuota, workspaceLimits, QuotaExceededError } from '../src/lib/usage/service';
import { storageFor } from '../src/lib/storage';
import { createAgent, type AgentActor } from '../src/lib/agents/agents';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
function checkTrue(name: string, got: boolean) { check(name, got, true); }
async function checkThrows(name: string, fn: () => Promise<unknown>) {
  try { await fn(); fails++; console.log(`FAIL ${name}\n  expected a throw, got none`); }
  catch { console.log(`pass ${name}`); }
}

async function main() {
  const ws = await db.workspace.create({ data: { name: 'Usage Test A', slug: 'usage-test-a-' + Date.now(), plan: 'free' } });
  const other = await db.workspace.create({ data: { name: 'Usage Test B', slug: 'usage-test-b-' + Date.now() } });

  try {
    // ═══════════════════════ QUOTA / USAGE ═══════════════════════
    check('a fresh workspace has zero usage', await checkQuota(ws.id, 'agent_task').then(() => 'ok').catch(() => 'blocked'), 'ok');

    await recordUsage(ws.id, 'agent_task', 3);
    check('recordUsage accumulates a real quantity', (await getUsageSummary(ws.id)).counters.agent_task?.used, 3);
    check('usage is workspace-isolated — workspace B sees none of it', (await getUsageSummary(other.id)).counters.agent_task?.used, 0);

    // Set a tight override so we can actually hit the ceiling without recording thousands of events.
    await db.workspace.update({ where: { id: ws.id }, data: { quotaOverrides: { agent_task: 5 } } });
    await checkQuota(ws.id, 'agent_task', 2); // 3 + 2 = 5, exactly at the limit — must NOT throw
    console.log('pass checkQuota allows landing exactly on the limit, not just under it');
    await checkThrows('checkQuota throws once the override limit would be exceeded', () => checkQuota(ws.id, 'agent_task', 3)); // 3 + 3 = 6 > 5
    const err = await checkQuota(ws.id, 'agent_task', 100).catch((e) => e);
    checkTrue('the thrown error is a real QuotaExceededError naming the kind/limit/current', err instanceof QuotaExceededError && err.kind === 'agent_task' && err.limit === 5);

    // per-workspace override wins over the plan default
    const limits = await workspaceLimits(ws.id);
    check('a workspace override replaces the plan default for that key', limits.agent_task, 5);
    check('every OTHER key still falls back to the plan default (free)', limits.message, 500);

    // gauge quota (a live count, not an accumulating event sum)
    checkGaugeQuota({ agents: 5 }, 'agents', 4); // 4 existing + 1 new = 5 — allowed
    console.log('pass checkGaugeQuota allows landing exactly on a gauge limit');
    let gaugeThrew = false;
    try { checkGaugeQuota({ agents: 5 }, 'agents', 5); } catch (e) { gaugeThrew = e instanceof QuotaExceededError; }
    checkTrue('checkGaugeQuota throws once a gauge limit would be exceeded', gaugeThrew);

    // real enforcement through createAgent() — not a synthetic check, the actual code path
    await db.workspace.update({ where: { id: ws.id }, data: { quotaOverrides: { agent_task: 5, agents: 1 } } });
    const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };
    await createAgent(admin, { name: 'First Agent', role: 'Research' });
    await checkThrows('createAgent() itself enforces the real agents gauge quota, not just a synthetic check', () =>
      createAgent(admin, { name: 'Second Agent (over quota)', role: 'Research' }));

    // ai_request quota through the real AI router (no provider call is ever attempted once blocked)
    await db.workspace.update({ where: { id: ws.id }, data: { quotaOverrides: { ai_request: 0 } } });
    const { complete } = await import('../src/lib/ai/provider');
    let aiBlocked = false;
    const realFetch = global.fetch;
    let fetchWasCalled = false;
    global.fetch = async (...args: Parameters<typeof fetch>) => { fetchWasCalled = true; return realFetch(...args); };
    try { await complete({ system: 's', messages: [{ role: 'user', content: 'x' }], workspaceId: ws.id }); }
    catch (e) { aiBlocked = e instanceof QuotaExceededError; }
    global.fetch = realFetch;
    checkTrue('complete() refuses an over-quota workspace before touching any provider', aiBlocked);
    checkTrue('...and genuinely never attempted a network call — quota is checked BEFORE any provider is tried', !fetchWasCalled);

    // ═══════════════════════ STORAGE (local backend) ═══════════════════════
    const storageWs = storageFor(ws.id);
    const storageOther = storageFor(other.id);
    const data = Buffer.from('real file content for the storage abstraction test');

    await storageWs.upload('docs/hello.txt', data, 'text/plain');
    checkTrue('a real file was uploaded and exists', await storageWs.exists('docs/hello.txt'));
    check('download returns the exact real bytes written', (await storageWs.download('docs/hello.txt')).toString(), data.toString());
    const meta = await storageWs.getMetadata('docs/hello.txt');
    check('getMetadata reports the real size, not a fabricated one', meta?.sizeBytes, data.length);

    // Section 10: workspace isolation is STRUCTURAL — workspace B's own handle can never even name workspace A's key.
    checkTrue('workspace B cannot see workspace A\'s file — its handle is scoped to a different prefix entirely', !(await storageOther.exists('docs/hello.txt')));
    check('workspace B downloading the "same" sub-key gets nothing (its own, non-existent file), never A\'s content', await storageOther.getMetadata('docs/hello.txt'), null);

    const { path: localPath, cleanup } = await storageWs.getLocalPath('docs/hello.txt');
    checkTrue('getLocalPath returns a real, readable local path for the local backend', (await fs.readFile(localPath)).toString() === data.toString());
    await cleanup(); // no-op for local, but must not throw

    await storageWs.delete('docs/hello.txt');
    checkTrue('delete actually removes the file', !(await storageWs.exists('docs/hello.txt')));

    await storageWs.upload('workdir/a.txt', Buffer.from('a'));
    await storageWs.upload('workdir/b.txt', Buffer.from('b'));
    await storageWs.removeDir('workdir');
    checkTrue('removeDir removes every file under the prefix, not just one', !(await storageWs.exists('workdir/a.txt')) && !(await storageWs.exists('workdir/b.txt')));

    let unsafeRejected = false;
    try { await storageWs.upload('../escape.txt', Buffer.from('x')); } catch { unsafeRejected = true; }
    checkTrue('a path-traversal sub-key is refused outright, not silently sanitized', unsafeRejected);

    console.log('\nall usage/storage checks completed');
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [ws.id, other.id] } } });
    await fs.rm(process.env.STORAGE_ROOT!, { recursive: true, force: true }).catch(() => {});
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall usage/storage tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
