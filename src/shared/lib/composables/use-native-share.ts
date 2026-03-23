import { isNative } from '@/shared/lib/platform';
import { useToast } from '@/shared/lib/use-toast';

export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
  /** File URIs — native only. Use @capacitor/filesystem to get URI. */
  files?: string[];
}

export interface ShareResult {
  shared: boolean;
  fallback: boolean;
}

export interface UseNativeShareOptions {
  /** Toast text shown after clipboard copy (fallback). */
  copiedMessage?: string;
  /** Toast text shown when clipboard copy fails. */
  copyFailedMessage?: string;
}

export function useNativeShare(options: UseNativeShareOptions = {}) {
  const { toast } = useToast();

  async function share(payload: SharePayload): Promise<ShareResult> {
    if (isNative) {
      return shareNative(payload);
    }
    if (typeof navigator.share === 'function') {
      return shareWeb(payload);
    }
    return shareFallback(payload);
  }

  async function shareNative(payload: SharePayload): Promise<ShareResult> {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: payload.title,
        text: payload.text,
        url: payload.url,
        files: payload.files,
      });
      return { shared: true, fallback: false };
    } catch (e: any) {
      if (isCancelError(e)) {
        return { shared: false, fallback: false };
      }
      console.error('[useNativeShare] native share failed:', e);
      return shareFallback(payload);
    }
  }

  async function shareWeb(payload: SharePayload): Promise<ShareResult> {
    try {
      await navigator.share({
        title: payload.title,
        text: payload.text,
        url: payload.url,
      });
      return { shared: true, fallback: false };
    } catch (e: any) {
      if (e.name === 'AbortError') {
        return { shared: false, fallback: false };
      }
      console.error('[useNativeShare] web share failed:', e);
      return shareFallback(payload);
    }
  }

  async function shareFallback(payload: SharePayload): Promise<ShareResult> {
    const content = payload.url || payload.text || '';
    if (!content) {
      return { shared: false, fallback: true };
    }
    try {
      await navigator.clipboard.writeText(content);
      toast(options.copiedMessage ?? 'Link copied', 'success');
    } catch {
      toast(options.copyFailedMessage ?? 'Failed to copy', 'error');
    }
    return { shared: false, fallback: true };
  }

  return { share };
}

function isCancelError(e: any): boolean {
  if (!e) return false;
  const msg = (e.message || e.errorMessage || '').toLowerCase();
  return (
    msg.includes('cancel') ||
    msg.includes('dismiss') ||
    msg.includes('user denied') ||
    e.code === 'ERR_CANCELED'
  );
}
