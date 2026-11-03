import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { RouteProgress } from "@/components/route-progress";
import { SiteNav } from "@/components/site-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Runs · thin-pr console", template: "%s · thin-pr console" },
  description: "Runs, gate verdicts, diffs and eval results from the thin-pr orchestrator.",
};

const themeScript = `(function () {
  try {
    var media = matchMedia("(prefers-color-scheme: dark)");
    var apply = function () {
      document.documentElement.dataset.theme = localStorage.getItem("theme") || (media.matches ? "dark" : "light");
    };
    apply();
    media.addEventListener("change", apply);
  } catch (error) {}
})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh font-sans text-sm">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-border"
        >
          Skip to content
        </a>
        <RouteProgress />
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
            <Link href="/" className="shrink-0 font-mono text-sm font-semibold tracking-tight whitespace-nowrap">
              thin-pr<span className="hidden text-muted-foreground sm:inline">/console</span>
            </Link>
            <SiteNav />
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
