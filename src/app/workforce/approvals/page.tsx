import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requireSession, getSession, currentRole } from '@/lib/session';
import { decideApproval } from '@/lib/agents/approvals';
import { ApprovalState } from '@/generated/prisma/enums';
import { pillClass, APPROVAL_STATE_META } from '../_lib/status';

export const dynamic = 'force-dynamic';

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
        <div className="font-medium">Waiting on you</div>
        {!pending.length && (
          <div className="card text-sm text-muted">Nothing needs your approval right now.</div>
        )}
        {pending.map((a) => (
          <div key={a.id} className="card space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium">{a.task.title}</div>
                <div className="text-xs text-muted mt-0.5">{a.agent.name} · {a.actionType}</div>
              </div>
              <span className={pillClass(APPROVAL_STATE_META[a.status].tone)}>{APPROVAL_STATE_META[a.status].label}</span>
            </div>
            <pre className="text-xs text-muted whitespace-pre-wrap bg-ink rounded-lg p-3 max-h-48 overflow-auto">
              {JSON.stringify(a.proposedContent, null, 2)}
            </pre>
            <div className="flex gap-2">
              <form action={decide}>
                <input type="hidden" name="approvalId" value={a.id} />
                <input type="hidden" name="decision" value="Approved" />
                <button className="btn">Approve</button>
              </form>
              <form action={decide}>
                <input type="hidden" name="approvalId" value={a.id} />
                <input type="hidden" name="decision" value="Rejected" />
                <button className="btn-sec">Reject</button>
              </form>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <div className="font-medium">Recent decisions</div>
        <div className="card p-0 overflow-hidden overflow-x-auto">
          <table className="w-full">
            <thead className="bg-ink"><tr>{['Action', 'Agent', 'Decision', 'Decided'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td className="td">{a.task.title} <span className="text-muted">· {a.actionType}</span></td>
                  <td className="td text-muted">{a.agent.name}</td>
                  <td className="td"><span className={pillClass(APPROVAL_STATE_META[a.status].tone)}>{APPROVAL_STATE_META[a.status].label}</span></td>
                  <td className="td text-muted">{a.decidedAt?.toLocaleString() ?? '—'}</td>
                </tr>
              ))}
              {!decided.length && <tr><td className="td text-muted" colSpan={4}>No decisions made yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
