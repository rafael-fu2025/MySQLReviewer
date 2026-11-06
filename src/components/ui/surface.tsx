import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
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
