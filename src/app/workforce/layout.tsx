import { WorkforceSubnav } from './_components/WorkforceSubnav';

export default function WorkforceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Workforce</h1>
        <p className="text-sm text-muted mt-1">Your AI employees, their work, and what's waiting on you.</p>
      </div>
      <WorkforceSubnav />
      {children}
    </div>
  );
}
