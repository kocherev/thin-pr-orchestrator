"use client";

import { Button } from "./ui/button";
import { MoonIcon, SunIcon } from "./icons";

const iconMotion = "absolute inset-0 transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]";

function toggleTheme(): void {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
}

export function ThemeToggle() {
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle dark theme" title="Toggle dark theme" onClick={toggleTheme}>
      <span className="relative size-4">
        <SunIcon
          className={`${iconMotion} not-in-data-[theme=dark]:opacity-0 motion-safe:not-in-data-[theme=dark]:scale-[0.25] motion-safe:not-in-data-[theme=dark]:blur-[4px]`}
        />
        <MoonIcon
          className={`${iconMotion} in-data-[theme=dark]:opacity-0 motion-safe:in-data-[theme=dark]:scale-[0.25] motion-safe:in-data-[theme=dark]:blur-[4px]`}
        />
      </span>
    </Button>
  );
}
