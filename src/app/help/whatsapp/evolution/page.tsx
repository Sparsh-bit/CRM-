import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { StepGuide, VerifiedSource, type Step } from '@/components/StepGuide';

export const dynamic = 'force-dynamic';

const STEPS: Step[] = [
  {
    title: 'What Evolution API is',
    description: 'An open-source, self-hosted REST API that manages real WhatsApp Web sessions (and the official WhatsApp Cloud API). OutreachPilot is a client of it, not a replacement for it — someone has to run this service somewhere.',
  },
  {
    title: 'Get the API URL and key from whoever runs it',
    description: <>If your organisation already runs Evolution API, ask for its base URL and admin API key. If not, it must be deployed (Docker is the common path) before WhatsApp can work here at all — this is infrastructure your admin sets up once, not a per-user step.</>,
    note: 'These two values are set as server environment variables (EVOLUTION_API_URL, EVOLUTION_API_KEY) — never entered per-workspace in the UI, since they belong to the gateway, not to any one mailbox.',
  },
  {
    title: 'Create an instance',
    description: <>On the <Link href="/whatsapp" className="text-accent">WhatsApp</Link> page, fill in a label and an instance name (letters/numbers/underscores/hyphens only) and click "Create instance". This calls Evolution API's instance-create endpoint and, on success, shows a QR code.</>,
  },
  {
    title: 'Scan the QR code',
    description: <>On the phone that will send/receive: WhatsApp → Settings → Linked devices → Link a device, then scan the QR shown on the WhatsApp page.</>,
    note: 'The QR expires after a short time. If it goes stale before you scan it, use "Reconnect (new QR)" on the instance card to get a fresh one.',
  },
  {
    title: 'Verify the connection',
    description: <>Click "Refresh status". This calls Evolution API's connection-state endpoint for real — the pill only ever shows <code className="text-slate-300">connected</code> once Evolution itself reports the session as open.</>,
  },
];

const ERRORS: { when: string; means: string }[] = [
  { when: 'Evolution API URL appears to point to the wrong service', means: 'The response was HTML, not JSON — EVOLUTION_API_URL is probably pointing at a web page (or this app\'s own domain) rather than the Evolution API server. Double-check the URL.' },
  { when: 'Could not reach the Evolution API (unavailable)', means: 'DNS failure, connection refused, or a timeout — nothing is listening at that address right now. Confirm the service is actually running and the URL/port are correct.' },
  { when: 'Evolution API rejected the request — the API key is missing or invalid (401)', means: 'EVOLUTION_API_KEY is wrong, or missing entirely. Confirm it matches the key Evolution API is configured with.' },
  { when: 'Evolution API returned 404 — this instance does not exist (404)', means: 'The instance was deleted on the Evolution side (or never created there), but OutreachPilot still has a row for it. Remove it here and create a fresh instance.' },
  { when: 'Evolution API returned a server error (5xx)', means: 'The gateway itself is unhealthy right now — not a configuration problem on this side. Check the Evolution API service\'s own logs.' },
  { when: 'QR code goes stale / scan fails', means: 'QR codes expire quickly. Click "Reconnect (new QR)" for a fresh one and scan promptly.' },
  { when: 'Status flips back to disconnected after connecting', means: 'The phone was unlinked from WhatsApp\'s side (Linked devices removed it), lost internet, or WhatsApp logged the session out. Reconnect and re-scan.' },
];

export default async function EvolutionHelpPage() {
  const s = await getSession();
  if (!s) redirect('/login');

  return (
    <div className="space-y-8">
      <Link href="/help/whatsapp" className="text-sm text-muted hover:text-slate-200">← WhatsApp setup</Link>
      <div>
        <h1 className="text-2xl font-semibold">Evolution API setup</h1>
        <p className="text-sm text-muted mt-1">
          Project: <a className="text-accent" href="https://github.com/evolution-foundation/evolution-api">github.com/evolution-foundation/evolution-api</a> (this project was previously named EvolutionAPI/evolution-api — the old GitHub link still redirects).
        </p>
      </div>

      <StepGuide steps={STEPS} />

      <div className="card space-y-3">
        <div className="font-medium">Common errors</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>{['You see', 'What it means'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {ERRORS.map((e) => (
                <tr key={e.when}>
                  <td className="td font-medium">{e.when}</td>
                  <td className="td text-muted">{e.means}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card space-y-2">
        <div className="font-medium">Security</div>
        <p className="text-sm text-muted">
          EVOLUTION_API_KEY is a server-only secret — it's never sent to the browser and never logged. Each instance's
          own connection token (issued by Evolution API on creation) is stored encrypted (AES-256-GCM), the same way
          mailbox passwords and SMS gateway keys are.
        </p>
      </div>

      <VerifiedSource
        verifiedOn="September 8, 2026"
        sources={[
          { label: 'evolution-foundation/evolution-api (GitHub)', href: 'https://github.com/evolution-foundation/evolution-api' },
          { label: 'Evolution Foundation docs — Set Webhook', href: 'https://docs.evolutionfoundation.com.br/en/evolution-api/set-webhook' },
        ]}
      />
    </div>
  );
}
