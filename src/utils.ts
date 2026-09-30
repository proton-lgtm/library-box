export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
}

export function progressPercent(downloaded: number, total: number | null): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, (downloaded / total) * 100));
}
