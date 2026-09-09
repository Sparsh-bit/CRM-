'use server';

/**
 * Thin server-action wrappers around the real, already-implemented Command
 * Center backend (src/lib/agents/commandCenter.ts) — no new backend contract,
 * no mock execution. Every function here does exactly three things: check
 * the session, call the real function with the session's own workspaceId
 * (never an id supplied by the browser), and translate a thrown error into
 * a safe, human message. workspaceId is never accepted as an argument from
 * the client — every call below is scoped to whatever workspace the
 * server-side session cookie actually resolves to.
 */
import { getSession, currentRole } from '@/lib/session';
import { db } from '@/lib/db';
import { previewCommand, executeCommand, getCommand, listCommands, cancelCommand } from '@/lib/agents/commandCenter';
import type { ResolvedPlan } from '@/lib/agents/planner';
import { QuotaExceededError } from '@/lib/usage/service';
import { encodeErrorDisplay } from '@/lib/errors/display';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Maps a real thrown error to a safe message (Section 12) — raw detail is
 * only attached for admin/owner, and only inside the same encoded
 * {message, detail} shape ErrorDetail already knows how to render (reused
 * from the provider-connection error UI, not a second error format).
 */
async function friendlyError(e: unknown): Promise<string> {
  const raw = e instanceof Error ? e.message : String(e);
  const role = await currentRole();
  const showDetail = role === 'admin' || role === 'owner';

  let message: string;
  if (e instanceof QuotaExceededError) {
    message = `You've reached your plan's limit for ${e.kind}. Upgrade the plan or wait for the current period to roll over.`;
  } else if (raw.includes('Planner did not return valid JSON') || raw.includes('Planner produced a malformed plan') || raw.includes('Command text is required')) {
    message = "The workforce couldn't create a valid plan. Try simplifying the request.";
  } else if (raw.includes('All AI providers failed')) {
    message = 'The AI provider is temporarily unavailable. Try again in a moment.';
  } else if (raw === 'UNAUTHORIZED') {
    message = 'Your session has expired. Sign in again.';
  } else if (raw.includes('not a member of this workspace') || (raw.includes('needs the') && raw.includes('role'))) {
    message = "You don't have permission to do this.";
  } else if (raw.includes('Delegation depth limit')) {
    message = 'This plan has too many chained steps. Try a simpler request.';
  } else if (raw.includes('not found in this workspace') || raw.includes('Command not found')) {
    message = 'That command could not be found.';
  } else {
    message = "Something went wrong running this command. Try again, or contact an admin if it keeps happening.";
  }
  return encodeErrorDisplay({ message, detail: showDetail ? raw : '' });
}

function validationError(message: string): string {
  return encodeErrorDisplay({ message, detail: '' });
}

export type CommandStepSnapshot = {
  id: string;
  agentId: string;
  status: string;
  description: string | null;
  output: unknown;
  failureReason: string | null;
  relatedRecordIds: unknown;
  createdAt: string;
};

export type CommandSnapshot = {
  root: {
    id: string;
    status: string;
    description: string | null;
    input: unknown;
    output: unknown;
    failureReason: string | null;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  steps: CommandStepSnapshot[];
};

type CommandBundle = NonNullable<Awaited<ReturnType<typeof getCommand>>>;

function toSnapshot(cmd: CommandBundle): CommandSnapshot {
  return {
    root: {
      id: cmd.root.id, status: cmd.root.status, description: cmd.root.description,
      input: cmd.root.input, output: cmd.root.output, failureReason: cmd.root.failureReason,
      createdBy: cmd.root.createdBy, createdAt: cmd.root.createdAt.toISOString(), updatedAt: cmd.root.updatedAt.toISOString(),
    },
    steps: cmd.steps.map((s) => ({
      id: s.id, agentId: s.agentId, status: s.status, description: s.description,
      output: s.output, failureReason: s.failureReason, relatedRecordIds: s.relatedRecordIds,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

export async function previewCommandAction(commandText: string): Promise<Result<ResolvedPlan>> {
  const session = await getSession();
  if (!session) return { ok: false, error: await friendlyError(new Error('UNAUTHORIZED')) };
  const text = commandText.trim();
  if (!text) return { ok: false, error: validationError('Type a command first.') };

  try {
    return { ok: true, data: await previewCommand(session.workspaceId, text) };
  } catch (e) {
    return { ok: false, error: await friendlyError(e) };
  }
}

export async function executeCommandAction(commandText: string): Promise<Result<CommandSnapshot>> {
  const session = await getSession();
  if (!session) return { ok: false, error: await friendlyError(new Error('UNAUTHORIZED')) };
  const text = commandText.trim();
  if (!text) return { ok: false, error: validationError('Type a command first.') };

  try {
    const cmd = await executeCommand(session.workspaceId, session.userId, text);
    if (!cmd) return { ok: false, error: validationError('The command could not be created.') };
    return { ok: true, data: toSnapshot(cmd) };
  } catch (e) {
    return { ok: false, error: await friendlyError(e) };
  }
}

export async function refreshCommandAction(rootTaskId: string): Promise<Result<CommandSnapshot>> {
  const session = await getSession();
  if (!session) return { ok: false, error: await friendlyError(new Error('UNAUTHORIZED')) };

  try {
    const cmd = await getCommand(session.workspaceId, rootTaskId);
    if (!cmd) return { ok: false, error: validationError('That command could not be found.') };
    return { ok: true, data: toSnapshot(cmd) };
  } catch (e) {
    return { ok: false, error: await friendlyError(e) };
  }
}

export async function cancelCommandAction(rootTaskId: string): Promise<Result<CommandSnapshot>> {
  const session = await getSession();
  if (!session) return { ok: false, error: await friendlyError(new Error('UNAUTHORIZED')) };

  try {
    const cmd = await cancelCommand(session.workspaceId, rootTaskId);
    if (!cmd) return { ok: false, error: validationError('That command could not be found.') };
    return { ok: true, data: toSnapshot(cmd) };
  } catch (e) {
    return { ok: false, error: await friendlyError(e) };
  }
}

export type CommandHistoryRow = {
  id: string;
  requested: string;
  status: string;
  output: unknown;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
};

const HISTORY_LIMIT = 25;

export async function listCommandsAction(): Promise<Result<CommandHistoryRow[]>> {
  const session = await getSession();
  if (!session) return { ok: false, error: await friendlyError(new Error('UNAUTHORIZED')) };

  try {
    const roots = await listCommands(session.workspaceId);
    const recent = roots.slice(0, HISTORY_LIMIT);
    const userIds = [...new Set(recent.map((r) => r.createdBy).filter((id): id is string => !!id))];
    const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));

    return {
      ok: true,
      data: recent.map((r) => ({
        id: r.id,
        requested: r.description ?? '',
        status: r.status,
        output: r.output,
        createdByEmail: r.createdBy ? emailById.get(r.createdBy) ?? 'unknown user' : 'System',
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  } catch (e) {
    return { ok: false, error: await friendlyError(e) };
  }
}
