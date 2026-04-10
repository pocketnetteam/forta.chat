/**
 * Open a Bastyon user profile by address.
 * Opens https://bastyon.com/user?address=... in a new tab/browser.
 */
export function openBastyonProfile(address: string): void {
  const encoded = encodeURIComponent(address);
  window.open(`https://bastyon.com/user?address=${encoded}`, '_blank', 'noopener');
}
