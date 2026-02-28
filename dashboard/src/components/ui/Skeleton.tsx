interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div className={`shimmer rounded ${className}`} />
  );
}

export function StatCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex justify-between mb-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-6 rounded-lg" />
      </div>
      <Skeleton className="h-8 w-32 mb-2" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

export function ChartSkeleton({ height = 280 }: { height?: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <Skeleton className="h-4 w-32 mb-6" />
      <div className="shimmer w-full rounded-lg" style={{ height }} />
    </div>
  );
}

export function TableRowSkeleton({ cols = 5 }: { cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-3 w-full" />
        </td>
      ))}
    </tr>
  );
}
