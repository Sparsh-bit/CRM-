import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function WhatsAppHelpIndex() {
  const s = await getSession();
  if (!s) redirect('/login');

  return (
    <div className="space-y-8">
      <Link href="/help" className="text-sm text-muted hover:text-slate-200">← Help</Link>
      <div>
        <h1 className="text-2xl font-semibold">WhatsApp setup</h1>
        <p className="text-sm text-muted mt-1">
          OutreachPilot doesn't send WhatsApp messages directly — it talks to a separate, self-hosted gateway called
          Evolution API, which does the actual WhatsApp connection. <Link href="/help/whatsapp/evolution" className="text-accent">Full Evolution API setup guide →</Link>
        </p>
      </div>

      <div className="card space-y-2">
        <div className="font-medium">Four things have to line up, in order</div>
        <ol className="text-sm text-muted list-decimal list-inside space-y-1">
          <li><strong>Evolution API is running and reachable</strong> — a server your admin runs, reachable at the URL in <code className="text-slate-300">EVOLUTION_API_URL</code>.</li>
          <li><strong>The instance exists</strong> — created from the <Link href="/whatsapp" className="text-accent">WhatsApp</Link> page's "Connect a number" form.</li>
          <li><strong>The phone is paired</strong> — scan the QR code that appears once the instance is created.</li>
          <li><strong>Evolution confirms "open"</strong> — only then does OutreachPilot show the instance as Connected.</li>
        </ol>
        <p className="text-sm text-muted">The status pill on the WhatsApp page always reflects step 4's real answer from Evolution API — never a guess from steps 1–3 alone.</p>
      </div>

      <div className="card space-y-2">
        <div className="font-medium">Reading an error</div>
        <p className="text-sm text-muted">
          A failed connection shows a plain-language reason first (e.g. "Evolution API URL appears to point to the wrong
          service"), with the raw response available under "Technical details" for whoever manages the Evolution
          deployment. <Link href="/help/whatsapp/evolution" className="text-accent">Common errors and what they mean →</Link>
        </p>
      </div>
    </div>
  );
}
