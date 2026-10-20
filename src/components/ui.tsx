import React, {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Info,
  Loader2,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import type { Finding, Severity } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { copyText } from '@/lib/format';

export const cn = clsx;

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
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
}

export function IconButton({
  label,
  className,
  children,
  nativeTitle = true,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  nativeTitle?: boolean;
}) {
  return (
    <button
      className={cn('icon-btn', className)}
      title={nativeTitle ? label : undefined}
      aria-label={label}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

export function Card({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('card', className)} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="section-title">{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <div className="page-title">{title}</div>
        {subtitle ? <div className="page-sub">{subtitle}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: 'ember' | 'mint' | 'danger' | 'warn' | 'info';
}) {
  return (
    <div className="stat">
      <div className="flex items-center justify-between gap-2">
        <div className="stat-label">{label}</div>
        {icon ? (
          <span
            className={cn(
              'opacity-70',
              tone === 'ember' && 'text-ember',
              tone === 'mint' && 'text-mint',
              tone === 'danger' && 'text-danger',
              tone === 'warn' && 'text-warn',
              tone === 'info' && 'text-info',
            )}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

export type BadgeTone = 'neutral' | 'ember' | 'mint' | 'danger' | 'warn' | 'info';

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'badge',
        tone === 'ember' && 'badge-ember',
        tone === 'mint' && 'badge-mint',
        tone === 'danger' && 'badge-danger',
        tone === 'warn' && 'badge-warn',
        tone === 'info' && 'badge-info',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={cn('badge', `sev-${severity}`)}>{severity}</span>;
}

export function FindingSeverityDot({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 rounded-full',
        severity === 'critical' && 'bg-[#ff5c6c]',
        severity === 'high' && 'bg-[#ff8a95]',
        severity === 'medium' && 'bg-warn',
        severity === 'low' && 'bg-mint',
        severity === 'info' && 'bg-info',
      )}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

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
      {error ? <span className="text-[10.5px] text-danger">{error}</span> : null}
      {hint && !error ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Input({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input', className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
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
  return (
    <button
      type="button"
      className={cn('switch', checked && 'on')}
      onClick={() => onChange(!checked)}
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

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'default',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'narrow' | 'default' | 'wide';
}) {
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const subtitleId = `${dialogId}-subtitle`;
  const modalRef = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = modalRef.current;
    const selector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = (): HTMLElement[] =>
      Array.from(modal?.querySelectorAll<HTMLElement>(selector) ?? []).filter(
        (element) => element.offsetParent !== null,
      );
    const preferred = modal?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
    );
    (preferred ?? focusables()[0] ?? modal)?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) {
        event.preventDefault();
        modal?.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === modal)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previousFocus.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className={cn('modal', size === 'wide' && 'wide', size === 'narrow' && 'narrow')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" id={titleId}>
              {title}
            </div>
            {subtitle ? (
              <div className="modal-sub" id={subtitleId}>
                {subtitle}
              </div>
            ) : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="narrow"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] text-ink-soft">{message}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Tabs / segmented                                                    */
/* ------------------------------------------------------------------ */

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  ariaLabel = 'Sections',
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();

  const focusTab = (index: number): void => {
    if (items.length === 0) return;
    const next = ((index % items.length) + items.length) % items.length;
    buttons.current[next]?.focus();
    onChange(items[next].id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusTab(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusTab(items.length - 1);
    }
  };

  return (
    <div className={cn('tabs', className)} role="tablist" aria-label={ariaLabel}>
      {items.map((item, index) => {
        const selected = value === item.id;
        return (
          <button
            key={item.id}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${item.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cn('tab', selected && 'active')}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.icon}
            {item.label}
            {item.count != null ? <span className="tab-count">{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(option.value === value && 'active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cn('spin', className)} />;
}

export function Skeleton({
  width,
  height = 12,
  className,
}: {
  width?: number | string;
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={cn('skeleton', className)}
      style={{ width: width ?? '100%', height }}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="progress">
      <div style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  copy,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  copy?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <div className="empty-title">{title}</div>
      {copy ? <div className="empty-copy">{copy}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
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

export function ScoreRing({
  score,
  grade,
  size = 116,
  stroke = 9,
}: {
  score: number | null;
  grade?: string;
  size?: number;
  stroke?: number;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const value = score ?? 0;
  const offset = circumference * (1 - value / 100);
  const color =
    score == null
      ? '#8896aa'
      : score >= 80
        ? '#2dd4a7'
        : score >= 60
          ? '#f5b544'
          : '#ff5c6c';

  return (
    <div className="score-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-panel-3)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(.2,.8,.2,1)' }}
        />
      </svg>
      <div className="score-num" style={{ fontSize: size * 0.26 }}>
        {score == null ? '—' : score}
      </div>
      <div className="score-grade">{grade ?? 'SCORE'}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function ToastViewport() {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);
  return createPortal(
    <div className="toast-viewport">
      {toasts.map((toast) => (
        <div key={toast.id} className={cn('toast', toast.type)}>
          <span className="mt-0.5 shrink-0">
            {toast.type === 'success' ? (
              <CheckCircle2 size={15} className="text-mint" />
            ) : toast.type === 'error' ? (
              <XCircle size={15} className="text-danger" />
            ) : toast.type === 'warn' ? (
              <AlertTriangle size={15} className="text-warn" />
            ) : (
              <Info size={15} className="text-info" />
            )}
          </span>
          <div className="min-w-0 flex-1 whitespace-pre-wrap">{toast.message}</div>
          <button
            type="button"
            className="text-muted hover:text-ink"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function severityCounts(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const listener = (): void => setMatches(media.matches);
    media.addEventListener('change', listener);
    setMatches(media.matches);
    return () => media.removeEventListener('change', listener);
  }, [query]);
  return matches;
}

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function countByTone(severity: Severity): BadgeTone {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'danger';
    case 'medium':
      return 'warn';
    case 'low':
      return 'mint';
    default:
      return 'info';
  }
}

export function LoadingBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton key={index} width={`${90 - index * 12}%`} height={12} />
      ))}
    </div>
  );
}

export function useCopyAction(): (text: string) => Promise<void> {
  return useMemo(
    () => async (text: string) => {
      await copyText(text);
    },
    [],
  );
}
