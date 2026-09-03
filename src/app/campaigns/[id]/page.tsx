import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';
import { enqueue } from '@/lib/queue';
import { preflight, buildQueue, leadMergeContext } from '@/lib/campaign';
import { render, extractTags } from '@/lib/template';

export const dynamic = 'force-dynamic';

async function guard(campaignId: string) {
  const s = await getSession();
  if (!s) redirect('/login');
  const c = await db.campaign.findFirstOrThrow({
    where: { id: campaignId, workspaceId: s.workspaceId },
    include: { steps: { orderBy: { order: 'asc' } }, workspace: true, list: true },
  });
  return { s, c };
}

async function saveStep(formData: FormData) {
  'use server';
  const id = String(formData.get('campaignId'));
  await guard(id);
  await db.campaignStep.update({
    where: { id: String(formData.get('stepId')) },
    data: {
      subject: String(formData.get('subject') || '') || null,
      body: String(formData.get('body') || ''),
      delayDays: Number(formData.get('delayDays') || 0),
      condition: String(formData.get('condition') || 'no_reply'),
    },
  });
  redirect(`/campaigns/${id}`);
}

async function addStep(formData: FormData) {
  'use server';
  const id = String(formData.get('campaignId'));
  const { c } = await guard(id);
  const order = (c.steps.at(-1)?.order ?? 0) + 1;
  await db.campaignStep.create({
    data: {
      campaignId: id, order, channel: c.channel === 'whatsapp' ? 'whatsapp' : 'email',
      delayDays: 3, condition: 'no_reply',
      subject: c.channel === 'whatsapp' ? null : 'Re: {{company | fallback: "quick follow-up"}}',
      body: `Hi {{first_name | fallback: "there"}},\n\nBringing this back to the top of your inbox in case it got buried. Worth a short call?\n\n{{sender_name}}`,
    },
  });
  redirect(`/campaigns/${id}`);
}

async function saveSchedule(formData: FormData) {
  'use server';
  const id = String(formData.get('campaignId'));
  await guard(id);
  const days = ['0','1','2','3','4','5','6'].filter((d) => formData.get(`day_${d}`) === 'on').map(Number);
  await db.campaign.update({
    where: { id },
    data: {
      sendDays: days.length ? days : [1, 2, 3, 4, 5],
      sendStartHour: Number(formData.get('startHour') || 9),
      sendEndHour: Number(formData.get('endHour') || 18),
      timezone: String(formData.get('timezone') || 'Asia/Kolkata'),
      trackOpens: formData.get('trackOpens') === 'on',
      trackClicks: formData.get('trackClicks') === 'on',
      stopOnReply: formData.get('stopOnReply') === 'on',
      aiPurpose: String(formData.get('aiPurpose') || '') || null,
    },
  });
  redirect(`/campaigns/${id}`);
}

async function generate(formData: FormData) {
  'use server';
  const id = String(formData.get('campaignId'));
  const { s } = await guard(id);
  await enqueue(s.workspaceId, 'generate_drafts', { campaignId: id });
  redirect(`/campaigns/${id}?generating=1`);
}

async function saveDraft(formData: FormData) {
  'use server';
  const id = String(formData.get('campaignId'));
  await guard(id);
  await db.draft.update({
    where: { id: String(formData.get('draftId')) },
    data: {
      subject: String(formData.get('subject') || '') || null,
      body: String(formData.get('body') || ''),
      approved: true, edited: true,
    },
  });
  redirect(`/campaigns/${id}#drafts`);
}

async function approveAll(formData: FormData) {
  'use server';
  const id = String(formData.get('campaignId'));
  await guard(id);
  await db.draft.updateMany({ where: { campaignId: id }, data: { approved: true } });
  redirect(`/campaigns/${id}#drafts`);
}

async function launch(formData: FormData) {
  'use server';
  const id = String(formData.get('campaignId'));
  const { c } = await guard(id);
  const pf = await preflight(id);
  if (!pf.ok) redirect(`/campaigns/${id}?error=preflight`);
  await buildQueue(id);
  await db.campaign.update({ where: { id }, data: { status: 'running', startedAt: c.startedAt ?? new Date() } });
  redirect(`/campaigns/${id}`);
}

async function pause(formData: FormData) {
  'use server';
  const id = String(formData.get('campaignId'));
  const { c } = await guard(id);
  await db.campaign.update({ where: { id }, data: { status: c.status === 'paused' ? 'running' : 'paused' } });
  redirect(`/campaigns/${id}`);
}

