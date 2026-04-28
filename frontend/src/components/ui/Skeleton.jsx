/**
 * Skeleton — shimmering placeholder used while content loads.
 *
 * Use matching the shape of the eventual content (size, rounded corners).
 * The shimmer respects prefers-reduced-motion globally.
 *
 *   <Skeleton width="60%" height={14} />
 *   <Skeleton lines={3} />            // 3 stacked paragraph lines
 *   <Skeleton variant="circle" size={32} />
 *
 * For tables: render <SkeletonRow cols={5} /> inside a <tbody>.
 */
export default function Skeleton({ width, height, lines, variant = 'rect', size, className = '', style = {} }) {
  if (lines && lines > 1) {
    return (
      <div className={`ui-skeleton-stack ${className}`} style={style}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="ui-skeleton"
            style={{
              width: i === lines - 1 ? '70%' : '100%',   // last line slightly shorter
              height: height || 12,
            }}
          />
        ))}
      </div>
    );
  }
  const s = {
    width: width ?? '100%',
    height: height ?? 14,
    ...(variant === 'circle' ? { width: size, height: size, borderRadius: '50%' } : {}),
    ...style,
  };
  return <div className={`ui-skeleton ${className}`} style={s} />;
}

export function SkeletonRow({ cols = 5 }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i}><Skeleton width={i === 0 ? '60%' : '80%'} height={12} /></td>
      ))}
    </tr>
  );
}
