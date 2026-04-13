/** Centralized download/platform links for Forta Chat. */
export const downloadLinks = {
  /** Direct APK download from GitHub Releases. */
  androidApk: "https://github.com/pocketnetteam/forta.chat/releases/download/v1.9.3/forta-chat-1.9.3.apk",

  /** GitHub Releases page (fallback). */
  androidReleases: "https://github.com/pocketnetteam/forta.chat/releases/latest",

  /** Web application URL. */
  webApp: "https://forta.chat",

  /** GitHub repository. */
  github: "https://github.com/pocketnetteam/forta.chat"
} as const;
