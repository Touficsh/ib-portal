import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, ArrowRight, ShieldCheck, TrendingUp, Link2 } from 'lucide-react';
import { useAuth } from './AuthContext.jsx';
import { ApiError } from '../api.js';
import Button from '../components/ui/Button.jsx';

/**
 * Portal login — split-screen layout.
 *
 *   LEFT : branded/marketing panel (gradient, brand mark, tagline, feature bullets).
 *          Hidden below 840px; the form takes the full width on mobile.
 *   RIGHT: centered form card with icon-led inputs, show/hide password toggle,
 *          loading state, and a trust strip at the bottom.
 *
 * No backend changes — same `login(email, password)` call.
 */

export default function Login() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (user) return <Navigate to="/dashboard" replace />;

  async function onSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) setError('Portal is not enabled. Ask an admin to flip ENABLE_PORTAL.');
        else setError(err.message || 'Invalid email or password.');
      } else {
        setError('Network error. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-v2">
      {/* ------ Left: brand / marketing panel ------ */}
      <aside className="login-hero">
        {/* Decorative floating shapes — purely visual, pointer-events: none */}
        <div className="login-hero-blob login-hero-blob-1" aria-hidden />
        <div className="login-hero-blob login-hero-blob-2" aria-hidden />
        <div className="login-hero-grid" aria-hidden />

        <div className="login-hero-inner">
          <div className="login-hero-brand">
            <div className="login-brand-mark">AP</div>
            <div>
              <div className="login-brand-name">Agent Portal</div>
              <div className="login-brand-sub">by BB Corp</div>
            </div>
          </div>

          <div className="login-hero-copy">
            <h2>Your portal in real time.</h2>
            <p>
              Track commissions across your entire downline, manage agent rates,
              and reconcile with MT5 without leaving the browser.
            </p>
          </div>

          <ul className="login-hero-features">
            <li>
              <div className="login-feature-icon"><TrendingUp size={16} /></div>
              <div>
                <div className="login-feature-title">Live earnings breakdown</div>
                <div className="login-feature-desc">Commission + rebate, per sub-agent, per product.</div>
              </div>
            </li>
            <li>
              <div className="login-feature-icon"><Link2 size={16} /></div>
              <div>
                <div className="login-feature-title">Referral tracking</div>
                <div className="login-feature-desc">Share a link, attribute every new client.</div>
              </div>
            </li>
            <li>
              <div className="login-feature-icon"><ShieldCheck size={16} /></div>
              <div>
                <div className="login-feature-title">Full audit trail</div>
                <div className="login-feature-desc">Every rate change, every engine run, forever.</div>
              </div>
            </li>
          </ul>

          <div className="login-hero-footer">© {new Date().getFullYear()} BB Corp · All rights reserved</div>
        </div>
      </aside>

      {/* ------ Right: form ------ */}
      <main className="login-form-wrap">
        <form className="login-form" onSubmit={onSubmit}>
          {/* Small brand mark at the top — visible on mobile where the hero panel is hidden */}
          <div className="login-form-mark-row">
            <div className="login-brand-mark small">AP</div>
            <span className="login-form-mark-label">Agent Portal</span>
          </div>

          <header className="login-form-header">
            <h1>Welcome back</h1>
            <p>Sign in to access your earnings, network, and referrals.</p>
          </header>

          <div className="login-field">
            <label htmlFor="login-email">Email</label>
            <div className="login-input-wrap">
              <Mail size={15} className="login-input-icon" />
              <input
                id="login-email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                placeholder="you@bbcorp.trade"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </div>
          </div>

          <div className="login-field">
            <label htmlFor="login-password">Password</label>
            <div className="login-input-wrap">
              <Lock size={15} className="login-input-icon" />
              <input
                id="login-password"
                type={showPw ? 'text' : 'password'}
                autoComplete="current-password"
                required
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="login-input-reveal"
                onClick={() => setShowPw(v => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="login-error" role="alert">
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={submitting}
            trailingIcon={!submitting ? <ArrowRight size={16} /> : undefined}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>

          <div className="login-form-footer">
            <ShieldCheck size={12} />
            <span>Protected by encrypted session cookies. Contact support if you need access.</span>
          </div>
        </form>
      </main>
    </div>
  );
}
