import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
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

  const showLoader = useCallback((msg = 'Processing...') => {
    setStatus('loading');
    setMessage(msg);
    setIsOpen(true);
  }, []);

  const hideLoader = useCallback(() => setIsOpen(false), []);

  const showSuccess = useCallback((msg: string, duration = 1500) => {
    return new Promise<void>((resolve) => {
      setStatus('success');
      setMessage(msg);
      setIsOpen(true);
      setTimeout(() => {
        setIsOpen(false);
        resolve();
      }, duration);
    });
  }, []);

  const showError = useCallback((msg: string, duration = 2000) => {
    return new Promise<void>((resolve) => {
      setStatus('error');
      setMessage(msg);
      setIsOpen(true);
      setTimeout(() => {
        setIsOpen(false);
        resolve();
      }, duration);
    });
  }, []);

  return (
    <LoaderContext.Provider value={{ showLoader, showSuccess, showError, hideLoader }}>
      {children}
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-background/50 backdrop-blur-sm animate-fade-in">
          <div className="flex flex-col items-center animate-spring-up">
            {status === 'loading' && <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-accent mb-4"></div>}
            {status === 'success' && <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-4 animate-fade-in drop-shadow-md" />}
            {status === 'error' && <XCircle className="w-12 h-12 text-destructive mb-4 animate-fade-in drop-shadow-md" />}
            <p className="text-foreground font-medium text-center tracking-wide">{message}</p>
          </div>
        </div>
      )}
    </LoaderContext.Provider>
  );
};
