import type { CSSProperties } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Feeds `.stagger-item` in globals.css. Thirty milliseconds a row, capped so long lists never wait. */
export function staggerDelay(index: number, startMs = 0): CSSProperties {
  return { "--delay": `${startMs + Math.min(index, 10) * 30}ms` } as CSSProperties;
}
