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
