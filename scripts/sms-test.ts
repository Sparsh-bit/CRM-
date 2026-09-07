/**
 * Real-database integration test for Phase 5 SMS (SmsGateway, SmsService,
 * the httpSMS adapter, and the existing send path extended for the sms
 * channel). Same tier as scripts/agent-*-test.ts — live Postgres, run
 * separately from `npm test` via `npm run sms:test`. External HTTP is
 * mocked (global.fetch) — no real network call to httpSMS, no real SMS sent.
 */
import 'dotenv/config';
process.env.HTTPSMS_TIMEOUT_MS = '2000';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { decrypt } from '../src/lib/crypto';
import { createGateway, updateGateway, deleteGateway, checkGatewayConnection, listGateways, getGateway, type SmsActor } from '../src/lib/sms/gateways';
import { buildQueue } from '../src/lib/campaign';
import { sendDueMessages } from '../src/worker/sender';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
async function checkThrows(name: string, fn: () => Promise<unknown>) {
  try { await fn(); fails++; console.log(`FAIL ${name}\n  expected a throw, got none`); }
  catch { console.log(`pass ${name}`); }
}

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  // @ts-expect-error - test double, narrower than lib.dom's fetch
  global.fetch = async (url: string, init?: RequestInit) => handler(url, init);
}
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const HTTPSMS_MESSAGE_OK = {
  status: 'success', message: 'message added to queue',
  data: { id: 'hsms-msg-1', status: 'pending', content: 'hi', contact: '+15550001', owner: '+15559999', request_id: null, sent_at: null, delivered_at: null, failed_at: null, failure_reason: null },
};

