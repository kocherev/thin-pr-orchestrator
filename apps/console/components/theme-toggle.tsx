"use client";

import { Button } from "./ui/button";
import { MoonIcon, SunIcon } from "./icons";

const iconMotion =
  "absolute inset-0 transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-[opacity]";

/** Every color transition firing at once smears the switch, so they are off for the frame that swaps the theme. */
function setTheme(theme: string): void {
  const pause = document.createElement("style");
  pause.textContent = "*:not([data-theme-icon]),*::before,*::after{transition:none!important}";
  document.head.append(pause);
  document.documentElement.dataset.theme = theme;
  void document.body.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => pause.remove()));
}

function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  // A view transition cross-fades the whole page; browsers without it switch at once.
  if (document.startViewTransition) document.startViewTransition(() => setTheme(next));
  else setTheme(next);
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
          data-theme-icon=""
          className={`${iconMotion} not-in-data-[theme=dark]:opacity-0 motion-safe:not-in-data-[theme=dark]:scale-[0.25] motion-safe:not-in-data-[theme=dark]:blur-[4px]`}
        />
        <MoonIcon
          data-theme-icon=""
          className={`${iconMotion} in-data-[theme=dark]:opacity-0 motion-safe:in-data-[theme=dark]:scale-[0.25] motion-safe:in-data-[theme=dark]:blur-[4px]`}
        />
      </span>
    </Button>
  );
}
