import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton, Button } from './button';
import { cn } from '@/lib/utils';

/** How long the panel stays mounted after it starts closing. */
const MODAL_EXIT_MS = 220;

/**
 * The modals that are currently open, oldest first. The last one is on top.
 *
 * A dialog can be opened inside another one - the unlock dialog inside the
 * export dialog - and each of them listens on `window`. Only the topmost
 * modal may react to the keyboard, so Escape in the inner dialog does not
 * close the outer one as well.
 */
const openModals: symbol[] = [];

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'default',
  ariaLabel,
  header,
  bodyClassName,
  footerClassName,
  backdropStyle,
  panelStyle,
  variant = 'center',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'narrow' | 'default' | 'wide';
  /** Accessible name of the dialog. Use it when no visible title is rendered. */
  ariaLabel?: string;
  /** Replaces the default head (title, subtitle and close button). */
  header?: ReactNode;
  /** Class name of the body element. Replaces the default `modal-body`. */
  bodyClassName?: string;
  /** Class name of the footer element. Replaces the default `modal-foot`. */
  footerClassName?: string;
  /** Inline styles for the backdrop element. */
  backdropStyle?: CSSProperties;
  /** Inline styles for the dialog panel element. */
  panelStyle?: CSSProperties;
  /** `sheet` anchors the panel to the bottom of the screen and slides it. */
  variant?: 'center' | 'sheet';
}) {
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const subtitleId = `${dialogId}-subtitle`;
  const hasHeader = header !== undefined && header !== null;
  const hasTitle = title !== undefined && title !== null;
  const labelledBy = !hasHeader && hasTitle && !ariaLabel ? titleId : undefined;
  const accessibleLabel = ariaLabel || (labelledBy ? undefined : 'Dialog');
  const modalRef = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [wasOpen, setWasOpen] = useState(open);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  // Adjusting state as `open` changes keeps the panel mounted through its
  // exit animation, so it can slide away instead of vanishing.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMounted(true);
      setClosing(false);
    } else {
      setClosing(true);
    }
  }

  // Keep the latest handler without writing to a ref during render.
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, MODAL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    if (!mounted) return;
    const id = Symbol('modal');
    openModals.push(id);
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
      // Only the topmost modal reacts to the keyboard.
      if (openModals[openModals.length - 1] !== id) return;
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
      const index = openModals.indexOf(id);
      if (index !== -1) openModals.splice(index, 1);
      window.removeEventListener('keydown', onKey);
      previousFocus.current?.focus?.();
    };
  }, [mounted]);

  if (!mounted) return null;
  return createPortal(
    <div
      className={cn(
        'modal-backdrop',
        variant === 'sheet' && 'modal-sheet-backdrop',
        closing && 'closing',
      )}
      style={backdropStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className={cn(
          'modal',
          size === 'wide' && 'wide',
          size === 'narrow' && 'narrow',
          variant === 'sheet' && 'modal-sheet',
          closing && 'closing',
        )}
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={accessibleLabel}
        aria-describedby={!hasHeader && subtitle ? subtitleId : undefined}
      >
        {hasHeader ? (
          header
        ) : (
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
        )}
        <div className={bodyClassName ?? 'modal-body'}>{children}</div>
        {footer ? <div className={footerClassName ?? 'modal-foot'}>{footer}</div> : null}
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
  confirmLabel,
  danger = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel: string;
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
          <Button variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'destructive' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-soft">{message}</div>
    </Modal>
  );
}
