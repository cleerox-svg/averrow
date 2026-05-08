// averrow-tenant — auth context.
//
// Reads `/api/auth/me` once on mount, hydrates a User shape from the
// existing trust-radar backend. Mirrors averrow-ops's lib/auth.tsx.
// Logged-out state shows a redirect to the login flow (handled by
// the parent worker — averrow-tenant only renders authenticated UI).

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiGet, apiPost, getToken, setToken } from './api';

export interface UserOrganization {
  id:    number;
  name:  string;
  slug:  string;
  plan:  string;
  role:  string;
}

export interface User {
  id:           string;
  email:        string;
  name:         string;
  role:         string;
  display_name?: string | null;
  organization?: UserOrganization | null;
}

interface AuthContextShape {
  user:    User | null;
  loading: boolean;
  error:   string | null;
  logout:  () => Promise<void>;
  isSuperAdmin: boolean;
  /** True once we know the user has an organization bound. */
  hasOrg:  boolean;
}

const AuthContext = createContext<AuthContextShape | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,    setUser]    = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    apiGet<User>('/api/auth/me')
      .then((res) => setUser(res.data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const logout = async () => {
    // Hit the backend so the refresh cookie + session row are
    // revoked. Best-effort — a network failure here still proceeds
    // with the local teardown so the user isn't trapped on the
    // shell.
    try {
      await apiPost('/api/auth/logout', {});
    } catch {
      /* swallow */
    }
    setToken(null);
    setUser(null);
    // Hard-navigate so the next session bootstrap (token-less)
    // hits the parent worker's session-aware login redirect.
    window.location.href = '/';
  };

  const ctx: AuthContextShape = {
    user,
    loading,
    error,
    logout,
    isSuperAdmin: user?.role === 'super_admin',
    hasOrg:       !!user?.organization,
  };

  return <AuthContext.Provider value={ctx}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextShape {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
