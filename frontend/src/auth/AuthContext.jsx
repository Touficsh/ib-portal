import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, getToken, setSession, clearSession, getStoredUser, ApiError } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => getStoredUser());
  const [token, setToken] = useState(() => getToken());
  const [booting, setBooting] = useState(!!getToken());

  // On mount: if we have a token, validate it by calling /me and refresh user profile.
  // Clears the session on 401/403 so the protected layout shows the login screen instead
  // of spinning forever on a stale token.
  useEffect(() => {
    if (!token) { setBooting(false); return; }
    api('/me')
      .then(me => {
        setUser(me);
        setSession(token, me);
      })
      .catch(err => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
          clearSession();
          setUser(null);
          setToken(null);
        }
      })
      .finally(() => setBooting(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (email, password) => {
    const res = await api('/auth/login', { method: 'POST', body: { email, password } });
    setSession(res.token, res.user);
    setToken(res.token);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
    setToken(null);
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await api('/me');
    setUser(me);
    setSession(getToken(), me);
    return me;
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, booting, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
