import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';

// --- Mocks ---

let mockIsIOS = false;
let mockIsNative = false;
vi.mock('@/shared/lib/platform', () => ({
  get isIOS() {
    return mockIsIOS;
  },
  get isNative() {
    return mockIsNative;
  },
}));

const showListeners: Array<(info: { keyboardHeight: number }) => void> = [];
const hideListeners: Array<() => void> = [];

const mockAddListener = vi.fn(async (event: string, cb: unknown) => {
  if (event === 'keyboardWillShow') {
    showListeners.push(cb as (info: { keyboardHeight: number }) => void);
  } else if (event === 'keyboardWillHide') {
    hideListeners.push(cb as () => void);
  }
  return { remove: () => {} };
});

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: (...args: unknown[]) =>
      mockAddListener(...(args as Parameters<typeof mockAddListener>)),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockIsIOS = false;
  mockIsNative = false;
  showListeners.length = 0;
  hideListeners.length = 0;
  // Reset doc style between tests
  const root = document.documentElement;
  root.style.removeProperty('--keyboardheight');
  root.style.removeProperty('--app-bottom-inset');
  root.style.removeProperty('--safe-area-inset-bottom');
});

afterEach(() => {
  vi.resetModules();
});

function mountInScope(setupFn: () => unknown) {
  const Comp = defineComponent({
    setup() {
      setupFn();
      return () => h('div');
    },
  });
  return mount(Comp);
}

/** Flush microtasks so async onMounted bodies (incl. dynamic import) finish. */
async function flushAsync() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

describe('useIOSKeyboardCssVar', () => {
  it('is a no-op on non-iOS platforms', async () => {
    mockIsIOS = false;
    mockIsNative = true;

    vi.resetModules();
    const { useIOSKeyboardCssVar } = await import('./use-ios-keyboard-css-var');
    mountInScope(() => useIOSKeyboardCssVar());

    await flushAsync();
    expect(mockAddListener).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue('--keyboardheight')).toBe('');
  });

  it('on iOS, drives --keyboardheight + --app-bottom-inset from plugin events', async () => {
    mockIsIOS = true;
    mockIsNative = true;

    vi.resetModules();
    const { useIOSKeyboardCssVar } = await import('./use-ios-keyboard-css-var');
    mountInScope(() => useIOSKeyboardCssVar());

    await flushAsync();

    expect(mockAddListener).toHaveBeenCalledWith('keyboardWillShow', expect.any(Function));
    expect(mockAddListener).toHaveBeenCalledWith('keyboardWillHide', expect.any(Function));

    // Initial watch tick — keyboard closed.
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--keyboardheight')).toBe('0px');
    expect(root.style.getPropertyValue('--app-bottom-inset')).toBe('0px');
    expect(root.style.getPropertyValue('--safe-area-inset-bottom')).toContain('env(');

    // Simulate keyboard appearing.
    expect(showListeners.length).toBe(1);
    showListeners[0]({ keyboardHeight: 320 });
    await flushAsync();

    expect(root.style.getPropertyValue('--keyboardheight')).toBe('320px');
    expect(root.style.getPropertyValue('--app-bottom-inset')).toBe('320px');
    expect(root.style.getPropertyValue('--safe-area-inset-bottom')).toBe('0px');

    // Simulate keyboard hiding.
    expect(hideListeners.length).toBe(1);
    hideListeners[0]();
    await flushAsync();

    expect(root.style.getPropertyValue('--keyboardheight')).toBe('0px');
    expect(root.style.getPropertyValue('--app-bottom-inset')).toBe('0px');
    expect(root.style.getPropertyValue('--safe-area-inset-bottom')).toContain('env(');
  });
});

describe('useKeyboardHeight (regression for Android event source)', () => {
  it('returns 0 by default on non-native platforms', async () => {
    mockIsIOS = false;
    mockIsNative = false;

    vi.resetModules();
    const { useKeyboardHeight } = await import('./use-keyboard-visible');
    const captured = ref(-1);

    mountInScope(() => {
      const h = useKeyboardHeight();
      captured.value = h.value;
    });

    await flushAsync();
    expect(captured.value).toBe(0);
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('on native (Android), subscribes to keyboardWillShow/keyboardWillHide events', async () => {
    mockIsIOS = false;
    mockIsNative = true;

    vi.resetModules();
    const { useKeyboardHeight } = await import('./use-keyboard-visible');
    mountInScope(() => useKeyboardHeight());

    await flushAsync();
    expect(mockAddListener).toHaveBeenCalledWith('keyboardWillShow', expect.any(Function));
    expect(mockAddListener).toHaveBeenCalledWith('keyboardWillHide', expect.any(Function));
  });
});
