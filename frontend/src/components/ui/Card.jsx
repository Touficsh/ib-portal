/**
 * Card — polished container with optional title + action slot.
 * Replaces the ad-hoc <div className="card"> + <div className="card-header"> pattern.
 *
 *   <Card title="Earnings by source" action={<Button>Export</Button>}>
 *     ...content...
 *   </Card>
 */
export default function Card({ title, subtitle, action, children, padded = true, elevation = 'sm', className = '' }) {
  const cn = [
    'ui-card',
    `ui-card-elev-${elevation}`,
    padded && 'ui-card-padded',
    className,
  ].filter(Boolean).join(' ');
  return (
    <section className={cn}>
      {(title || action) && (
        <header className="ui-card-header">
          <div className="ui-card-title-block">
            {title && <h2 className="ui-card-title">{title}</h2>}
            {subtitle && <p className="ui-card-subtitle">{subtitle}</p>}
          </div>
          {action && <div className="ui-card-action">{action}</div>}
        </header>
      )}
      <div className="ui-card-body">{children}</div>
    </section>
  );
}
