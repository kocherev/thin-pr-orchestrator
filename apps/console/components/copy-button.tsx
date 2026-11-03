"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "./icons";
import { Button } from "./ui/button";

const iconMotion =
  "absolute inset-0 transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-[opacity]";
const hidden = "opacity-0 motion-safe:scale-[0.25] motion-safe:blur-[4px]";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the command stays on screen to select by hand.
    }
  }

  return (
    <>
      <Button variant="ghost" size="icon" aria-label={label} title={label} onClick={copy}>
        <span className="relative size-4">
          <CopyIcon className={cn(iconMotion, copied && hidden)} />
          <CheckIcon strokeWidth={2} className={cn(iconMotion, "text-success", !copied && hidden)} />
        </span>
      </Button>
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
