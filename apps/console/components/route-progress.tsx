"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** The page a navigation left from, and a key that restarts the bar for each one. */
type Navigation = { from: string; key: number };

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** A thin bar at the top while a client-side navigation waits for the next page's data. */
export function RouteProgress() {
  const pathname = usePathname();
  const [navigation, setNavigation] = useState<Navigation | null>(null);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (!isPlainClick(event) || !(event.target instanceof Element)) return;
      const link = event.target.closest("a");
      if (!link || link.target || link.hasAttribute("download")) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      setNavigation((current) => ({ from: location.pathname, key: (current?.key ?? 0) + 1 }));
    }
    // Capture runs before the router's own handler, which ends the click.
    window.addEventListener("click", onClick, { capture: true });
    return () => window.removeEventListener("click", onClick, { capture: true });
  }, []);

  if (!navigation) return null;
  const state = navigation.from === pathname ? "loading" : "done";
  return <div key={navigation.key} aria-hidden="true" data-state={state} className="route-progress" />;
}
