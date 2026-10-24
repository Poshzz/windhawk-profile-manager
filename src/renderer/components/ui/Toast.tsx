import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '../../lib/cx';
import { IconButton } from './IconButton';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastProps {
  readonly tone?: ToastTone;
  readonly title: string;
  readonly description?: string;
  readonly onDismiss?: () => void;
  readonly className?: string;
}

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
} as const;

export function Toast({
  tone = 'info',
  title,
  description,
  onDismiss,
  className,
}: ToastProps): ReactElement {
  const { t } = useTranslation();
  const Icon = ICONS[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
      className={cx('toast', `toast-${tone}`, className)}
    >
      <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--text)]">{title}</p>
        {description === undefined ? null : (
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{description}</p>
        )}
      </div>
      {onDismiss === undefined ? null : (
        <IconButton label={t('common.dismiss')} onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
