/**
 * EmptyState — the pattern for "no X yet".
 *
 * Always has: icon + headline + supporting copy + primary CTA (optional).
 * Designed to feel welcoming, not like a broken page. Drops into any card
 * body or section in place of a table / list.
 *
 * Usage:
 *   <EmptyState
 *     icon={<Users size={36} />}
 *     title="No sub-agents yet"
 *     description="Share your referral link to start building your downline."
 *     action={<Button variant="primary" icon={<Link2 size={14} />}>Create referral link</Button>}
 *   />
 */
export default function EmptyState({ icon, title, description, action, size = 'md' }) {
  return (
    <div className={`ui-empty ui-empty-${size}`}>
      {icon && (
        <div className="ui-empty-icon" aria-hidden>
          {icon}
        </div>
      )}
      {title && <div className="ui-empty-title">{title}</div>}
      {description && <div className="ui-empty-desc">{description}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
