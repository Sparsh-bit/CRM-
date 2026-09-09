import { WorkforceSubnav } from './_components/WorkforceSubnav';

export default function WorkforceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Workforce</h1>
        <p className="text-secondary mt-1.5">Your AI employees, their work, and what&apos;s waiting on you.</p>
      </div>
      <WorkforceSubnav />
      {children}
    </div>
  );
}
