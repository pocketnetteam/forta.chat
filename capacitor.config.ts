import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.forta.chat',
  appName: 'Forta Chat',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
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
      resize: "none",
      scrollPadding: false,
    },
  },
};

export default config;
