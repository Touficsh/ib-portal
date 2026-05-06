import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Small "Updated 3s ago" badge.
 *
 * Pair with a useApi-driven page that has auto-refresh — pass `dataAt` from
 * useApi() and the badge ticks every second so the user always sees a current
 * relative timestamp, even between fetches.
 *
 *   const { dataAt, loading } = useApi('/dashboard');
 *   useAutoRefresh(refetch, 30_000);
 *   return <LastUpdated dataAt={dataAt} loading={loading} />;
 *
 * Renders nothing until the first successful fetch.
 */
export default function LastUpdated({ dataAt, loading, label = 'Updated' }) {
  const [, setTick] = useState(0);

  // Re-render every second so the relative-time string stays accurate even
  // while no new data arrives. Cheap because we only re-render this tiny
  // span — React's reconciliation skips the rest of the parent.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!dataAt) return null;

  const ageSec = Math.max(0, Math.round((Date.now() - dataAt.getTime()) / 1000));
  const text =
    ageSec < 5      ? 'just now' :
    ageSec < 60     ? `${ageSec}s ago` :
    ageSec < 3600   ? `${Math.round(ageSec/60)}m ago` :
    ageSec < 86400  ? `${Math.round(ageSec/3600)}h ago` :
                      `${Math.round(ageSec/86400)}d ago`;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        color: 'var(--text-muted)',
      }}
      title={`Last fetched ${dataAt.toLocaleString()}`}
    >
      <RefreshCw
        size={11}
        // Spin the icon while a refetch is in flight; static otherwise.
        // Reuses the existing `.ui-btn-spin` keyframes from styles.css.
        className={loading ? 'ui-btn-spin' : ''}
        style={{ flexShrink: 0 }}
      />
      {label} {text}
    </span>
  );
}
