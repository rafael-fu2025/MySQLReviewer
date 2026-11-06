import type { ReactNode } from 'react';
import type { Severity } from '@shared/types';
import { cn } from '@/lib/utils';

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
