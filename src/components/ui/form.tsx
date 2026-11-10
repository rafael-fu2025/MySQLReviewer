import { useState } from 'react';
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('field', className)}>
      {label ? <span className="field-label">{label}</span> : null}
      {children}
      {error ? <span className="text-2xs text-danger">{error}</span> : null}
      {hint && !error ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/**
 * React 19 passes `ref` as an ordinary prop, so the field can be focused by
 * the caller without wrapping the component in `forwardRef`.
 */
export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input className={cn('input', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('textarea', className)} {...rest} />;
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name for the toggle. Required so every switch is announced. */
  label: string;
  disabled?: boolean;
}) {
  // The knob's stretch-and-travel animation (buttons-forms.css) must not play
  // on mount — CSS animations fire the first time their selector matches — so
  // `switch-live` arms it from the first interaction on.
  const [live, setLive] = useState(false);
  return (
    <button
      type="button"
      className={cn('switch', checked && 'on', live && 'switch-live')}
      onClick={() => {
        setLive(true);
        onChange(!checked);
      }}
      aria-label={label}
      aria-pressed={checked}
      disabled={disabled}
    />
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search
        size={13}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        className="input input-search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
