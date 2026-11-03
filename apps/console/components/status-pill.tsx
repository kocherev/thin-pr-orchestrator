import { STATUS_LABEL } from "@/lib/labels";
import type { RunStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { Badge, type BadgeTone } from "./ui/badge";
import { BlockedIcon, FailIcon, PassIcon, WaitIcon } from "./icons";

export const STATUS_STYLE: Record<RunStatus, { tone: BadgeTone; text: string; Icon: typeof PassIcon }> = {
  opened: { tone: "success", text: "text-success", Icon: PassIcon },
  awaiting_approval: { tone: "primary", text: "text-primary", Icon: WaitIcon },
  blocked: { tone: "warning", text: "text-warning", Icon: BlockedIcon },
  failed: { tone: "danger", text: "text-danger", Icon: FailIcon },
  cancelled: { tone: "neutral", text: "text-muted-foreground", Icon: BlockedIcon },
};

export function StatusPill({ status }: { status: RunStatus }) {
  const { tone, Icon } = STATUS_STYLE[status];
  return (
    <Badge tone={tone}>
      <Icon strokeWidth={2} />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** The status as colored text with its icon, for tables that show two statuses side by side. */
export function StatusText({ status }: { status: RunStatus }) {
  const { text, Icon } = STATUS_STYLE[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon strokeWidth={2} className={cn("shrink-0", text)} />
      {STATUS_LABEL[status]}
    </span>
  );
}
