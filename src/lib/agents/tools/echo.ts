/**
 * Internal proof-of-runtime tool. Not a business capability — it exists so
 * the agent runtime (permission checks, input/output validation, activity
 * logging, retries, timeouts) can be exercised and tested end to end before
 * any real tool (CRM, campaigns, research) is built on top of it.
 */
import { z } from 'zod';
import { registerTool } from '../registry';

registerTool({
  name: 'echo',
  description: 'Returns the given message unchanged, optionally after a delay. Used only to prove the agent runtime — not a real business capability.',
  inputSchema: z.object({
    message: z.string().min(1).max(2000),
    delayMs: z.number().int().min(0).max(600_000).default(0), // lets tests prove the execution timeout interrupts an otherwise-successful call
  }),
  outputSchema: z.object({ echoed: z.string() }),
  requiredPermission: 'echo',
  category: 'test',
  readOnly: true,
  idempotent: true,
  handler: async (input) => {
    if (input.delayMs > 0) await new Promise((r) => setTimeout(r, input.delayMs));
    return { echoed: input.message };
  },
});
