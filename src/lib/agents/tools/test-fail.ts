/**
 * Internal proof-of-runtime tools that always throw. Exist so failure/retry/
 * timeout handling can be exercised deterministically without relying on a
 * real tool ever actually failing — never register a real business tool
 * this way.
 *
 * Two variants because retryability is a per-tool registry property, not a
 * per-call one: `test-fail` stands in for a mutating, non-idempotent action
 * (must never auto-retry) and `test-fail-safe` for a read-only/idempotent one
 * (safe to auto-retry up to the task's maxRetries).
 */
import { z } from 'zod';
import { registerTool } from '../registry';

const inputSchema = z.object({
  reason: z.string().min(1).max(500).default('forced test failure'),
  delayMs: z.number().int().min(0).max(600_000).default(0),
});

async function fail(input: z.infer<typeof inputSchema>): Promise<never> {
  if (input.delayMs > 0) await new Promise((r) => setTimeout(r, input.delayMs));
  throw new Error(input.reason);
}

registerTool({
  name: 'test-fail',
  description: 'Always throws. Stands in for a mutating, non-idempotent tool — never a real business capability.',
  inputSchema,
  outputSchema: z.never(),
  requiredPermission: 'test-fail',
  category: 'test',
  readOnly: false,
  idempotent: false,
  handler: fail,
});

registerTool({
  name: 'test-fail-safe',
  description: 'Always throws. Stands in for a read-only/idempotent tool that is safe to retry — never a real business capability.',
  inputSchema,
  outputSchema: z.never(),
  requiredPermission: 'test-fail-safe',
  category: 'test',
  readOnly: true,
  idempotent: true,
  handler: fail,
});
