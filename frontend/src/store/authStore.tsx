import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@eventreach/shared';
import api from '../services/api';
import { profileFromStorageEvent, sameProfile } from '../utils/accessSync';

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  updateUser: (fields: Partial<User>) => void;
  /**
   * Re-reads this account from the server (GET /auth/me) and adopts the answer.
   * Returns what the profile was and is now, or null if the read failed or
   * there is no session. A 401 means the session is over: it is cleared.
   */
  refreshUser: () => Promise<{ before: User | null; after: User } | null>;
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
  // The profile as of the latest answer, readable between renders.
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  // The token a sign-in has just been given. That answer came from the server a
  // moment ago, so the session restore the new token triggers must not ask /auth/me
  // for the same profile again.
  const freshSignIn = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      if (!token) {
        setUser(null);
        setIsLoading(false);
        return;
      }

      if (freshSignIn.current === token) {
        freshSignIn.current = null;
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

  const refreshUser = useCallback(async () => {
    if (!localStorage.getItem('token')) return null;
    try {
      const response = await api.get('/auth/me');
      const fresh: User = response.data.user;
      const before = userRef.current;
      userRef.current = fresh;
      // An unchanged answer keeps the same object, so nothing re-renders.
      setUser((prev) => (sameProfile(prev, fresh) ? prev : fresh));
      localStorage.setItem('user', JSON.stringify(fresh));
      return { before, after: fresh };
    } catch (error: any) {
      if (error?.response?.status === 401) {
        // Revoked, expired, deleted, or the password was reset: the session is over.
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setToken(null);
        setUser(null);
      }
      // Any other failure keeps what is shown; the next trigger retries.
      return null;
    }
  }, []);

  // Another tab of this account re-read its permissions: follow it, so a tab
  // whose own push was missed still agrees. Another account's profile is ignored.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const adopted = profileFromStorageEvent(event, userRef.current);
      if (adopted) {
        userRef.current = adopted;
        setUser(adopted);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const login = (newToken: string, newUser: User) => {
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(newUser));
    freshSignIn.current = newToken;
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
    <AuthContext.Provider value={{ user, token, login, logout, updateUser, refreshUser, isLoading }}>
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
