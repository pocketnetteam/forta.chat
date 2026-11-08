export interface User {
  address: string;
  name: string;
  about: string;
  image: string;
  site: string;
  language: string;
  /** Timestamp (ms) when this profile was last fetched from the server */
  cachedAt?: number;
  /**
   * Forta encryption public keys (normally 12) from getuserprofile.
   * Kept next to name/image so room crypto can resolve peers offline when
   * the proxy is down but the UI cache still has the interlocutor.
   */
  keys?: string[];
  /** Pocketnet numeric account id — required for deterministic AES key sort. */
  id?: number | string;
}
