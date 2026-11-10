import { useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { copyText } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Tooltip, type TooltipSide } from '../Tooltip';

type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';

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
        'button',
        variant === 'primary' && 'button-primary',
        variant === 'secondary' && 'button-secondary',
        variant === 'tertiary' && 'button-tertiary',
        variant === 'destructive' && 'button-destructive',
        size === 'sm' && 'button-sm',
        size === 'lg' && 'button-lg',
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
    <button className={cn('icon-button', className)} aria-label={label} {...rest}>
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
  // `.pulse-success` blooms a mint ring for ~450ms; the class is dropped on a
  // timeout so the animation can replay on the next copy.
  const [pulse, setPulse] = useState(false);
  return (
    <Button
      variant="tertiary"
      size={size}
      className={cn(className, pulse && 'pulse-success')}
      icon={
        // Both icons always render, grid-stacked, so the swap can animate:
        // the outgoing one eases out through opacity/scale/blur (.icon-off)
        // while the incoming one crossfades in (.icon-crossfade).
        <span className="icon-stack" aria-hidden="true">
          <Copy size={13} className={copied ? 'icon-off' : 'icon-crossfade'} />
          <Check size={13} className={cn('text-mint', copied ? 'icon-crossfade' : 'icon-off')} />
        </span>
      }
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setCopied(true);
          setPulse(true);
          setTimeout(() => setCopied(false), 1_500);
          setTimeout(() => setPulse(false), 500);
        }
      }}
    >
      {label ?? (copied ? 'Copied' : 'Copy')}
    </Button>
  );
}
