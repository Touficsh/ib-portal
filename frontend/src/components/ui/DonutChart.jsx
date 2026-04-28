import { useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

/**
 * DonutChart — distribution of a metric across N slices. Interactive:
 * hovering highlights a slice and shows detail in the center.
 *
 *   <DonutChart
 *     data={[{ name: 'SOPHIA', value: 5867 }, { name: 'Fatima', value: 5099 }, ...]}
 *     centerLabel="Total earnings"
 *     centerValue="$16,480"
 *   />
 */

const DEFAULT_COLORS = [
  'var(--accent)',
  'var(--success)',
  '#a78bfa',    // purple
  'var(--warn)',
  '#f472b6',    // pink
  '#22d3ee',    // cyan
  '#f97316',    // orange
];

function formatMoney(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

export default function DonutChart({
  data,
  height = 240,
  colors = DEFAULT_COLORS,
  centerLabel = 'Total',
  centerValue,
  valueFormat = formatMoney,
}) {
  const [activeIndex, setActiveIndex] = useState(null);
  if (!data || data.length === 0) {
    return <div className="muted" style={{ padding: 'var(--space-5)', textAlign: 'center' }}>No data.</div>;
  }

  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  const active = activeIndex != null ? data[activeIndex] : null;

  return (
    // `minHeight` (not `height`) so the wrap grows vertically when the legend
    // has more items than the donut can span. Without this, legends with 10+
    // items overflow and visually bleed into the table below.
    <div className="ui-donut-wrap" style={{ minHeight: height }}>
      <div className="ui-donut-chart" style={{ minHeight: height }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              innerRadius="65%"
              outerRadius="92%"
              paddingAngle={2}
              stroke="var(--bg-elev)"
              strokeWidth={2}
              onMouseEnter={(_, i) => setActiveIndex(i)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              {data.map((_, i) => (
                <Cell
                  key={i}
                  fill={colors[i % colors.length]}
                  opacity={activeIndex == null || activeIndex === i ? 1 : 0.35}
                  style={{ transition: 'opacity 200ms' }}
                />
              ))}
            </Pie>
            <Tooltip content={<div style={{ display: 'none' }} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="ui-donut-center">
          <div className="ui-donut-center-label">{active ? active.name : centerLabel}</div>
          <div className="ui-donut-center-value">
            {active ? valueFormat(active.value) : (centerValue != null ? centerValue : valueFormat(total))}
          </div>
          {active && (
            <div className="ui-donut-center-pct">
              {((active.value / total) * 100).toFixed(1)}%
            </div>
          )}
        </div>
      </div>
      <ul className="ui-donut-legend">
        {data.map((d, i) => (
          <li
            key={d.name}
            onMouseEnter={() => setActiveIndex(i)}
            onMouseLeave={() => setActiveIndex(null)}
            style={{ opacity: activeIndex == null || activeIndex === i ? 1 : 0.5 }}
          >
            <span className="ui-donut-legend-dot" style={{ background: colors[i % colors.length] }} />
            <span className="ui-donut-legend-name">{d.name}</span>
            <span className="ui-donut-legend-value mono">{valueFormat(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
