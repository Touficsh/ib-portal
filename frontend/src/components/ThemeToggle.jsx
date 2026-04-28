import { useEffect, useState } from 'react';

/**
 * Theme toggle. Stores preference in localStorage under 'crm.portal.theme'
 * ('light' | 'dark'). Applied by setting [data-theme] on <html>, which the
 * CSS variables in styles.css key off for the light-mode override.
 *
 * Defaults to dark on first visit. Responds to the OS preference only if
 * the user hasn't made a choice yet (avoids overriding explicit selections).
 */
const KEY = 'crm.portal.theme';

function readInitial() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  // Respect OS preference on first visit, fall back to dark
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

function apply(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

// Apply the theme as early as possible — called once from main.jsx before React mounts.
export function initTheme() {
  apply(readInitial());
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(readInitial);

  useEffect(() => {
    apply(theme);
    try { localStorage.setItem(KEY, theme); } catch {}
  }, [theme]);

  function toggle() {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }

  const isDark = theme === 'dark';
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Light mode' : 'Dark mode'}
    >
      <span aria-hidden>{isDark ? '☀' : '☾'}</span>
      <span className="theme-toggle-label">{isDark ? 'Light' : 'Dark'}</span>
    </button>
  );
}
