import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

export type TooltipSide = 'right' | 'left' | 'top' | 'bottom';

interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  delay?: number;
  className?: string;
  block?: boolean;
  disabled?: boolean;
}

export function Tooltip({
  label,
  children,
  side = 'right',
  delay = 220,
  className,
  block = false,
  disabled = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    side: TooltipSide;
  } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPosition(null);
  }, [clearTimer]);

  const show = useCallback(
    (immediate: boolean) => {
      if (disabled || !label) return;
      clearTimer();
      if (immediate) {
        setOpen(true);
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setOpen(true);
      }, delay);
    },
    [clearTimer, delay, disabled, label],
  );

  useEffect(() => hide, [hide]);

  useEffect(() => {
    if (!open) return;
    const onViewportChange = (): void => hide();
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [hide, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;

    const gap = 9;
    const pad = 8;
    const box = anchor.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();

    let nextSide = side;
    if (nextSide === 'right' && box.right + gap + size.width > window.innerWidth - pad) {
      nextSide = 'left';
    } else if (nextSide === 'left' && box.left - gap - size.width < pad) {
      nextSide = 'right';
    } else if (nextSide === 'top' && box.top - gap - size.height < pad) {
      nextSide = 'bottom';
    } else if (nextSide === 'bottom' && box.bottom + gap + size.height > window.innerHeight - pad) {
      nextSide = 'top';
    }

    let left: number;
    let top: number;
    if (nextSide === 'right' || nextSide === 'left') {
      left = nextSide === 'right' ? box.right + gap : box.left - gap - size.width;
      top = box.top + box.height / 2 - size.height / 2;
    } else {
      left = box.left + box.width / 2 - size.width / 2;
      top = nextSide === 'top' ? box.top - gap - size.height : box.bottom + gap;
    }

    setPosition({
      left: Math.max(pad, Math.min(left, window.innerWidth - size.width - pad)),
      top: Math.max(pad, Math.min(top, window.innerHeight - size.height - pad)),
      side: nextSide,
    });
  }, [open, side]);

  return (
    <>
      <span
        ref={anchorRef}
        className={cn('tip-anchor', block ? 'tip-anchor-block' : 'tip-anchor-inline', className)}
        onMouseEnter={() => show(false)}
        onMouseLeave={hide}
        onFocus={() => show(true)}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hide();
        }}
      >
        {children}
      </span>
      {open
        ? createPortal(
            <div
              ref={bubbleRef}
              role="tooltip"
              className={cn('tip', position ? `tip-${position.side}` : 'tip-right')}
              style={{
                left: position?.left ?? -9999,
                top: position?.top ?? -9999,
                visibility: position ? 'visible' : 'hidden',
              }}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
