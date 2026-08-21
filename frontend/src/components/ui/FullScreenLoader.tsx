import { createContext, useContext, useState, type ReactNode } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

type LoaderStatus = 'loading' | 'success' | 'error';

interface LoaderContextType {
  showLoader: (message?: string) => void;
  showSuccess: (message: string, duration?: number) => Promise<void>;
  showError: (message: string, duration?: number) => Promise<void>;
  hideLoader: () => void;
}

const LoaderContext = createContext<LoaderContextType | null>(null);

export const useLoader = () => {
  const context = useContext(LoaderContext);
  if (!context) throw new Error('useLoader must be used within LoaderProvider');
  return context;
};

export const LoaderProvider = ({ children }: { children: ReactNode }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<LoaderStatus>('loading');
  const [message, setMessage] = useState('');

  const showLoader = (msg = 'Processing...') => {
    setStatus('loading');
    setMessage(msg);
    setIsOpen(true);
  };

  const hideLoader = () => setIsOpen(false);

  const showSuccess = (msg: string, duration = 1500) => {
    return new Promise<void>((resolve) => {
      setStatus('success');
      setMessage(msg);
      setIsOpen(true);
      setTimeout(() => {
        hideLoader();
        resolve();
      }, duration);
    });
  };

  const showError = (msg: string, duration = 2000) => {
    return new Promise<void>((resolve) => {
      setStatus('error');
      setMessage(msg);
      setIsOpen(true);
      setTimeout(() => {
        hideLoader();
        resolve();
      }, duration);
    });
  };

  return (
    <LoaderContext.Provider value={{ showLoader, showSuccess, showError, hideLoader }}>
      {children}
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-background/50 backdrop-blur-sm animate-fade-in">
          <div className="bg-surface border border-border rounded-2xl p-8 shadow-xl flex flex-col items-center min-w-[250px] animate-spring-up">
            {status === 'loading' && <Loader2 className="w-12 h-12 animate-spin text-accent mb-4" />}
            {status === 'success' && <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-4 animate-fade-in" />}
            {status === 'error' && <XCircle className="w-12 h-12 text-destructive mb-4 animate-fade-in" />}
            <p className="text-foreground font-medium text-center">{message}</p>
          </div>
        </div>
      )}
    </LoaderContext.Provider>
  );
};
