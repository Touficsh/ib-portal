/**
 * Lightweight SVG bar chart — zero dependencies.
 *
 * Props:
 *   data     — array of { label, value } (already sorted by label)
 *   height   — chart height in px (default 140)
 *   yFormat  — optional number formatter for tooltips/axis labels
 *
 * Renders:
 *   - Filled bars sized to fit container width
 *   - Faint dashed baseline at max
 *   - Hover tooltip showing label + value
 */
import { useState } from 'react';

export default function BarChart({ data, height = 140, yFormat }) {
  const [hover, setHover] = useState(null);
  if (!data || data.length === 0) {
    return <div className="chart-empty muted">No data</div>;
  }

  const max = Math.max(...data.map(d => Number(d.value) || 0), 1);
  const padTop = 20;
  const padBottom = 24;
  const innerH = height - padTop - padBottom;
  const barGap = 3;
  // We use viewBox + preserveAspectRatio so the chart scales to the parent width.
  const vbW = Math.max(300, data.length * 18);
  const barW = (vbW - (data.length + 1) * barGap) / data.length;

  const fmt = yFormat || (v => v.toLocaleString());

  return (
    <div className="bar-chart-wrap">
      <svg className="bar-chart" viewBox={`0 0 ${vbW} ${height}`} preserveAspectRatio="none" role="img">
        {/* Baseline at max */}
        <line
          x1="0" x2={vbW}
          y1={padTop} y2={padTop}
          stroke="var(--border)" strokeDasharray="2 3"
        />
        {data.map((d, i) => {
          const val = Number(d.value) || 0;
          const h = (val / max) * innerH;
          const x = barGap + i * (barW + barGap);
          const y = padTop + (innerH - h);
          const isHover = hover === i;
          return (
            <g key={i}
               onMouseEnter={() => setHover(i)}
               onMouseLeave={() => setHover(null)}>
              <rect
                x={x} y={y} width={barW} height={h}
                fill={isHover ? 'var(--accent)' : 'var(--accent-strong)'}
                rx="2"
              />
              {/* Invisible wider hit area */}
              <rect x={x - barGap / 2} y={padTop} width={barW + barGap} height={innerH} fill="transparent" />
            </g>
          );
        })}
        {/* X-axis labels: show first, middle, and last to avoid clutter */}
        {[0, Math.floor(data.length / 2), data.length - 1].map(i => {
          if (i < 0 || i >= data.length) return null;
          const x = barGap + i * (barW + barGap) + barW / 2;
          return (
            <text
              key={`lbl-${i}`}
              x={x} y={height - 8}
              fontSize="10"
              fill="var(--text-muted)"
              textAnchor="middle"
              fontFamily="DM Mono, monospace"
            >
              {data[i].label}
            </text>
          );
        })}
      </svg>
      {hover != null && (
        <div className="bar-tooltip">
          <span className="mono">{data[hover].label}</span>
          <span className="mono strong">{fmt(Number(data[hover].value) || 0)}</span>
        </div>
      )}
    </div>
  );
}
