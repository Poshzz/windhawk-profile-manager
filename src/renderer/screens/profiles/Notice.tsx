import { AlertTriangle } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

export type NoticeTone = 'info' | 'warning' | 'danger';

const TONE_CLASSES: Record<NoticeTone, string> = {
  info: 'border-[var(--border)] bg-[var(--card-muted)]',
  warning:
    'border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]',
  danger:
    'border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)]',
};

const TONE_ICON_CLASSES: Record<NoticeTone, string> = {
  info: 'text-[var(--accent)]',
  warning: 'text-[var(--warning)]',
  danger: 'text-[var(--danger)]',
};

export interface NoticeProps {
  readonly tone?: NoticeTone;
  readonly title: string;
  readonly body?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function Notice({
  tone = 'warning',
  title,
  body,
  action,
  className,
}: NoticeProps): ReactElement {
  return (
    <div
      className={`rounded-2xl border p-4 ${TONE_CLASSES[tone]} ${className ?? ''}`}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          size={18}
          className={`mt-0.5 shrink-0 ${TONE_ICON_CLASSES[tone]}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text)]">{title}</p>
          {body === undefined ? null : (
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{body}</p>
          )}
          {action === undefined ? null : <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  );
}
