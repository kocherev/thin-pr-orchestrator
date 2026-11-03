import Link from "next/link";
import { EmptyState } from "@/components/section";

export default function NotFound() {
  return (
    <div className="rounded-xl bg-surface shadow-border">
      <EmptyState title="Page not found">
        No page or run matches this address.{" "}
        <Link href="/" className="font-medium text-primary underline-offset-2 hover:underline">
          Back to runs
        </Link>
      </EmptyState>
    </div>
  );
}
