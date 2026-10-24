import type { ButtonHTMLAttributes, ReactElement } from 'react';
import { cx } from '../../lib/cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps): ReactElement {
  return (
    <button
      {...props}
      type={type}
      className={cx('ui-button', `ui-button-${variant}`, `ui-button-${size}`, className)}
    />
  );
}
