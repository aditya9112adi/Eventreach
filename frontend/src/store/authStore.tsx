import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@eventreach/shared';
import api from '../services/api';

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  updateUser: (fields: Partial<User>) => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const readCachedUser = (): User | null => {
  try {
    const stored = localStorage.getItem('user');
    return stored ? (JSON.parse(stored) as User) : null;
  } catch {
    return null;
  }
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      if (!token) {
        setUser(null);
        setIsLoading(false);
        return;
      }

      // Paint immediately from the cached profile so the UI does not flash, but
      // treat it as untrusted: the server is the source of truth for identity and
      // role, so it is revalidated below.
      const cached = readCachedUser();
      if (cached && !cancelled) {
        setUser(cached);
        // Stop gating the app on the revalidation round-trip. The cached profile
        // was valid at last sign-in and every API call is still authorized by
        // the JWT server-side, so it is safe to render now and let /auth/me
        // reconcile role/status (or drop a revoked session) a beat later —
        // exactly as it already does when access is revoked mid-session. This is
        // what keeps the app from sitting on the spinner while a cold backend
        // wakes up.
        setIsLoading(false);
      }

      try {
        const response = await api.get('/auth/me');
        if (cancelled) return;
        const fresh: User = response.data.user;
        setUser(fresh);
        localStorage.setItem('user', JSON.stringify(fresh));
      } catch (error: any) {
        if (cancelled) return;
        // 401 means the account was revoked, expired or deleted — drop the session.
        // Any other failure (network/5xx) keeps the cached profile so a transient
        // backend blip does not sign the user out.
        if (error?.response?.status === 401) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          setToken(null);
          setUser(null);
        }
      } finally {
        // No cached profile: the app was blocked on this request, so release it now.
        if (!cancelled) setIsLoading(false);
      }
    };

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const login = (newToken: string, newUser: User) => {
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
  };

  const updateUser = (fields: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return null;
      const updated = { ...prev, ...fields };
      localStorage.setItem('user', JSON.stringify(updated));
      return updated;
    });
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, updateUser, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
