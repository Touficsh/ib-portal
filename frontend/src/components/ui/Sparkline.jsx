import { Area, AreaChart, ResponsiveContainer } from 'recharts';

/**
 * Sparkline — tiny inline area chart designed to fit inside a stat tile or
 * table cell. Single data series with a gradient fill, no axes, no tooltip.
 *
 *   <Sparkline data={[{v:3}, {v:5}, {v:4}, {v:8}]} color="var(--accent)" height={30} />
 *
 * The data shape is flexible — pass `dataKey` to map arbitrary objects.
 */
export default function Sparkline({
  data,
  dataKey = 'v',
  color = 'var(--accent)',
  height = 32,
  width = '100%',
}) {
  if (!data || data.length === 0) return null;
  const gradientId = `spark-${Math.random().toString(36).slice(2, 9)}`;
  return (
    <div style={{ width, height, lineHeight: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
