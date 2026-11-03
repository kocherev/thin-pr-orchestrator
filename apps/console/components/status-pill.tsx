import type { RunStatus } from "@/lib/schema";
import { Badge, type BadgeTone } from "./ui/badge";
import { BlockedIcon, FailIcon, PassIcon } from "./icons";

const STATUS: Record<RunStatus, { tone: BadgeTone; label: string; Icon: typeof PassIcon }> = {
  opened: { tone: "success", label: "Opened", Icon: PassIcon },
  awaiting_approval: { tone: "neutral", label: "Awaiting approval", Icon: BlockedIcon },
  blocked: { tone: "warning", label: "Blocked", Icon: BlockedIcon },
  failed: { tone: "danger", label: "Failed", Icon: FailIcon },
};

export function StatusPill({ status }: { status: RunStatus }) {
  const { tone, label, Icon } = STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon strokeWidth={2} />
      {label}
    </Badge>
  );
}
