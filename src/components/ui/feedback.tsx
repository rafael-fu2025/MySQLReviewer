import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  return <div className={cn('skeleton', className)} style={{ width: width ?? '100%', height }} />;
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
    score == null ? '#8896aa' : score >= 80 ? '#2dd4a7' : score >= 60 ? '#f5b544' : '#ff5c6c';

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
      {grade ? <div className="score-grade">{grade}</div> : null}
    </div>
  );
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
