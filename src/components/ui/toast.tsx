import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { cn } from '@/lib/utils';

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
