import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { Reveal } from './_components/Reveal';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';

export const metadata = {
  title: 'OutreachPilot: outreach and an AI workforce you control',
  description:
    'Email, WhatsApp and SMS campaigns, a per-lead AI writer, and an AI workforce that drafts and researches. Nothing sends without your approval.',
};

const ROLES = [
  { name: 'Strategy', dept: 'Leadership', note: 'Tracks how campaigns and pipeline are performing.', tone: 'muted' as const, autonomy: 'Suggest only' },
  { name: 'Research', dept: 'Research', note: 'Builds a picture of a lead or company from your CRM and the open web.', tone: 'muted' as const, autonomy: 'Suggest only' },
  { name: 'Sales', dept: 'Sales', note: 'Finds and prioritizes the leads worth contacting today.', tone: 'muted' as const, autonomy: 'Suggest only' },
  { name: 'Marketing', dept: 'Marketing', note: 'Compares campaign performance and audience reach.', tone: 'muted' as const, autonomy: 'Suggest only' },
  { name: 'Operations', dept: 'Operations', note: 'Keeps an eye on campaign state across the workspace.', tone: 'muted' as const, autonomy: 'Suggest only' },
  { name: 'Outreach', dept: 'Sales', note: 'Drafts personalized messages and proposes sending them.', tone: 'accent' as const, autonomy: 'Drafts, needs approval' },
  { name: 'Content Research', dept: 'Research', note: 'Reads public pages, posts and uploaded video for real signal.', tone: 'muted' as const, autonomy: 'Suggest only' },
];

const STEPS = [
  { t: 'Connect your channels', d: 'A mailbox over SMTP, Resend, Gmail or Outlook, plus WhatsApp and SMS if you use them.' },
  { t: 'Import your leads', d: 'Any spreadsheet. Columns and headers are detected automatically, no template to match.' },
  { t: 'Turn on your workforce', d: 'Agents draft, research and propose. You approve every send before it goes out.' },
];

