import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requireSession, getSession, currentRole } from '@/lib/session';
import { decideApproval } from '@/lib/agents/approvals';
import { ApprovalState } from '@/generated/prisma/enums';
import { APPROVAL_STATE_META } from '../_lib/status';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';

export const dynamic = 'force-dynamic';

const CHANNEL_LABEL: Record<string, string> = { send_email: 'Email', send_whatsapp: 'WhatsApp', send_sms: 'SMS' };

/** Outreach proposals (send_email/send_whatsapp/send_sms) share a known shape — render it as a real business decision, not a JSON dump. Anything else falls back to the raw payload, honestly, rather than guessing a structure that might not be there. */
type OutreachContent = { leadName?: string | null; to?: string; subject?: string | null; body?: string; reason?: string };
function isOutreachContent(actionType: string, content: unknown): content is OutreachContent {
  return actionType in CHANNEL_LABEL && !!content && typeof content === 'object';
}

async function decide(formData: FormData) {
  'use server';
  const session = await requireSession();
  const role = await currentRole();
  if (!role) throw new Error('You are not a member of this workspace.');
  const approvalId = String(formData.get('approvalId'));
  const decision = String(formData.get('decision')) === 'Approved' ? 'Approved' : 'Rejected';
  await decideApproval({ workspaceId: session.workspaceId, role }, approvalId, decision, session.userId);
  revalidatePath('/workforce/approvals');
  revalidatePath('/workforce');
}

export default async function ApprovalsPage() {
  const s = await getSession();
  if (!s) redirect('/login');

  const [pending, decided] = await Promise.all([
    db.approval.findMany({
      where: { workspaceId: s.workspaceId, status: ApprovalState.Pending }, orderBy: { createdAt: 'asc' },
      include: { agent: true, task: true },
    }),
    db.approval.findMany({
      where: { workspaceId: s.workspaceId, status: { in: [ApprovalState.Approved, ApprovalState.Rejected] } },
      orderBy: { decidedAt: 'desc' }, take: 20,
      include: { agent: true, task: true },
    }),
  ]);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="text-meta">Waiting on you</div>
        {!pending.length && (
          <Card className="text-secondary">Nothing needs your approval right now.</Card>
        )}
        {pending.map((a) => {
          const outreach = isOutreachContent(a.actionType, a.proposedContent) ? (a.proposedContent as OutreachContent) : null;
          return (
            <Card key={a.id} className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">{a.task.title}</div>
                  <div className="text-secondary mt-0.5">{a.agent.name} · {CHANNEL_LABEL[a.actionType] ?? a.actionType}</div>
                </div>
                <Badge {...APPROVAL_STATE_META[a.status]} />
              </div>

              {outreach ? (
                <div className="rounded-lg bg-ink border border-line p-3 space-y-2">
                  <div className="text-secondary">To <span className="text-slate-200">{outreach.leadName ?? outreach.to ?? '—'}</span></div>
                  {outreach.subject && <div className="text-sm font-medium">{outreach.subject}</div>}
                  {outreach.body && <p className="text-sm text-slate-200 whitespace-pre-wrap">{outreach.body}</p>}
                  {outreach.reason && <div className="text-secondary border-t border-line pt-2">Why: {outreach.reason}</div>}
                </div>
              ) : (
                <pre className="text-xs text-muted whitespace-pre-wrap bg-ink rounded-lg p-3 max-h-48 overflow-auto">
                  {JSON.stringify(a.proposedContent, null, 2)}
                </pre>
              )}

              <div className="flex gap-2">
                <form action={decide}>
                  <input type="hidden" name="approvalId" value={a.id} />
                  <input type="hidden" name="decision" value="Approved" />
                  <Button type="submit">Approve</Button>
                </form>
                <form action={decide}>
                  <input type="hidden" name="approvalId" value={a.id} />
                  <input type="hidden" name="decision" value="Rejected" />
                  <Button type="submit" variant="secondary">Reject</Button>
                </form>
              </div>
            </Card>
          );
        })}
      </section>

      <section className="space-y-3">
        <div className="text-meta">Recent decisions</div>
        <Card className="p-0 overflow-hidden overflow-x-auto">
          <table className="w-full">
            <thead className="bg-ink"><tr>{['Action', 'Agent', 'Decision', 'Decided'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td className="td">{a.task.title} <span className="text-muted">· {CHANNEL_LABEL[a.actionType] ?? a.actionType}</span></td>
                  <td className="td text-muted">{a.agent.name}</td>
                  <td className="td"><Badge {...APPROVAL_STATE_META[a.status]} /></td>
                  <td className="td text-muted">{a.decidedAt?.toLocaleString() ?? '—'}</td>
                </tr>
              ))}
              {!decided.length && <tr><td className="td text-muted" colSpan={4}>No decisions made yet.</td></tr>}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  );
}
