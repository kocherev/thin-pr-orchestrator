import { cn } from "@/lib/utils";
import { ChevronIcon } from "./icons";

type LogDetailsProps = { label: string; text: string; open?: boolean; className?: string };

export function LogDetails({ label, text, open = false, className }: LogDetailsProps) {
  return (
    <details open={open} className={cn("group", className)}>
      <summary className="relative flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground transition-[color] duration-150 ease-out after:absolute after:-inset-x-1 after:-inset-y-2 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="size-3.5 transition-[rotate] duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" />
        {label}
      </summary>
      {text ? (
        <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">{text}</pre>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No output.</p>
      )}
    </details>
  );
}
