import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

/**
 * Gate route tree behind a valid session. Shows a neutral "loading" pane while
 * AuthContext is validating a stored token, then redirects to /login if there's
 * no user. Preserves the original location so the login can bounce back after.
 */
export default function RequireAuth({ children }) {
  const { user, booting } = useAuth();
  const location = useLocation();

  if (booting) {
    return <div className="boot-pane">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return children;
}
