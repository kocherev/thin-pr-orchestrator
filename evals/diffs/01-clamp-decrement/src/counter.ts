export function increment(value: number): number {
  return value + 1;
}

export function decrement(value: number): number {
  return Math.max(0, value - 1);
}
