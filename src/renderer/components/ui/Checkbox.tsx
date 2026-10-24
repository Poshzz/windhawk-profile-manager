import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { useId, type ReactElement } from 'react';
import { cx } from '../../lib/cx';

export interface CheckboxProps {
  readonly checked: boolean | 'indeterminate';
  readonly onCheckedChange: (checked: boolean | 'indeterminate') => void;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className,
}: CheckboxProps): ReactElement {
  const id = useId();
  return (
    <div className={cx('flex items-start gap-3', className)}>
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="checkbox-root"
      >
        <CheckboxPrimitive.Indicator className="checkbox-indicator">
          <Check size={13} strokeWidth={3} aria-hidden="true" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-[var(--text)]">
          {label}
        </label>
        {description === undefined ? null : (
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{description}</p>
        )}
      </div>
    </div>
  );
}
