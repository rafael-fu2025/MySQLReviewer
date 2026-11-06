import { useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { copyText } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Tooltip, type TooltipSide } from '../Tooltip';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  /** Custom portal tooltip; use this instead of the native `title` attribute. */
  tooltip?: ReactNode;
  tooltipSide?: TooltipSide;
  /** Classes for the tooltip anchor when it participates in a flex layout. */
  tooltipClassName?: string;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  tooltip,
  tooltipSide = 'top',
  tooltipClassName,
  className,
  children,
  disabled,
  title,
  ...rest
}: ButtonProps) {
  // `title` is accepted for compatibility, but always rendered through the
  // custom portal so shared buttons can never fall back to a native tooltip.
  const tooltipLabel = tooltip ?? title;
  const button = (
    <button
      className={cn(
        'btn',
        variant === 'primary' && 'btn-primary',
        variant === 'secondary' && 'btn-secondary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-danger',
        size === 'sm' && 'btn-sm',
        size === 'lg' && 'btn-lg',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="spin" /> : icon}
      {children}
    </button>
  );

  return tooltipLabel ? (
    <Tooltip label={tooltipLabel} side={tooltipSide} className={tooltipClassName}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export function IconButton({
  label,
  className,
  children,
  tooltip = true,
  tooltipSide = 'top',
  title: _title,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  /** False when an external Tooltip wraps this button. */
  tooltip?: boolean;
  tooltipSide?: TooltipSide;
}) {
  const button = (
    <button className={cn('icon-btn', className)} aria-label={label} {...rest}>
      {children}
    </button>
  );

  return tooltip ? (
    <Tooltip label={label} side={tooltipSide}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export function CopyButton({
  text,
  label,
  size = 'sm',
  className,
}: {
  text: string;
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size={size}
      className={className}
      icon={copied ? <Check size={13} className="text-mint" /> : <Copy size={13} />}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        }
      }}
    >
      {label ?? (copied ? 'Copied' : 'Copy')}
    </Button>
  );
}