export default async function CampaignDetail({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; generating?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { c } = await guard(id);

  const [pf, drafts, stats, sample] = await Promise.all([
    preflight(id).catch(() => null),
    db.draft.findMany({ where: { campaignId: id }, include: { lead: true }, orderBy: { createdAt: 'asc' }, take: 50 }),
    db.message.groupBy({ by: ['status'], where: { campaignId: id }, _count: true }),
    c.listId ? db.lead.findFirst({ where: { listId: c.listId } }) : null,
  ]);

  const counts = Object.fromEntries(stats.map((r) => [r.status, r._count]));
  const [opened, clicked, replied, draftCount, approvedCount] = await Promise.all([
    db.message.count({ where: { campaignId: id, openedAt: { not: null } } }),
    db.message.count({ where: { campaignId: id, clickedAt: { not: null } } }),
    db.message.count({ where: { campaignId: id, repliedAt: { not: null } } }),
    db.draft.count({ where: { campaignId: id } }),
    db.draft.count({ where: { campaignId: id, approved: true } }),
  ]);
  const sent = counts.sent ?? 0;
  const pct = (n: number) => (sent ? Math.round((n / sent) * 100) : 0);

  const blockers = (pf?.issues ?? []).filter((i) => i.severity === 'block');
  const warns = (pf?.issues ?? []).filter((i) => i.severity === 'warn');

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{c.name}</h1>
          <div className="text-sm text-muted mt-1">
            {c.channel} · {c.aiEnabled ? 'AI writer' : 'template'} · list{' '}
            {c.list ? <Link className="text-accent" href={`/lists/${c.list.id}`}>{c.list.name}</Link> : '—'} ·{' '}
            <span className="pill bg-line text-slate-300">{c.status}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {c.status === 'running' || c.status === 'paused' ? (
            <form action={pause}><input type="hidden" name="campaignId" value={c.id} />
              <button className="btn-sec">{c.status === 'paused' ? 'Resume' : 'Pause'}</button></form>
          ) : null}
          <form action={launch}><input type="hidden" name="campaignId" value={c.id} />
            <button className="btn" disabled={!!blockers.length}>Launch</button></form>
        </div>
      </div>

      {sp.error === 'preflight' && <div className="card border-bad text-sm text-bad">Preflight blocked the launch. Fix the issues below and try again.</div>}
      {sp.generating && <div className="card border-accent text-sm">Draft generation queued. Make sure <code>npm run worker</code> is running, then refresh this page.</div>}

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {([['Queued', counts.queued ?? 0], ['Sent', sent], ['Failed', counts.failed ?? 0], ['Opened', `${opened} · ${pct(opened)}%`], ['Clicked', `${clicked} · ${pct(clicked)}%`], ['Replied', `${replied} · ${pct(replied)}%`]] as const).map(([k, v]) => (
          <div key={k} className="card py-3"><div className="text-xs text-muted">{k}</div><div className="text-lg font-semibold mt-0.5">{v}</div></div>
        ))}
      </div>

      <div className={`card ${blockers.length ? 'border-bad' : 'border-good'}`}>
        <div className="font-medium mb-2">Preflight</div>
        {pf ? (
          <>
            <div className="text-sm text-muted mb-3">{pf.sendable} of {pf.total} leads are ready to send.</div>
            {!blockers.length && !warns.length && <div className="text-sm text-good">All clear.</div>}
            <ul className="space-y-1 text-sm max-h-56 overflow-auto">
              {[...blockers, ...warns].slice(0, 40).map((i, n) => (
                <li key={n} className={i.severity === 'block' ? 'text-bad' : 'text-warn'}>
                  <span className="text-muted">{i.company ?? 'lead'}:</span> {i.message}
                </li>
              ))}
            </ul>
            {blockers.length + warns.length > 40 && <div className="text-xs text-muted mt-2">+{blockers.length + warns.length - 40} more</div>}
          </>
        ) : <div className="text-sm text-muted">Attach a list and a step to run preflight.</div>}
      </div>

      {c.aiEnabled && (
        <div className="card space-y-4" id="drafts">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">AI drafts</div>
              <div className="text-sm text-muted">{approvedCount} approved of {draftCount} generated.</div>
            </div>
            <div className="flex gap-2">
              <form action={generate}><input type="hidden" name="campaignId" value={c.id} /><button className="btn-sec">Generate missing drafts</button></form>
              <form action={approveAll}><input type="hidden" name="campaignId" value={c.id} /><button className="btn-sec">Approve all</button></form>
            </div>
          </div>
          <div className="space-y-3 max-h-[600px] overflow-auto pr-1">
            {drafts.map((d) => (
              <form key={d.id} action={saveDraft} className="rounded-lg border border-line p-3 space-y-2">
                <input type="hidden" name="campaignId" value={c.id} />
                <input type="hidden" name="draftId" value={d.id} />
                <div className="flex justify-between text-xs text-muted">
                  <span>{d.lead.company ?? d.lead.email} · {d.lead.industry ?? '—'} · {d.lead.city ?? d.lead.country ?? '—'}</span>
                  <span className={d.approved ? 'text-good' : 'text-warn'}>{d.approved ? 'approved' : 'needs review'}</span>
                </div>
                {d.channel === 'email' && <input className="input" name="subject" defaultValue={d.subject ?? ''} />}
                <textarea className="input h-40 font-mono text-xs" name="body" defaultValue={d.body} />
                <button className="btn-sec text-xs">Save &amp; approve</button>
              </form>
            ))}
            {!drafts.length && <div className="text-sm text-muted">No drafts yet.</div>}
          </div>
        </div>
      )}

      {!c.aiEnabled && (
        <div className="space-y-4">
          {c.steps.map((step) => {
            const ctx = sample ? leadMergeContext(sample, c.workspace) : {};
            const previewSubject = sample ? render(step.subject ?? '', ctx, sample.id).text : '';
            const previewBody = sample ? render(step.body, ctx, sample.id).text : '';
            return (
              <form key={step.id} action={saveStep} className="card space-y-3">
                <input type="hidden" name="campaignId" value={c.id} />
                <input type="hidden" name="stepId" value={step.id} />
                <div className="flex items-center justify-between">
                  <div className="font-medium">Step {step.order} · {step.channel}</div>
                  {step.order > 1 && (
                    <div className="flex gap-3 items-end">
                      <div><label className="label">Wait (days)</label><input className="input w-24" name="delayDays" type="number" defaultValue={step.delayDays} /></div>
                      <div><label className="label">Send if</label>
                        <select className="input" name="condition" defaultValue={step.condition}>
                          <option value="no_reply">no reply</option><option value="no_open">no open</option><option value="always">always</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>
                {step.channel === 'email' && <div><label className="label">Subject</label><input className="input" name="subject" defaultValue={step.subject ?? ''} /></div>}
                <div><label className="label">Body — merge tags and {'{spin|tax}'} supported</label>
                  <textarea className="input h-56 font-mono text-xs" name="body" defaultValue={step.body} /></div>
                <div className="text-xs text-muted">Tags used: {extractTags(`${step.subject ?? ''} ${step.body}`).map((t) => `{{${t}}}`).join(' ') || 'none'}</div>
                {sample && (
                  <div className="rounded-lg bg-ink border border-line p-3">
                    <div className="text-xs text-muted mb-1">Preview for {sample.company ?? sample.email}</div>
                    {step.channel === 'email' && <div className="text-sm font-medium mb-1">{previewSubject}</div>}
                    <pre className="text-xs whitespace-pre-wrap text-slate-300">{previewBody}</pre>
                  </div>
                )}
                <button className="btn-sec">Save step</button>
              </form>
            );
          })}
          <form action={addStep}><input type="hidden" name="campaignId" value={c.id} /><button className="btn-sec">Add follow-up step</button></form>
        </div>
      )}

      <form action={saveSchedule} className="card space-y-4">
        <div className="font-medium">Schedule &amp; safety</div>
        <div className="flex flex-wrap gap-3">
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => (
            <label key={d} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name={`day_${i}`} defaultChecked={c.sendDays.includes(i)} /> {d}
            </label>
          ))}
        </div>
        <div className="grid md:grid-cols-4 gap-4">
          <div><label className="label">From hour</label><input className="input" name="startHour" type="number" min={0} max={23} defaultValue={c.sendStartHour} /></div>
          <div><label className="label">To hour</label><input className="input" name="endHour" type="number" min={1} max={24} defaultValue={c.sendEndHour} /></div>
          <div><label className="label">Timezone</label><input className="input" name="timezone" defaultValue={c.timezone} /></div>
        </div>
        <div className="flex flex-wrap gap-5 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" name="trackOpens" defaultChecked={c.trackOpens} /> Track opens</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="trackClicks" defaultChecked={c.trackClicks} /> Track clicks</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="stopOnReply" defaultChecked={c.stopOnReply} /> Stop the sequence when they reply</label>
        </div>
        {c.aiEnabled && (
          <div><label className="label">AI purpose</label><textarea className="input h-24" name="aiPurpose" defaultValue={c.aiPurpose ?? ''} /></div>
        )}
        <input type="hidden" name="campaignId" value={c.id} />
        <button className="btn-sec">Save</button>
      </form>
    </div>
  );
}
