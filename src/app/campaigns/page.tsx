import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';
import { campaignStatusMeta, pillClass } from '@/lib/ui/status';

export const dynamic = 'force-dynamic';

const DEFAULT_SUBJECT = 'Quick idea for {{company | fallback: "your team"}}';
const DEFAULT_BODY = `Hi {{first_name | fallback: "there"}},

I'm {{sender_name}} from {{sender_company}}. We build custom software and AI agents for {{industry | fallback: "businesses"}} teams in {{country | fallback: "your region"}}.

{Most|A lot of} operations we see at companies like {{company | fallback: "yours"}} still run tenders, quotes and job tracking across email and spreadsheets, with no shared system.

If that sounds familiar, I'd map the workflow and show you a working prototype. Would 15 minutes this week be useful?

Best,
{{sender_name}}
{{sender_company}}`;

async function create(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: s.workspaceId } });
  const aiEnabled = String(formData.get('mode')) === 'ai';

  const c = await db.campaign.create({
    data: {
      workspaceId: s.workspaceId,
      name: String(formData.get('name') || 'Untitled campaign'),
      listId: String(formData.get('listId') || '') || null,
      channel: String(formData.get('channel') || 'email'),
      timezone: ws.timezone,
      aiEnabled,
      aiPurpose: String(formData.get('aiPurpose') || '') || null,
      aiCta: String(formData.get('aiCta') || '') || null,
      aiTone: String(formData.get('aiTone') || 'direct, warm, no fluff'),
      aiLanguage: String(formData.get('aiLanguage') || 'English'),
      aiMaxWords: Number(formData.get('aiMaxWords') || 120),
      steps: {
        create: [{
          order: 1,
          channel: String(formData.get('channel')) === 'whatsapp' ? 'whatsapp' : 'email',
          subject: aiEnabled ? null : DEFAULT_SUBJECT,
          body: aiEnabled ? '(written per lead by the AI writer)' : DEFAULT_BODY,
        }],
      },
    },
  });
  redirect(`/campaigns/${c.id}`);
}

export default async function Campaigns({ searchParams }: { searchParams: Promise<{ list?: string }> }) {
  const s = await getSession();
  if (!s) redirect('/login');
  const { list: preselect } = await searchParams;

  const [lists, campaigns] = await Promise.all([
    db.leadList.findMany({ where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'desc' } }),
    db.campaign.findMany({
      where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'desc' },
      include: { _count: { select: { messages: true } } },
    }),
  ]);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Campaigns</h1>

      <div className="card p-0 overflow-hidden">
        <table className="w-full">
          <thead className="bg-ink"><tr>{['Campaign', 'Channel', 'Mode', 'Messages', 'Status'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td className="td"><Link className="text-accent" href={`/campaigns/${c.id}`}>{c.name}</Link></td>
                <td className="td text-muted">{c.channel}</td>
                <td className="td text-muted">{c.aiEnabled ? 'AI writer' : 'template'}</td>
                <td className="td">{c._count.messages}</td>
                <td className="td"><span className={pillClass(campaignStatusMeta(c.status).tone)}>{c.status}</span></td>
              </tr>
            ))}
            {!campaigns.length && <tr><td className="td text-muted" colSpan={5}>No campaigns yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <form action={create} className="card space-y-5">
        <div className="font-medium">New campaign</div>
        <div className="grid md:grid-cols-3 gap-4">
          <div><label className="label">Name</label><input className="input" name="name" placeholder="Saudi contractors – Sept" required /></div>
          <div>
            <label className="label">Lead list</label>
            <select className="input" name="listId" defaultValue={preselect ?? ''} required>
              <option value="">— choose —</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.rowCount})</option>)}
            </select>
          </div>
          <div>
            <label className="label">Channel</label>
            <select className="input" name="channel" defaultValue="email">
              <option value="email">Email</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="both">Both</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">How should the copy be written?</label>
          <div className="grid md:grid-cols-2 gap-3">
            <label className="rounded-lg border border-line p-3 flex gap-3 cursor-pointer">
              <input type="radio" name="mode" value="template" defaultChecked className="mt-1" />
              <span><span className="block text-sm font-medium">One template, merge tags</span>
                <span className="block text-xs text-muted mt-0.5">Fast and predictable. You write it once; {'{{company}}'} and friends fill in per lead.</span></span>
            </label>
            <label className="rounded-lg border border-line p-3 flex gap-3 cursor-pointer">
              <input type="radio" name="mode" value="ai" className="mt-1" />
              <span><span className="block text-sm font-medium">AI writes one message per lead</span>
                <span className="block text-xs text-muted mt-0.5">Reads every column of that lead's row and writes a message specific to their business. You review before anything sends.</span></span>
            </label>
          </div>
        </div>

        <details className="rounded-lg border border-line p-4" open>
          <summary className="text-sm cursor-pointer">AI writer settings</summary>
          <div className="space-y-4 mt-4">
            <div>
              <label className="label">Purpose — what are you mailing them about?</label>
              <textarea className="input h-24" name="aiPurpose"
                placeholder="Introduce Concilio's custom software and AI agent work to Gulf construction, logistics and manufacturing firms, and ask for a 15-minute call with whoever owns operations or IT." />
            </div>
            <div className="grid md:grid-cols-4 gap-4">
              <div><label className="label">Call to action</label><input className="input" name="aiCta" placeholder="15-minute call this week" /></div>
              <div><label className="label">Tone</label><input className="input" name="aiTone" defaultValue="direct, warm, no fluff" /></div>
              <div><label className="label">Language</label><input className="input" name="aiLanguage" defaultValue="English" /></div>
              <div><label className="label">Max words</label><input className="input" name="aiMaxWords" type="number" defaultValue={120} /></div>
            </div>
          </div>
        </details>

        <button className="btn">Create campaign</button>
      </form>
    </div>
  );
}
