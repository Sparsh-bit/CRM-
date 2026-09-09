/**
 * One shared status→tone map per plain-string status field in the app
 * (Campaign/Mailbox/WaInstance/SmsGateway/Lead all store status as a bare
 * String, not a Prisma enum, so there's no compiler exhaustiveness check —
 * these `Record<string, ...>` maps are the closest equivalent, and the same
 * `pillClass` used by the Workforce Prisma-enum maps in
 * src/app/workforce/_lib/status.ts). Consolidates what used to be three
 * different inline `bg-x/20 text-x` ternaries (mailboxes, whatsapp) plus one
 * undifferentiated flat pill (campaigns) plus unstyled bare text (leads).
 */
export { type Tone, pillClass } from './tone';
import type { Tone } from './tone';

function metaOf(map: Record<string, Tone>, fallback: Tone = 'muted') {
  return (status: string) => ({ label: status, tone: map[status] ?? fallback });
}

// active | paused | error
export const mailboxStatusMeta = metaOf({ active: 'good', error: 'bad', paused: 'muted' });

// disconnected | qr | connected | error
export const waInstanceStatusMeta = metaOf({ connected: 'good', error: 'bad', qr: 'warn', disconnected: 'warn' });

// not_configured | disconnected | connected | error
export const smsGatewayStatusMeta = metaOf({ connected: 'good', error: 'bad', disconnected: 'muted', not_configured: 'warn' });

// draft | scheduled | running | paused | done
export const campaignStatusMeta = metaOf({ draft: 'muted', scheduled: 'accent', running: 'good', paused: 'warn', done: 'good' });

// new | queued | contacted | replied | bounced | unsubscribed | invalid
export const leadStatusMeta = metaOf({
  new: 'muted', queued: 'accent', contacted: 'accent', replied: 'good',
  bounced: 'bad', unsubscribed: 'bad', invalid: 'bad',
});

// StepStatus from src/lib/onboarding/status.ts — kept as an explicit Record
// (not metaOf's fallback form) so a new StepStatus value fails to compile
// here instead of silently rendering unlabeled.
export type OnboardingStepStatus = 'not_configured' | 'configured' | 'connected' | 'error' | 'needs_attention';
export const onboardingStepMeta: Record<OnboardingStepStatus, { label: string; tone: Tone }> = {
  not_configured: { label: 'Not configured', tone: 'muted' },
  configured: { label: 'Configured', tone: 'good' },
  connected: { label: 'Connected', tone: 'good' },
  error: { label: 'Error', tone: 'bad' },
  needs_attention: { label: 'Needs attention', tone: 'warn' },
};
