import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { Reveal } from './_components/Reveal';

export const metadata = {
  title: 'OutreachPilot: outreach and an AI workforce you control',
  description:
    'Email, WhatsApp and SMS campaigns, a per-lead AI writer, and an AI workforce that drafts and researches. Nothing sends without your approval.',
};

const ROLES = [
  { name: 'Strategy', dept: 'Leadership', note: 'Tracks how campaigns and pipeline are performing.', autonomy: 'Suggest only' },
  { name: 'Research', dept: 'Research', note: 'Builds a picture of a lead or company from your CRM and the open web.', autonomy: 'Suggest only' },
  { name: 'Sales', dept: 'Sales', note: 'Finds and prioritizes the leads worth contacting today.', autonomy: 'Suggest only' },
  { name: 'Marketing', dept: 'Marketing', note: 'Compares campaign performance and audience reach.', autonomy: 'Suggest only' },
  { name: 'Operations', dept: 'Operations', note: 'Keeps an eye on campaign state across the workspace.', autonomy: 'Suggest only' },
  { name: 'Outreach', dept: 'Sales', note: 'Drafts personalized messages and proposes sending them.', autonomy: 'Drafts, needs approval' },
  { name: 'Content Research', dept: 'Research', note: 'Reads public pages, posts and uploaded video for real signal.', autonomy: 'Suggest only' },
];

