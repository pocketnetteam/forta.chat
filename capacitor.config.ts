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
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
  ios: {
    contentInset: 'never',
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
    IncomingCallKit: {
      callKitName: 'Forta Chat',
      ringtone: 'ringtone.caf',
      enableAndroid: false,
    },
  },
};

export default config;
