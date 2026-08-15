/** Centralized download/platform links for Forta Chat. */
export const downloadLinks = {
  /** GitHub Releases "latest" page — always points to the newest release. */
  androidApk: "https://github.com/pocketnetteam/forta.chat/releases/latest",

  /** GitHub Releases latest page (all platforms). */
  githubReleasesLatest: "https://github.com/pocketnetteam/forta.chat/releases/latest",

  /** GitHub Releases API for the latest published release. */
  githubApiLatest:
    "https://api.github.com/repos/pocketnetteam/forta.chat/releases/latest",

  /** Google Play listing (applicationId = com.forta.chat). */
  androidPlayStore:
    "https://play.google.com/store/apps/details?id=com.forta.chat",

  /** Web application URL. */
  webApp: "https://forta.chat",

  /** GitHub repository. */
  github: "https://github.com/pocketnetteam/forta.chat",
} as const;
