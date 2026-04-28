/**
 * Toast helper — thin wrapper over `sonner` so call sites don't import sonner
 * directly. Lets us swap the backend later without code-site changes and
 * standardises styling/duration.
 *
 *   import { toast } from '../components/ui/toast.js';
 *   toast.success('Saved');
 *   toast.error('Something went wrong');
 *   toast.info('3 new commissions posted');
 *   toast.loading('Syncing…');
 *
 * Also exports `confirm()` — a promise-based replacement for window.confirm()
 * that shows a nicer dialog-like toast with OK/Cancel buttons.
 */
import { toast as sonnerToast } from 'sonner';

export const toast = {
  success: (msg, opts = {}) => sonnerToast.success(msg, { duration: 3500, ...opts }),
  error:   (msg, opts = {}) => sonnerToast.error(msg,   { duration: 5000, ...opts }),
  info:    (msg, opts = {}) => sonnerToast(msg,         { duration: 3500, ...opts }),
  warn:    (msg, opts = {}) => sonnerToast.warning(msg, { duration: 4000, ...opts }),
  loading: (msg, opts = {}) => sonnerToast.loading(msg, opts),
  dismiss: (id) => sonnerToast.dismiss(id),
  /**
   * promise() — show a loading toast that auto-swaps to success / error
   * once the promise resolves. Saves the manual dismiss dance.
   *
   *   toast.promise(api.save(), {
   *     loading: 'Saving…',
   *     success: 'Saved',
   *     error: (err) => `Failed: ${err.message}`,
   *   });
   */
  promise: (p, msgs) => sonnerToast.promise(p, msgs),
};

/**
 * confirm(message, { confirmLabel, cancelLabel, variant }) → Promise<boolean>
 *
 * Drop-in replacement for window.confirm. Shows a sonner toast with two action
 * buttons. Resolves true on confirm, false on cancel/dismiss.
 */
export function confirm(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', variant = 'info' } = {}) {
  return new Promise((resolve) => {
    const id = sonnerToast[variant === 'danger' ? 'error' : 'info'](message, {
      duration: 15000,
      action: {
        label: confirmLabel,
        onClick: () => { sonnerToast.dismiss(id); resolve(true); },
      },
      cancel: {
        label: cancelLabel,
        onClick: () => { sonnerToast.dismiss(id); resolve(false); },
      },
      onDismiss: () => resolve(false),
      onAutoClose: () => resolve(false),
    });
  });
}
