import type { HTMLAttributes, ReactElement } from 'react';
import { cx } from '../../lib/cx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: 'default' | 'strong';
}

export function Card({ className, tone = 'default', ...props }: CardProps): ReactElement {
  return <div {...props} className={cx('card', tone === 'strong' && 'card-strong', className)} />;
}
