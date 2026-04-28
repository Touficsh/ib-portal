import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Button — unified primitive.
 *
 * Props:
 *   variant   'primary' | 'secondary' | 'ghost' | 'danger'   (default: secondary)
 *   size      'xs' | 'sm' | 'md' | 'lg'                      (default: md)
 *   loading   boolean — swaps leading content for a spinner, disables the button
 *   icon      React element — leading icon (from lucide-react)
 *   trailingIcon  React element — trailing icon (e.g., chevron)
 *   fullWidth boolean — stretches to parent width
 *
 * Loading keeps the button width stable (no layout shift). Disabled state has
 * lower opacity + not-allowed cursor. Focus ring handled globally via :focus-visible.
 *
 * Usage:
 *   <Button variant="primary" icon={<Download size={14} />}>Export</Button>
 *   <Button loading>Saving…</Button>
 */
const Button = forwardRef(function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  trailingIcon,
  fullWidth,
  className = '',
  children,
  ...rest
}, ref) {
  const cn = [
    'ui-btn',
    `ui-btn-${variant}`,
    `ui-btn-size-${size}`,
    loading && 'ui-btn-loading',
    fullWidth && 'ui-btn-full',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      ref={ref}
      className={cn}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 className="ui-btn-spin" size={iconSize(size)} aria-hidden />
      ) : icon ? (
        <span className="ui-btn-icon" aria-hidden>{icon}</span>
      ) : null}
      {children && <span className="ui-btn-label">{children}</span>}
      {trailingIcon && !loading && (
        <span className="ui-btn-icon" aria-hidden>{trailingIcon}</span>
      )}
    </button>
  );
});

function iconSize(size) {
  return size === 'xs' ? 12 : size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
}

export default Button;
