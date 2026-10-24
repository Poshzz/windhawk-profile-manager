import { AlertTriangle } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface ErrorStateProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function ErrorState({
  title,
  description,
  action,
  className,
}: ErrorStateProps): ReactElement {
  return (
    <div role="alert" className={cx('error-state', className)}>
      <div className="error-state-icon" aria-hidden="true">
        <AlertTriangle size={22} />
      </div>
      <h3 className="mt-4 text-base font-semibold text-[var(--text)]">{title}</h3>
      {description === undefined ? null : (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-[var(--muted)]">{description}</p>
      )}
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </div>
  );
}
