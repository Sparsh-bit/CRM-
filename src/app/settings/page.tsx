import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getSession, requireRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Everything on this page changes what the whole workspace does — the
 * identity on every email and what the AI writer is told to sell. Admin-level.
 */
async function save(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  await requireRole('admin');
  await db.workspace.update({
    where: { id: s.workspaceId },
    data: {
      name: String(formData.get('name') || ''),
      timezone: String(formData.get('timezone') || 'Asia/Kolkata'),
      senderName: String(formData.get('senderName') || ''),
      senderCompany: String(formData.get('senderCompany') || ''),
      companyBlurb: String(formData.get('companyBlurb') || ''),
    },
  });
  redirect('/settings');
}

export default async function Settings() {
  const s = await getSession();
  if (!s) redirect('/login');
  const w = await db.workspace.findUniqueOrThrow({ where: { id: s.workspaceId } });

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <form action={save} className="card space-y-4">
        <div><label className="label">Workspace name</label><input className="input" name="name" defaultValue={w.name} /></div>
        <div><label className="label">Timezone (all sending windows use this)</label><input className="input" name="timezone" defaultValue={w.timezone} /></div>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="label">Sender name</label><input className="input" name="senderName" defaultValue={w.senderName ?? ''} placeholder="Krishna" /></div>
          <div><label className="label">Sender company</label><input className="input" name="senderCompany" defaultValue={w.senderCompany ?? ''} placeholder="Concilio" /></div>
        </div>
        <div>
          <label className="label">What you sell — the AI writer reads this on every draft</label>
          <textarea className="input h-32" name="companyBlurb" defaultValue={w.companyBlurb ?? ''}
            placeholder="We build custom software and AI agents for mid-size businesses: tender CRMs, project ERPs, document-processing agents. Typical first project ships in 4-6 weeks." />
        </div>
        <button className="btn">Save</button>
      </form>
    </div>
  );
}
