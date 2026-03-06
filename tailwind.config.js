/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,js,jsx,md,svelte,ts,tsx,vue}", "./index.html"],
  plugins: [],
  theme: {
    extend: {
      colors: {
        "background-hidden-layer": "rgb(var(--background-hidden-layer) / <alpha-value>)",
        "background-main": "rgb(var(--background-main) / <alpha-value>)",
        "background-main-contrast": "rgb(var(--background-main-contrast) / <alpha-value>)",
        "background-overlay": "rgba(0, 0, 0, 0.5)",
        "background-secondary-theme": "rgb(var(--background-secondary-theme) / <alpha-value>)",
        "background-total-theme": "rgb(var(--background-total-theme) / <alpha-value>)",
        "color-bad": "rgb(var(--color-bad) / <alpha-value>)",
        "color-bg-ac": "rgb(var(--color-bg-ac) / <alpha-value>)",
        "color-bg-ac-1": "rgb(var(--color-bg-ac-1) / <alpha-value>)",
        "color-bg-ac-2": "rgb(var(--color-bg-ac-2) / <alpha-value>)",
        "color-bg-ac-bright": "rgb(var(--color-bg-ac-bright) / <alpha-value>)",
        "color-bg-orange": "rgb(var(--color-bg-orange) / <alpha-value>)",
        "color-bg-selection": "rgb(var(--color-bg-selection) / <alpha-value>)",
        "color-good": "rgb(var(--color-good) / <alpha-value>)",
        "color-nrml": "rgb(var(--color-nrml) / <alpha-value>)",
        "color-shadow-base": "rgb(var(--color-shadow-base) / <alpha-value>)",
        "color-shadow-var": "rgb(var(--color-shadow-var) / <alpha-value>)",
        "color-star-yellow": "rgb(var(--color-star-yellow) / <alpha-value>)",
        "color-txt-ac": "rgb(var(--color-txt-ac) / <alpha-value>)",
        "color-txt-ac-1": "rgb(var(--color-txt-ac-1) / <alpha-value>)",
        "color-txt-ac-2": "rgb(var(--color-txt-ac-2) / <alpha-value>)",
        "color-txt-gray": "rgb(var(--color-txt-gray) / <alpha-value>)",
        "color-txt-gray-dark": "rgb(var(--color-txt-gray-dark) / <alpha-value>)",
        "color-txt-orange": "rgb(var(--color-txt-orange) / <alpha-value>)",
        "color-yellow": "rgb(var(--color-yellow) / <alpha-value>)",
        "neutral-grad-0": "rgb(var(--neutral-grad-0) / <alpha-value>)",
        "neutral-grad-1": "rgb(var(--neutral-grad-1) / <alpha-value>)",
        "neutral-grad-2": "rgb(var(--neutral-grad-2) / <alpha-value>)",
        "neutral-grad-3": "rgb(var(--neutral-grad-3) / <alpha-value>)",
        "text-color": "rgb(var(--text-color) / <alpha-value>)",
        "text-on-bg-ac-color": "rgb(var(--text-on-bg-ac-color) / <alpha-value>)",
        "text-on-bg-shadow-color": "rgb(var(--text-on-bg-shadow-color) / <alpha-value>)",
        "text-on-main-bg-color": "rgb(var(--text-on-main-bg-color) / <alpha-value>)",
        "voice-message-fillStyle": "rgb(var(--voice-message-fillStyle) / <alpha-value>)",
        // Chat-specific colors
        "chat-bubble-own": "rgb(var(--chat-bubble-own) / <alpha-value>)",
        "chat-bubble-other": "rgb(var(--chat-bubble-other) / <alpha-value>)",
        "chat-sidebar": "rgb(var(--chat-sidebar) / <alpha-value>)",
        "chat-input-bg": "rgb(var(--chat-input-bg) / <alpha-value>)"
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
      }
    }
  }
};
