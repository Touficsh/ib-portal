import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/**
 * Dashboard earnings chart — stacked area of commission (bottom) + rebate (top)
 * across a range of days. Interactive tooltip renders rich content on hover.
 *
 * Expects data rows of shape { label, commission, rebate, total }.
 */

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  const commission = payload.find(p => p.dataKey === 'commission')?.value || 0;
  const rebate = payload.find(p => p.dataKey === 'rebate')?.value || 0;
  const total = commission + rebate;
  return (
    <div className="ui-chart-tooltip">
      <div className="ui-chart-tooltip-label">{label}</div>
      <div className="ui-chart-tooltip-row">
        <span><span className="ui-chart-dot" style={{ background: 'var(--accent)' }} />Commission</span>
        <b>${commission.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
      </div>
      <div className="ui-chart-tooltip-row">
        <span><span className="ui-chart-dot" style={{ background: 'var(--success)' }} />Rebate</span>
        <b>${rebate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
      </div>
      <div className="ui-chart-tooltip-row total">
        <span>Total</span>
        <b>${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
      </div>
    </div>
  );
}

export default function EarningsChart({ data, height = 220 }) {
  if (!data || data.length === 0) {
    return <div className="muted" style={{ padding: 'var(--space-5)', textAlign: 'center' }}>No earnings in this period.</div>;
  }
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: -10 }}>
          <defs>
            <linearGradient id="comm-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--accent)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="rebate-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--success)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} opacity={0.4} />
          <XAxis
            dataKey="label"
            tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--border)' }}
          />
          <YAxis
            tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`}
            width={55}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'var(--accent)', strokeWidth: 1, strokeOpacity: 0.35 }} />
          <Area
            type="monotone"
            dataKey="commission"
            stackId="1"
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#comm-gradient)"
          />
          <Area
            type="monotone"
            dataKey="rebate"
            stackId="1"
            stroke="var(--success)"
            strokeWidth={2}
            fill="url(#rebate-gradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
