export interface User {
  address: string;
  name: string;
  about: string;
  image: string;
  site: string;
  language: string;
  /** Timestamp (ms) when this profile was last fetched from the server */
  cachedAt?: number;
}
