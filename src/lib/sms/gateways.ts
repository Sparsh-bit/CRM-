/**
 * SMS gateway management — add/edit/test/remove a workspace's SMS
 * connection. A gateway is credentials plus sending capacity, exactly like a
 * Mailbox or a WaInstance, so every write here is admin-level, gated the
 * same way agents.ts gates AI-employee management: the caller resolves the
 * actor's role from the database and passes it in; the decision itself
 * (atLeast) happens inside this module, not the caller.
 *
 * No page calls this yet (Phase 5 is backend-only, per the brief) — this is
 * the service layer a future /sms settings page wires up to, the same
 * relationship src/lib/agents/agents.ts has to a future page.
 */
import { db } from '../db';
import { atLeast, type Role } from '../session';
import { encrypt } from '../crypto';
import { sendSms, testConnection, type ConnectionResult } from './index';

export type SmsActor = { workspaceId: string; role: Role };

function requireAdmin(actor: SmsActor) {
  if (!atLeast(actor.role, 'admin')) {
    throw new Error(`Managing SMS gateways needs the admin role. You are ${actor.role} in this workspace.`);
  }
}

export type CreateGatewayInput = {
  label: string;
  phoneNumber: string;
  apiKey: string;
  provider?: string; // defaults to 'httpsms' — the only provider implemented so far
  dailyLimit?: number;
  minGapSeconds?: number;
  jitterSeconds?: number;
};

export async function createGateway(actor: SmsActor, input: CreateGatewayInput) {
  requireAdmin(actor);
  const label = input.label.trim();
  const phoneNumber = input.phoneNumber.trim();
  if (!label) throw new Error('Label is required.');
  if (!phoneNumber) throw new Error('Phone number is required.');
  if (!input.apiKey.trim()) throw new Error('API key is required.');

  return db.smsGateway.create({
    data: {
      workspaceId: actor.workspaceId,
      label,
      phoneNumber,
      provider: input.provider ?? 'httpsms',
      apiKeyEnc: encrypt(input.apiKey.trim()),
      status: 'disconnected', // not tested yet — an explicit testGatewayConnection() call earns "connected"
      ...(input.dailyLimit !== undefined ? { dailyLimit: input.dailyLimit } : {}),
      ...(input.minGapSeconds !== undefined ? { minGapSeconds: input.minGapSeconds } : {}),
      ...(input.jitterSeconds !== undefined ? { jitterSeconds: input.jitterSeconds } : {}),
    },
  });
}

export type UpdateGatewayInput = Partial<Omit<CreateGatewayInput, 'apiKey'>> & { apiKey?: string; status?: string };

const GATEWAY_STATUSES = ['not_configured', 'disconnected', 'connected', 'error'];

export async function updateGateway(actor: SmsActor, gatewayId: string, patch: UpdateGatewayInput) {
  requireAdmin(actor);
  const existing = await db.smsGateway.findFirst({ where: { id: gatewayId, workspaceId: actor.workspaceId } });
  if (!existing) throw new Error('SMS gateway not found in this workspace.');

  if (patch.status && !GATEWAY_STATUSES.includes(patch.status)) {
    throw new Error(`Invalid gateway status: "${patch.status}". Must be one of ${GATEWAY_STATUSES.join(', ')}.`);
  }

  return db.smsGateway.update({
    where: { id: gatewayId },
    data: {
      ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
      ...(patch.phoneNumber !== undefined ? { phoneNumber: patch.phoneNumber.trim() } : {}),
      ...(patch.apiKey !== undefined ? { apiKeyEnc: encrypt(patch.apiKey.trim()) } : {}),
      ...(patch.dailyLimit !== undefined ? { dailyLimit: patch.dailyLimit } : {}),
      ...(patch.minGapSeconds !== undefined ? { minGapSeconds: patch.minGapSeconds } : {}),
      ...(patch.jitterSeconds !== undefined ? { jitterSeconds: patch.jitterSeconds } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    },
  });
}

/** "Disable" is a status change, not a delete — matches Mailbox's pause/resume, not WaInstance's hard delete. */
export async function disableGateway(actor: SmsActor, gatewayId: string) {
  return updateGateway(actor, gatewayId, { status: 'disconnected' });
}

export async function deleteGateway(actor: SmsActor, gatewayId: string) {
  requireAdmin(actor);
  const existing = await db.smsGateway.findFirst({ where: { id: gatewayId, workspaceId: actor.workspaceId } });
  if (!existing) throw new Error('SMS gateway not found in this workspace.');
  return db.smsGateway.delete({ where: { id: gatewayId } });
}

/**
 * Runs a real connection check and persists the result — the only place
 * SmsGateway.status/lastError get set from a check rather than a send.
 */
export async function checkGatewayConnection(workspaceId: string, gatewayId: string): Promise<ConnectionResult> {
  const gateway = await db.smsGateway.findFirst({ where: { id: gatewayId, workspaceId } });
  if (!gateway) throw new Error('SMS gateway not found in this workspace.');

  const result = await testConnection(gateway);
  await db.smsGateway.update({
    where: { id: gatewayId },
    data: {
      status: result.status === 'connected' ? 'connected' : result.status === 'not_configured' ? 'not_configured' : 'error',
      lastError: result.status === 'connected' ? null : result.message,
    },
  });
  return result;
}

export async function listGateways(workspaceId: string) {
  return db.smsGateway.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
}

export async function getGateway(workspaceId: string, gatewayId: string) {
  return db.smsGateway.findFirst({ where: { id: gatewayId, workspaceId } });
}

/** Re-exported so a future caller needs only this module for the full SMS surface. */
export { sendSms };
