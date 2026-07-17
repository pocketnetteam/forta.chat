export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const formatted = exponent === 0 || Number.isInteger(value)
    ? String(Math.round(value))
    : value.toFixed(1);
  return `${formatted} ${units[exponent]}`;
}
