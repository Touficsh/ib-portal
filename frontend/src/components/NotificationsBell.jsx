import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api.js';

/**
 * Notifications bell — polls /api/notifications every 60s, shows a dropdown
 * on click. Uses the staff notifications endpoint (same JWT works for agents).
 * Degrades silently on error (network / permissions) so it never breaks the layout.
 */
export default function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);

  async function load() {
    try {
      const res = await api('/api/notifications?limit=10');
      const list = Array.isArray(res?.notifications) ? res.notifications : Array.isArray(res) ? res : [];
      setItems(list);
      setUnread(Number(res?.unread) || list.filter(n => !n.is_read).length);
    } catch (err) {
      // Silent — 401 means expired token (AuthContext handles); anything else just hide
      if (!(err instanceof ApiError)) return;
      if (err.status === 401 || err.status === 403) return;
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  async function markRead(id) {
    try {
      await api(`/api/notifications/${id}/read`, { method: 'PATCH' });
      load();
    } catch { /* ignore */ }
  }

  return (
    <div className="bell-wrap">
      <button
        className="bell-btn"
        onClick={() => setOpen(o => !o)}
        aria-label={`${unread} unread notifications`}
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && <span className="bell-count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-dropdown" onMouseLeave={() => setOpen(false)}>
          <div className="bell-header">Notifications</div>
          {items.length === 0 ? (
            <div className="bell-empty muted">No notifications</div>
          ) : items.map(n => (
            <div key={n.id} className={`bell-item ${n.is_read ? '' : 'unread'}`} onClick={() => markRead(n.id)}>
              <div className="bell-title">{n.title}</div>
              <div className="bell-msg muted small">{n.message}</div>
              {n.link && <Link to={n.link.replace(/^\/portal/, '')} className="bell-link" onClick={() => setOpen(false)}>View →</Link>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
