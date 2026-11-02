export function formatCount(value: number): string {
  return String(value);
}

export function formatPercent(value: number): string {
  const rounded: string = Math.round(value * 100);
  return `${rounded}%`;
}
