"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Runs", matches: (path: string) => path === "/" || path.startsWith("/runs") },
  { href: "/evals", label: "Evals", matches: (path: string) => path.startsWith("/evals") },
];

export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex items-center gap-1">
      {LINKS.map((link) => {
        const active = link.matches(pathname);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex h-8 items-center rounded-md px-2.5 text-sm transition-[background-color,color] duration-150 ease-out after:absolute after:inset-x-0 after:-inset-y-1",
              active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
