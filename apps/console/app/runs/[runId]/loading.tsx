import { cn } from "@/lib/utils";

function Bone({ className }: { className: string }) {
  return <div className={cn("skeleton rounded-md bg-muted", className)} />;
}

/** Shown only while a client-side navigation fetches a run that was not prefetched. */
export default function Loading() {
  return (
    <>
      <div role="status" className="sr-only">
        Loading run
      </div>
      <div aria-hidden="true" className="flex flex-col gap-2.5">
        <Bone className="h-3 w-40" />
        <Bone className="h-7 w-full max-w-md" />
        <Bone className="h-5 w-64" />
      </div>
      <Bone className="h-24 w-full rounded-xl" />
      <div aria-hidden="true" className="grid grid-cols-2 gap-px overflow-hidden rounded-xl shadow-border sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex flex-col gap-2 bg-surface px-4 py-3">
            <Bone className="h-3 w-12" />
            <Bone className="h-6 w-20" />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="grid gap-6 lg:grid-cols-2">
        <Bone className="h-80 w-full rounded-xl" />
        <Bone className="h-48 w-full rounded-xl" />
      </div>
    </>
  );
}
