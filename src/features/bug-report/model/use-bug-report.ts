/**
 * Global composable for triggering the bug report modal from anywhere.
 *
 * Usage:
 *   // Open with error context (e.g. from a catch block):
 *   useBugReport().open({ context: 'Video call failed', error: e })
 *
 *   // Open plain (settings button):
 *   useBugReport().open()
 */

const isOpen = ref(false);
const prefillContext = ref('');
const prefillError = ref('');

export interface BugReportOpenOptions {
  /** Short description of what the user was doing (e.g. "Sending a message") */
  context?: string;
  /** Error object or message to include */
  error?: unknown;
}

export function useBugReport() {
  const open = (opts?: BugReportOpenOptions) => {
    if (opts?.context) {
      prefillContext.value = opts.context;
    } else {
      prefillContext.value = '';
    }

    if (opts?.error) {
      prefillError.value =
        opts.error instanceof Error
          ? `${opts.error.name}: ${opts.error.message}`
          : String(opts.error);
    } else {
      prefillError.value = '';
    }

    isOpen.value = true;
  };

  const close = () => {
    isOpen.value = false;
    prefillContext.value = '';
    prefillError.value = '';
  };

  return {
    isOpen: readonly(isOpen),
    prefillContext: readonly(prefillContext),
    prefillError: readonly(prefillError),
    open,
    close,
  };
}
