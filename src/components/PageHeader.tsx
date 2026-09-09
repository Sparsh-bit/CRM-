/**
 * One consistent page-title treatment instead of every page picking its own
 * one-off heading size (landing used text-4xl/5xl, login text-xl, onboarding
 * text-2xl, dashboard/workforce ad hoc — no shared component at all before).
 */
export function PageHeader({
  title, description, actions,
}: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="page-title">{title}</h1>
        {description && <p className="text-secondary mt-1.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
