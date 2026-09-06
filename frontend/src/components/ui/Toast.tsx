import { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextType {
  showToast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextType>({ showToast: () => {} });

export const useToast = () => useContext(ToastContext);

let toastId = 0;

/** Errors stay on screen longer — they usually need to be read and acted on. */
const DURATIONS: Record<ToastType, number> = {
  success: 3500,
  info: 4000,
  warning: 5000,
  error: 6000,
};

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((type: ToastType, message: string) => {
    const id = ++toastId;
    // Cap the stack so a burst of failures cannot cover the whole viewport.
    setToasts((prev) => [...prev, { id, type, message }].slice(-4));
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      <div
        // Announced politely so a toast never interrupts what is being read.
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 top-0 z-[150] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-4 sm:items-end"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};

const ICONS = {
  success: <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />,
  error: <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />,
  warning: <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />,
  info: <Info className="h-4 w-4 text-info" aria-hidden="true" />,
};

const ACCENTS: Record<ToastType, string> = {
  success: 'bg-success',
  error: 'bg-destructive',
  warning: 'bg-warning',
  info: 'bg-info',
};

const ToastItem = ({ toast, onRemove }: { toast: Toast; onRemove: (id: number) => void }) => {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onRemove(toast.id), DURATIONS[toast.type]);
    return () => clearTimeout(timer);
  }, [toast.id, toast.type, paused, onRemove]);

  return (
    <div
      role={toast.type === 'error' ? 'alert' : 'status'}
      // Hovering holds the toast open long enough to read a long message.
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="pointer-events-auto flex w-full max-w-sm animate-slide-in items-start overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
    >
      <span className={`w-1 self-stretch ${ACCENTS[toast.type]}`} aria-hidden="true" />
      <div className="flex flex-1 items-start gap-3 px-3.5 py-3">
        <span className="mt-px shrink-0">{ICONS[toast.type]}</span>
        <p className="flex-1 text-sm text-foreground">{toast.message}</p>
        <button
          type="button"
          onClick={() => onRemove(toast.id)}
          aria-label="Dismiss notification"
          className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-muted transition-colors duration-micro hover:bg-surfaceHover hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
