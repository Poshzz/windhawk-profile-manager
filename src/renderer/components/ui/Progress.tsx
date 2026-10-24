import type { ReactElement } from 'react';
import { cx } from '../../lib/cx';

export interface ProgressProps {
  readonly value: number;
  readonly max?: number;
  readonly label: string;
  readonly showValue?: boolean;
  readonly tone?: 'accent' | 'success' | 'warning' | 'danger';
  readonly className?: string;
}

export function Progress({
  value,
  max = 100,
  label,
  showValue = false,
  tone = 'accent',
  className,
}: ProgressProps): ReactElement {
  const boundedMax = max > 0 ? max : 100;
  const boundedValue = Math.min(Math.max(value, 0), boundedMax);
  const percent = Math.round((boundedValue / boundedMax) * 100);
  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-[var(--muted)]">{label}</span>
        {showValue ? (
          <span className="text-xs tabular-nums text-[var(--faint)]">{percent}%</span>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-live="polite"
        aria-valuemin={0}
        aria-valuemax={boundedMax}
        aria-valuenow={boundedValue}
        aria-valuetext={`${percent}%`}
        className="progress-track"
      >
        <span
          className={cx('progress-fill', `progress-fill-${tone}`)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
