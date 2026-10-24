import { Inbox } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
  readonly className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div className={cx('empty-state', className)}>
      <div className="empty-state-icon" aria-hidden="true">
        {icon ?? <Inbox size={22} />}
      </div>
      <h3 className="mt-4 text-base font-semibold text-[var(--text)]">{title}</h3>
      {description === undefined ? null : (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-[var(--muted)]">{description}</p>
      )}
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </div>
  );
}
