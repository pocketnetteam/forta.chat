import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.forta.chat',
  appName: 'Forta Chat',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'forta-app',
  },
  android: {
    // Capacitor CLI ignores Gradle isDefault. Empty flavor → `assembleDebug`
    // (rebuilds ALL debug variants — hence the long build) but then deploys
    // stale `apk/debug/app-debug.apk` (no llama). Must be PascalCase so the
    // task is `assembleSideloadDebug`, not `assemblesideloadDebug`.
    flavor: "Sideload",
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
  ios: {
    // 'never' prevents WKWebView from auto-padding the top by the status
    // bar height; our CSS does that via env(safe-area-inset-top).
    contentInset: 'never',
    // Disable WKWebView's bounce/overscroll so it doesn't compete with our
    // custom virtual scroller in chat history. Matches Android edge-to-edge.
    scrollEnabled: false,
    backgroundColor: '#000000',
  },
  plugins: {
    Keyboard: {
      // 'none' tells iOS to fire keyboardWill{Show,Hide} events without
      // resizing the WebView. Our CSS shell shrinks/grows via the
      // --keyboardheight variable that JS drives from those events.
      // Matches the Android architecture where MainActivity injects the
      // same variable from WindowInsetsCompat.
      resize: 'none',
      resizeOnFullScreen: false,
      scrollPadding: false,
    },
    CapacitorShareTarget: {
      appGroupId: 'group.com.forta.chat',
    },
    // @capgo/capacitor-incoming-call-kit v8.x has no `pluginsConfig` block
    // of its own — every option (handleType, channelId, accentColor, ringtone
    // URI, video flag, timeoutMs, …) is passed per-call via showIncomingCall().
    // The iOS CallKit caller-app label comes from CFBundleDisplayName
    // ("Forta Chat", set in ios/App/App/Info.plist). We keep the per-platform
    // wiring inside src/shared/lib/native-calls/native-call-bridge.ts —
    // see Step 6 plan task 2.
  },
};

export default config;