async function main() {
  const ws = await db.workspace.create({ data: { name: 'SMS Test A', slug: 'sms-test-a-' + Date.now() } });
  const other = await db.workspace.create({ data: { name: 'SMS Test B', slug: 'sms-test-b-' + Date.now() } });
  const admin: SmsActor = { workspaceId: ws.id, role: 'admin' };
  const member: SmsActor = { workspaceId: ws.id, role: 'member' };

  try {
    // ── gateway creation, encrypted credentials, authorization ─────────
    await checkThrows('member cannot create an SMS gateway', () =>
      createGateway(member, { label: 'x', phoneNumber: '+15559999', apiKey: 'k' }));

    const gw = await createGateway(admin, { label: 'My Phone', phoneNumber: '+15559999', apiKey: 'super-secret-key' });
    check('gateway defaults to disconnected until tested', gw.status, 'disconnected');
    check('gateway defaults to the httpsms provider', gw.provider, 'httpsms');
    const raw = await db.smsGateway.findUniqueOrThrow({ where: { id: gw.id } });
    check('the API key is never stored in plaintext', raw.apiKeyEnc === 'super-secret-key', false);
    check('the stored ciphertext round-trips back to the original key via the existing crypto module', decrypt(raw.apiKeyEnc), 'super-secret-key');

    await checkThrows('member cannot update a gateway', () => updateGateway(member, gw.id, { label: 'y' }));
    await checkThrows('member cannot delete a gateway', () => deleteGateway(member, gw.id));
    const renamed = await updateGateway(admin, gw.id, { label: 'My Phone v2' });
    check('admin can update a gateway', renamed.label, 'My Phone v2');
    await checkThrows('an invalid status is rejected', () => updateGateway(admin, gw.id, { status: 'flying' }));

    // ── workspace isolation ─────────────────────────────────────────────
    check('a different workspace cannot see this gateway', await getGateway(other.id, gw.id), null);
    check('listGateways in the other workspace is empty', (await listGateways(other.id)).length, 0);
    await checkThrows('a different workspace cannot update this gateway (not found, not a permission error)', () =>
      updateGateway({ workspaceId: other.id, role: 'admin' }, gw.id, { label: 'Hijacked' }));

    // ── connection validation: not configured ───────────────────────────
    const unconfigured = await createGateway(admin, { label: 'No Key Yet', phoneNumber: '+15550000', apiKey: 'placeholder' });
    await db.smsGateway.update({ where: { id: unconfigured.id }, data: { apiKeyEnc: null } });
    const notConfiguredResult = await checkGatewayConnection(ws.id, unconfigured.id);
    check('a gateway with no API key reports not_configured', notConfiguredResult.status, 'not_configured');

    // ── connection validation: invalid credentials ──────────────────────
    mockFetch(() => jsonResponse({ status: 'error', message: 'invalid api key' }, 401));
    const invalidCredsResult = await checkGatewayConnection(ws.id, gw.id);
    check('a 401 from GET /v1/phones is reported as invalid_credentials', invalidCredsResult.status, 'invalid_credentials');
    check('the gateway status is persisted as error', (await getGateway(ws.id, gw.id))?.status, 'error');

    // ── connection validation: provider unavailable (timeout) ───────────
    mockFetch(() => new Promise((_, reject) => setTimeout(() => reject(new Error('ECONNRESET')), 5)));
    const timeoutResult = await checkGatewayConnection(ws.id, gw.id);
    check('a network failure is reported as provider_unavailable', timeoutResult.status, 'provider_unavailable');

    // ── connection validation: device not registered ────────────────────
    mockFetch(() => jsonResponse({ status: 'success', data: [{ id: 'p1', phone_number: '+19999999999' }] }));
    const deviceUnavailableResult = await checkGatewayConnection(ws.id, gw.id);
    check('a phone list that does not include our number is device_unavailable', deviceUnavailableResult.status, 'device_unavailable');

    // ── connection validation: connected ─────────────────────────────────
    mockFetch(() => jsonResponse({ status: 'success', data: [{ id: 'p1', phone_number: '+15559999' }] }));
    const connectedResult = await checkGatewayConnection(ws.id, gw.id);
    check('a phone list that includes our number is connected', connectedResult.status, 'connected');
    check('a successful check persists connected status', (await getGateway(ws.id, gw.id))?.status, 'connected');
    check('a successful check clears the stored error', (await getGateway(ws.id, gw.id))?.lastError, null);

    // ── message creation / queueing through the real campaign + send path ──
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'SMS Leads' } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Sam Lead', phone: '+15550001', status: 'new' } });

    // Campaign.sendStartHour/sendEndHour/sendDays default to 9-18 on Mon-Fri
    // (workspace tz) — wide open here so these scenarios test the SMS send
    // path itself, not whatever hour this test happens to run at. The
    // dedicated sending-window scenario below sets a deliberately closed one.
    async function freshCampaign() {
      const c = await db.campaign.create({
        data: { workspaceId: ws.id, listId: list.id, name: 'SMS Campaign ' + Date.now(), channel: 'sms', sendStartHour: 0, sendEndHour: 24, sendDays: [0, 1, 2, 3, 4, 5, 6] },
      });
      await db.campaignStep.create({ data: { campaignId: c.id, order: 1, body: 'Hi {{first_name}}, quick question' } });
      return c;
    }

    const sendCampaign = await freshCampaign();
    const queued = await buildQueue(sendCampaign.id);
    check('buildQueue creates exactly one sms message for the one lead with a phone', queued.queued, 1);
    const queuedAgain = await buildQueue(sendCampaign.id);
    check('re-running buildQueue does not create a duplicate message for the same campaign/lead/step/channel', queuedAgain.queued, 0);

    // ── valid send through the real worker send path (mocked provider) ──
    mockFetch((url) => {
      if (url.includes('/v1/messages/send')) return jsonResponse(HTTPSMS_MESSAGE_OK);
      return jsonResponse({ status: 'success', data: [] });
    });
    await sendDueMessages(ws.id);
    const sentMsg = await db.message.findFirstOrThrow({ where: { campaignId: sendCampaign.id } });
    check('a successful provider response marks the message sent', sentMsg.status, 'sent');
    check('the provider message id is recorded, not fabricated', sentMsg.providerId, 'hsms-msg-1');
    check('the message is linked to the gateway that sent it', sentMsg.smsGatewayId, gw.id);
    const afterSend = await db.smsGateway.findUniqueOrThrow({ where: { id: gw.id } });
    check('the gateway\'s sentToday counter increments on a real send', afterSend.sentToday, 1);

    // Each of the next three scenarios deliberately leaves its message
    // queued (blocked). sendDueMessages sweeps the whole workspace, so a
    // prior scenario's still-queued message would otherwise get swept up
    // (and could even succeed) once the condition that blocked it is reset
    // for the next scenario — delete it immediately after asserting it
    // stayed queued, so each scenario starts from a clean slate.

    // ── daily limit enforcement ──────────────────────────────────────────
    await db.smsGateway.update({ where: { id: gw.id }, data: { dailyLimit: 1 } }); // already sentToday=1 above
    const limitCampaign = await freshCampaign();
    await buildQueue(limitCampaign.id);
    const beforeLimit = await sendDueMessages(ws.id);
    check('a gateway at its daily limit sends nothing new', beforeLimit.sent, 0);
    check('the message over the limit stays queued, not failed', (await db.message.findFirstOrThrow({ where: { campaignId: limitCampaign.id } })).status, 'queued');
    await db.message.deleteMany({ where: { campaignId: limitCampaign.id } });
    await db.smsGateway.update({ where: { id: gw.id }, data: { dailyLimit: 50 } });

    // ── minimum gap enforcement ──────────────────────────────────────────
    await db.smsGateway.update({ where: { id: gw.id }, data: { minGapSeconds: 999_999, lastSentAt: new Date() } });
    const gapCampaign = await freshCampaign();
    await buildQueue(gapCampaign.id);
    const beforeGap = await sendDueMessages(ws.id);
    check('a gateway inside its minimum gap sends nothing new', beforeGap.sent, 0);
    await db.message.deleteMany({ where: { campaignId: gapCampaign.id } });
    await db.smsGateway.update({ where: { id: gw.id }, data: { minGapSeconds: 30, lastSentAt: null } });

    // ── sending window (shared scheduler logic, applied before channel dispatch) ──
    const windowCampaign = await db.campaign.create({
      data: { workspaceId: ws.id, listId: list.id, name: 'Window Campaign', channel: 'sms', sendStartHour: 0, sendEndHour: 0 }, // an empty window: never open
    });
    await db.campaignStep.create({ data: { campaignId: windowCampaign.id, order: 1, body: 'Hi' } });
    await buildQueue(windowCampaign.id);
    const beforeWindow = await sendDueMessages(ws.id);
    check('a closed sending window blocks an sms message exactly like it already blocks email/whatsapp', beforeWindow.sent, 0);
    check('the message outside the window stays queued', (await db.message.findFirstOrThrow({ where: { campaignId: windowCampaign.id } })).status, 'queued');
    await db.message.deleteMany({ where: { campaignId: windowCampaign.id } });

    // ── permanent provider failure ────────────────────────────────────────
    mockFetch(() => jsonResponse({ status: 'error', message: 'to is not a valid phone number' }, 422));
    const permFailCampaign = await freshCampaign();
    await buildQueue(permFailCampaign.id);
    await sendDueMessages(ws.id);
    const permFailMsg = await db.message.findFirstOrThrow({ where: { campaignId: permFailCampaign.id } });
    check('a permanent provider rejection (422) marks the message failed, not silently sent', permFailMsg.status, 'failed');
    check('the failure reason is recorded, not swallowed', permFailMsg.error?.includes('422'), true);

    // ── retryable provider failure ────────────────────────────────────────
    mockFetch(() => jsonResponse({ status: 'error', message: 'server error' }, 503));
    const retryFailCampaign = await freshCampaign();
    await buildQueue(retryFailCampaign.id);
    await sendDueMessages(ws.id);
    const retryFailMsg = await db.message.findFirstOrThrow({ where: { campaignId: retryFailCampaign.id } });
    check('a retryable provider failure (503) also marks the message failed — this app has no automatic message-level retry for any channel', retryFailMsg.status, 'failed');

    console.log('\nall sms checks completed');
  } finally {
    global.fetch = realFetch;
    await db.workspace.deleteMany({ where: { id: { in: [ws.id, other.id] } } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall sms integration tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
