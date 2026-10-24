import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  readonly label: string;
  readonly children: ReactNode;
  readonly tone?: 'default' | 'danger';
}

export function IconButton({
  label,
  children,
  className,
  tone = 'default',
  type = 'button',
  ...props
}: IconButtonProps): ReactElement {
  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      title={label}
      className={cx('icon-button', tone === 'danger' && 'icon-button-danger', className)}
    >
      {children}
    </button>
  );
}