export default async function LandingPage() {
  const s = await getSession();
  if (s) redirect('/');

  return (
    <div className="space-y-24 pb-24 overflow-x-hidden">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 pt-2">
        <Link href="/landing" className="font-semibold tracking-tight">OutreachPilot</Link>
        <nav className="hidden md:flex items-center gap-1 text-sm text-muted">
          <a href="#workforce" className="px-3 py-1.5 rounded-md hover:text-slate-100 hover:bg-line">Workforce</a>
          <a href="#outreach" className="px-3 py-1.5 rounded-md hover:text-slate-100 hover:bg-line">Outreach</a>
          <a href="#how-it-works" className="px-3 py-1.5 rounded-md hover:text-slate-100 hover:bg-line">How it works</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login" className="text-sm text-muted hover:text-slate-100 px-2">Sign in</Link>
          <Link href="/login" className="btn text-sm">Get started</Link>
        </div>
      </header>

      {/* Hero */}
      <section className="grid lg:grid-cols-2 gap-12 items-center">
        <div className="space-y-5">
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1]">
            Multichannel outreach, run by an AI workforce you control.
          </h1>
          <p className="text-base text-muted max-w-[46ch]">
            Email, WhatsApp and SMS campaigns, a per-lead AI writer, and an AI workforce
            that drafts and researches, pending your approval.
          </p>
          <div className="flex gap-3">
            <Link href="/login" className="btn">Get started</Link>
            <a href="#workforce" className="btn-sec">See the workforce</a>
          </div>
        </div>

        <Reveal>
          <div className="card space-y-4" aria-hidden="true">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Needs attention</div>
              <span className="pill pill-warn">Pending</span>
            </div>
            <div className="flex items-start justify-between gap-4 border-t border-line pt-3">
              <div>
                <div className="text-sm font-medium">Draft intro email to Northwind Logistics</div>
                <div className="text-xs text-muted mt-0.5">Outreach · send_email · needs approval</div>
              </div>
              <span className="btn-sec text-xs shrink-0 pointer-events-none">Review</span>
            </div>
            <div className="border-t border-line pt-3 space-y-2">
              {[{ n: 'Research', s: 'Active' }, { n: 'Sales', s: 'Active' }, { n: 'Outreach', s: 'Active' }].map((a) => (
                <div key={a.n} className="flex items-center justify-between text-sm">
                  <span>{a.n}</span>
                  <span className="pill pill-good">{a.s}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted mt-2 text-center">A preview of the Workforce overview inside the product.</p>
        </Reveal>
      </section>

      {/* How it works */}
      <Reveal>
        <section id="how-it-works" className="space-y-8">
          <h2 className="text-2xl font-semibold">Three steps to your first send.</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              { t: 'Connect your channels', d: 'A mailbox over SMTP, Resend, Gmail or Outlook, plus WhatsApp and SMS if you use them.' },
              { t: 'Import your leads', d: 'Any spreadsheet. Columns and headers are detected automatically, no template to match.' },
              { t: 'Turn on your workforce', d: 'Agents draft, research and propose. You approve every send before it goes out.' },
            ].map((step) => (
              <div key={step.t} className="space-y-2">
                <div className="font-medium">{step.t}</div>
                <p className="text-sm text-muted">{step.d}</p>
              </div>
            ))}
          </div>
        </section>
      </Reveal>

      {/* Outreach */}
      <Reveal>
        <section id="outreach" className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-4 order-2 lg:order-1">
            <div className="card space-y-3" aria-hidden="true">
              <div className="text-sm font-medium">New campaign</div>
              <div className="rounded-lg border border-line p-3">
                <div className="text-sm font-medium">One template, merge tags</div>
                <div className="text-xs text-muted mt-0.5">Fast and predictable. Write it once, fill in the blanks per lead.</div>
              </div>
              <div className="rounded-lg border border-accent p-3">
                <div className="text-sm font-medium">AI writes one message per lead</div>
                <div className="text-xs text-muted mt-0.5">Reads every column of that lead's row and writes something specific to their business.</div>
              </div>
            </div>
          </div>
          <div className="space-y-4 order-1 lg:order-2">
            <h2 className="text-2xl font-semibold">One inbox of leads, three channels out.</h2>
            <p className="text-sm text-muted max-w-[52ch]">
              Run the same list through email, WhatsApp and SMS. Write one template with merge tags,
              or let the AI writer draft something specific to each lead's business. You review before anything sends.
            </p>
          </div>
        </section>
      </Reveal>

      {/* Workforce */}
      <Reveal>
        <section id="workforce" className="space-y-8">
          <div className="max-w-[60ch] space-y-3">
            <h2 className="text-2xl font-semibold">An AI workforce, not a single chatbot.</h2>
            <p className="text-sm text-muted">
              Seven named roles, each with its own objective and a defined set of permissions.
              Autonomy ranges from suggestions only to drafting and proposing, but every proposed
              send still opens a real approval. Only an explicit, admin-set policy can skip a human.
            </p>
          </div>

          <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mx-1 px-1">
            {ROLES.map((r) => (
              <div key={r.name} className="card shrink-0 w-64 snap-start space-y-2">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-line flex items-center justify-center text-xs font-semibold shrink-0">
                    {r.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{r.name}</div>
                    <div className="text-xs text-muted truncate">{r.dept}</div>
                  </div>
                </div>
                <p className="text-xs text-muted">{r.note}</p>
                <span className={`pill ${r.autonomy === 'Suggest only' ? 'pill-muted' : 'pill-accent'}`}>{r.autonomy}</span>
              </div>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-6 items-center">
            <p className="text-sm text-muted max-w-[52ch]">
              Every proposal, every approval and every decision is logged, scoped to your workspace,
              and visible on the same activity trail. Nothing runs unattended unless you turn it on.
            </p>
            <div className="card space-y-3" aria-hidden="true">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">Send intro email to Northwind Logistics</div>
                  <div className="text-xs text-muted mt-0.5">Outreach · send_email</div>
                </div>
                <span className="pill pill-warn">Pending</span>
              </div>
              <div className="flex gap-2">
                <span className="btn text-xs pointer-events-none">Approve</span>
                <span className="btn-sec text-xs pointer-events-none">Reject</span>
              </div>
            </div>
          </div>
        </section>
      </Reveal>

      {/* Research, usage, reliability */}
      <Reveal>
        <section className="grid md:grid-cols-2 gap-6">
          <div className="card md:col-span-2 space-y-3">
            <h3 className="font-medium">Research that goes beyond your CRM</h3>
            <p className="text-sm text-muted max-w-[60ch]">
              Public web pages, Instagram posts and uploaded video or audio, analyzed for business model,
              audience and adaptation signal. Real extraction and analysis, never invented.
            </p>
            <div className="flex flex-wrap gap-2">
              {['Web pages', 'Instagram', 'Uploaded video and audio'].map((t) => (
                <span key={t} className="pill pill-muted">{t}</span>
              ))}
            </div>
          </div>
          <div className="card space-y-3">
            <h3 className="font-medium">Usage you can actually see</h3>
            <p className="text-sm text-muted">
              Real per-workspace metering against your plan, not an estimate: AI requests, agent tasks,
              messages sent, leads imported, storage used.
            </p>
          </div>
          <div className="card space-y-3">
            <h3 className="font-medium">Nothing invented, nothing hidden</h3>
            <p className="text-sm text-muted">
              The same health checks the team runs in production, covering the database, the AI provider and the send queue.
            </p>
          </div>
        </section>
      </Reveal>

      {/* Final CTA, full-bleed */}
      <Reveal>
        <div className="relative left-1/2 right-1/2 -mx-[50vw] w-screen bg-panel border-y border-line">
          <div className="max-w-6xl mx-auto px-6 py-16 text-center space-y-5">
            <h2 className="text-2xl md:text-3xl font-semibold">Set up your first campaign today.</h2>
            <p className="text-sm text-muted max-w-[46ch] mx-auto">
              Connect a channel, import a list, and see what your workforce drafts. You approve before anything sends.
            </p>
            <Link href="/login" className="btn inline-flex">Get started</Link>
          </div>
        </div>
      </Reveal>

      {/* Footer */}
      <footer className="flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted border-t border-line pt-8">
        <div className="font-medium text-slate-200">OutreachPilot</div>
        <div className="flex gap-4">
          <a href="#workforce" className="hover:text-slate-200">Workforce</a>
          <a href="#outreach" className="hover:text-slate-200">Outreach</a>
          <Link href="/login" className="hover:text-slate-200">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}
