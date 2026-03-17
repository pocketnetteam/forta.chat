/** @type {import('tailwindcss').Config} */

// Helper: creates a color value that works with Tailwind opacity modifiers
// using rgba() syntax (maximum browser compatibility including Safari)
const withOpacity = (varName) => {
  return ({ opacityValue }) => {
    if (opacityValue !== undefined) {
      return `rgba(var(${varName}), ${opacityValue})`;
    }
    return `rgb(var(${varName}))`;
  };
};

export default {
  content: ["./src/**/*.{html,js,jsx,md,svelte,ts,tsx,vue}", "./index.html"],
  plugins: [],
  theme: {
    extend: {
      colors: {
        "background-hidden-layer": withOpacity("--background-hidden-layer"),
        "background-main": withOpacity("--background-main"),
        "background-main-contrast": withOpacity("--background-main-contrast"),
        "background-overlay": "rgba(0, 0, 0, 0.5)",
        "background-secondary-theme": withOpacity("--background-secondary-theme"),
        "background-total-theme": withOpacity("--background-total-theme"),
        "color-bad": withOpacity("--color-bad"),
        "color-bg-ac": withOpacity("--color-bg-ac"),
        "color-bg-ac-1": withOpacity("--color-bg-ac-1"),
        "color-bg-ac-2": withOpacity("--color-bg-ac-2"),
        "color-bg-ac-bright": withOpacity("--color-bg-ac-bright"),
        "color-bg-orange": withOpacity("--color-bg-orange"),
        "color-bg-selection": withOpacity("--color-bg-selection"),
        "color-good": withOpacity("--color-good"),
        "color-nrml": withOpacity("--color-nrml"),
        "color-shadow-base": withOpacity("--color-shadow-base"),
        "color-shadow-var": withOpacity("--color-shadow-var"),
        "color-star-yellow": withOpacity("--color-star-yellow"),
        "color-txt-ac": withOpacity("--color-txt-ac"),
        "color-txt-ac-1": withOpacity("--color-txt-ac-1"),
        "color-txt-ac-2": withOpacity("--color-txt-ac-2"),
        "color-txt-gray": withOpacity("--color-txt-gray"),
        "color-txt-gray-dark": withOpacity("--color-txt-gray-dark"),
        "color-txt-orange": withOpacity("--color-txt-orange"),
        "color-yellow": withOpacity("--color-yellow"),
        "neutral-grad-0": withOpacity("--neutral-grad-0"),
        "neutral-grad-1": withOpacity("--neutral-grad-1"),
        "neutral-grad-2": withOpacity("--neutral-grad-2"),
        "neutral-grad-3": withOpacity("--neutral-grad-3"),
        "text-color": withOpacity("--text-color"),
        "text-on-bg-ac-color": withOpacity("--text-on-bg-ac-color"),
        "text-on-bg-shadow-color": withOpacity("--text-on-bg-shadow-color"),
        "text-on-main-bg-color": withOpacity("--text-on-main-bg-color"),
        "voice-message-fillStyle": withOpacity("--voice-message-fillStyle"),
        // Chat-specific colors
        "chat-bubble-own": withOpacity("--chat-bubble-own"),
        "chat-bubble-other": withOpacity("--chat-bubble-other"),
        "chat-sidebar": withOpacity("--chat-sidebar"),
        "chat-input-bg": withOpacity("--chat-input-bg"),
      },
      fontSize: {
        "chat-base": "var(--font-size-base)",
      },
      borderRadius: {
        "bubble": "var(--bubble-radius)",
        "bubble-sm": "var(--bubble-radius-small)",
      },
      gap: {
        "msg": "var(--message-spacing)",
      },
      spacing: {
        "app-margin-bottom": "var(--app-margin-bottom)",
        "app-margin-bottom-default": "var(--app-margin-bottom-default)",
        "app-margin-top": "var(--app-margin-top)",
        "app-margin-top-default": "var(--app-margin-top-default)",
        keyboardheight: "var(--keyboardheight)",
        "safe-area-inset-bottom": "var(--safe-area-inset-bottom)",
        "safe-area-inset-left": "var(--safe-area-inset-left)",
        "safe-area-inset-right": "var(--safe-area-inset-right)",
        "safe-area-inset-top": "var(--safe-area-inset-top)"
      },
      minHeight: {
        tap: "44px",
      },
      minWidth: {
        tap: "44px",
      }
    }
  }
};
