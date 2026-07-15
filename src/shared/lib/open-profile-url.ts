import { isNative } from "@/shared/lib/platform";

/**
 * Open a Bastyon user profile by address.
 * Native: bastyon:// deep link. Web/Electron: https://bastyon.com in a new tab.
 */
export function openBastyonProfile(address: string): void {
  const encoded = encodeURIComponent(address);
  if (isNative) {
    window.open(`bastyon://user?address=${encoded}`, "_blank", "noopener");
    return;
  }
  window.open(`https://bastyon.com/user?address=${encoded}`, "_blank", "noopener");
}
