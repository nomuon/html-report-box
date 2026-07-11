import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  detail?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, detail, action }: EmptyStateProps) {
  return (
    <div className="hrb-empty">
      <div className="hrb-empty__icon" aria-hidden="true">
        {icon}
      </div>
      <h2 className="hrb-empty__title">{title}</h2>
      {detail && <p className="hrb-empty__detail">{detail}</p>}
      {action && <div className="hrb-empty__action">{action}</div>}
    </div>
  );
}