export default async function LandingPage() {
  const s = await getSession();
  if (s) redirect('/');

  return (
    <div className="space-y-24 pb-24 overflow-x-hidden">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 pt-2">
        <Link href="/landing" className="font-display font-semibold tracking-tight text-slate-100">OutreachPilot</Link>
        <nav className="hidden md:flex items-center gap-1 text-sm text-muted">
          <a href="#workforce" className="px-3 py-1.5 rounded-md hover:text-slate-100 hover:bg-line">Workforce</a>
          <a href="#outreach" className="px-3 py-1.5 rounded-md hover:text-slate-100 hover:bg-line">Outreach</a>
          <a href="#how-it-works" className="px-3 py-1.5 rounded-md hover:text-slate-100 hover:bg-line">How it works</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login" className="text-sm text-muted hover:text-slate-100 px-2">Sign in</Link>
          <Button href="/login" className="text-sm">Get started</Button>
        </div>
      </header>

      {/* Hero */}
      <section className="grid lg:grid-cols-2 gap-12 items-center">
        <div className="space-y-5">
          <h1 className="font-display text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1] text-slate-100">
            Multichannel outreach, run by an AI workforce you control.
          </h1>
          <p className="text-base text-muted leading-relaxed max-w-[46ch]">
            Email, WhatsApp and SMS campaigns, a per-lead AI writer, and an AI workforce
            that drafts and researches, pending your approval.
          </p>
          <div className="flex gap-3">
            <Button href="/login">Get started</Button>
            <Button href="#how-it-works" variant="secondary">See how it works</Button>
          </div>
        </div>

        <Reveal>
          <Card className="space-y-4" aria-hidden="true">
            <div className="flex items-center justify-between">
              <span className="card-heading text-sm">Needs attention</span>
              <Badge label="Pending" tone="warn" />
            </div>
            <div className="flex items-start justify-between gap-4 border-t border-line pt-3">
              <div>
                <div className="text-sm font-medium text-slate-100">Draft intro email to Northwind Logistics</div>
                <div className="text-meta mt-0.5 normal-case tracking-normal font-normal">Outreach · send_email · needs approval</div>
              </div>
              <span className="btn-sec text-xs shrink-0 pointer-events-none">Review</span>
            </div>
            <div className="border-t border-line pt-3 space-y-2">
              {[{ n: 'Research', s: 'Active' }, { n: 'Sales', s: 'Active' }, { n: 'Outreach', s: 'Active' }].map((a) => (
                <div key={a.n} className="flex items-center justify-between text-sm">
                  <span>{a.n}</span>
                  <Badge label={a.s} tone="good" />
                </div>
              ))}
            </div>
          </Card>
          <p className="text-secondary mt-2 text-center">A preview of the Workforce overview inside the product.</p>
        </Reveal>
      </section>

      {/* How it works — a numbered sequence, not a row of equal cards: each
          step depends on the last, so the layout reads that way too. */}
      <Reveal>
        <section id="how-it-works" className="space-y-8">
          <h2 className="section-heading text-2xl">Three steps to your first send.</h2>
          <div className="divide-y divide-line border-t border-line">
            {STEPS.map((step, i) => (
              <div key={step.t} className="flex items-start gap-5 py-5">
                <span className="metric text-muted shrink-0 w-10">{String(i + 1).padStart(2, '0')}</span>
                <div className="space-y-1 pt-1">
                  <div className="card-heading">{step.t}</div>
                  <p className="text-secondary max-w-[52ch]">{step.d}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </Reveal>

      {/* Outreach */}
      <Reveal>
        <section id="outreach" className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-4 order-2 lg:order-1">
            <Card className="space-y-3" aria-hidden="true">
              <span className="card-heading text-sm">New campaign</span>
              <div className="rounded-lg border border-line p-3">
                <div className="text-sm font-medium text-slate-100">One template, merge tags</div>
                <div className="text-secondary mt-0.5">Fast and predictable. Write it once, fill in the blanks per lead.</div>
              </div>
              <div className="rounded-lg border border-accent p-3">
                <div className="text-sm font-medium text-slate-100">AI writes one message per lead</div>
                <div className="text-secondary mt-0.5">Reads every column of that lead&apos;s row and writes something specific to their business.</div>
              </div>
            </Card>
          </div>
          <div className="space-y-4 order-1 lg:order-2">
            <h2 className="section-heading text-2xl">One inbox of leads, three channels out.</h2>
            <p className="text-secondary max-w-[52ch]">
              Run the same list through email, WhatsApp and SMS. Write one template with merge tags,
              or let the AI writer draft something specific to each lead&apos;s business. You review before anything sends.
            </p>
          </div>
        </section>
      </Reveal>

      {/* Workforce */}
      <Reveal>
        <section id="workforce" className="space-y-8">
          <div className="max-w-[60ch] space-y-3">
            <h2 className="section-heading text-2xl">An AI workforce, not a single chatbot.</h2>
            <p className="text-secondary">
              Seven named roles, each with its own objective and a defined set of permissions.
              Autonomy ranges from suggestions only to drafting and proposing, but every proposed
              send still opens a real approval. Only an explicit, admin-set policy can skip a human.
            </p>
          </div>

          <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mx-1 px-1">
            {ROLES.map((r) => (
              <Card key={r.name} className="shrink-0 w-64 snap-start space-y-2">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-line flex items-center justify-center text-xs font-semibold shrink-0 text-slate-100">
                    {r.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate text-slate-100">{r.name}</div>
                    <div className="text-secondary truncate">{r.dept}</div>
                  </div>
                </div>
                <p className="text-secondary">{r.note}</p>
                <Badge label={r.autonomy} tone={r.tone} />
              </Card>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-6 items-center">
            <p className="text-secondary max-w-[52ch]">
              Every proposal, every approval and every decision is logged, scoped to your workspace,
              and visible on the same activity trail. Nothing runs unattended unless you turn it on.
            </p>
            <Card className="space-y-3" aria-hidden="true">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-100">Send intro email to Northwind Logistics</div>
                  <div className="text-meta mt-0.5 normal-case tracking-normal font-normal">Outreach · send_email</div>
                </div>
                <Badge label="Pending" tone="warn" />
              </div>
              <div className="flex gap-2">
                <span className="btn text-xs pointer-events-none">Approve</span>
                <span className="btn-sec text-xs pointer-events-none">Reject</span>
              </div>
            </Card>
          </div>
        </section>
      </Reveal>

      {/* Research, usage, reliability */}
      <Reveal>
        <section className="grid md:grid-cols-2 gap-6">
          <Card className="md:col-span-2 space-y-3">
            <h3 className="card-heading">Research that goes beyond your CRM</h3>
            <p className="text-secondary max-w-[60ch]">
              Public web pages, Instagram posts and uploaded video or audio, analyzed for business model,
              audience and adaptation signal. Real extraction and analysis, never invented.
            </p>
            <div className="flex flex-wrap gap-2">
              {['Web pages', 'Instagram', 'Uploaded video and audio'].map((t) => (
                <Badge key={t} label={t} tone="muted" />
              ))}
            </div>
          </Card>
          <Card className="space-y-3">
            <h3 className="card-heading">Usage you can actually see</h3>
            <p className="text-secondary">
              Real per-workspace metering against your plan, not an estimate: AI requests, agent tasks,
              messages sent, leads imported, storage used.
            </p>
          </Card>
          <Card className="space-y-3">
            <h3 className="card-heading">Nothing invented, nothing hidden</h3>
            <p className="text-secondary">
              The same health checks the team runs in production, covering the database, the AI provider and the send queue.
            </p>
          </Card>
        </section>
      </Reveal>

      {/* Final CTA, full-bleed */}
      <Reveal>
        <div className="relative left-1/2 right-1/2 -mx-[50vw] w-screen bg-panel border-y border-line">
          <div className="max-w-6xl mx-auto px-6 py-16 text-center space-y-5">
            <h2 className="section-heading text-2xl md:text-3xl">Set up your first campaign today.</h2>
            <p className="text-secondary max-w-[46ch] mx-auto">
              Connect a channel, import a list, and see what your workforce drafts. You approve before anything sends.
            </p>
            <Button href="/login" className="inline-flex">Get started</Button>
          </div>
        </div>
      </Reveal>

      {/* Footer */}
      <footer className="flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted border-t border-line pt-8">
        <div className="font-display font-medium text-slate-200">OutreachPilot</div>
        <div className="flex gap-4">
          <a href="#workforce" className="hover:text-slate-200">Workforce</a>
          <a href="#outreach" className="hover:text-slate-200">Outreach</a>
          <Link href="/login" className="hover:text-slate-200">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}
