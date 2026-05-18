import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Composable skeleton primitives for the editorial system. All built on the
 * single shadcn `Skeleton` (animate-pulse + bg-ink-200) so the loading
 * pulse stays consistent across the app.
 *
 * Use these when waiting on a fetch that populates a panel/table/card.
 * For inline action loading (button submit), keep `<Loader2 spin>` — it's
 * smaller and more appropriate.
 */

interface SkeletonRowsProps {
  /** Number of skeleton rows to render. */
  count?: number;
  /** Number of column-shaped cells per row (matches the real table). */
  cols?: number;
  /** Optional className on the wrapping table. */
  className?: string;
}

/**
 * Table row placeholders. Drop inside a `<TableBody>` while the real rows
 * are loading. Each cell renders a single full-width skeleton bar.
 */
export function SkeletonRows({ count = 5, cols = 4, className }: SkeletonRowsProps) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i} className={cn("border-b border-ink-500", className)}>
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <Skeleton className="h-3.5 w-full max-w-[160px]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

interface SkeletonStatGridProps {
  /** Number of stat cells (typically 3-4). */
  count?: number;
  /** Optional className on the outer grid. */
  className?: string;
}

/**
 * Stat-card grid placeholder. Matches the hairline editorial stats pattern
 * used in Overview, Monitoring, Admin pages.
 */
export function SkeletonStatGrid({ count = 4, className }: SkeletonStatGridProps) {
  return (
    <div
      className={cn(
        "grid border-l border-t border-ink-500",
        count === 3 && "grid-cols-3",
        count === 4 && "grid-cols-2 md:grid-cols-4",
        count === 2 && "grid-cols-2",
        className,
      )}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="border-b border-r border-ink-500 p-4">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="mt-3 h-6 w-16" />
        </div>
      ))}
    </div>
  );
}

interface SkeletonCardGridProps {
  /** Number of cards to render. */
  count?: number;
  /** Optional className on the outer grid. */
  className?: string;
}

/**
 * Card grid placeholder — used by UserManagement, AI Models tab, etc.
 * Each card has an avatar+title row, two body lines, and a footer button.
 */
export function SkeletonCardGrid({ count = 6, className }: SkeletonCardGridProps) {
  return (
    <div className={cn("grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xs border border-ink-500 bg-ink-100 p-5"
        >
          <div className="mb-4 flex items-start gap-3">
            <Skeleton className="h-10 w-10" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-2.5 w-20" />
            </div>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <div className="mt-4 border-t border-ink-500 pt-3">
            <Skeleton className="h-7 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface SkeletonTreeProps {
  /** Number of top-level rows. */
  count?: number;
  className?: string;
}

/**
 * Sidebar tree placeholder — used by DataExplorer while databases load.
 * Mimics a tree of clickable rows with chevron + icon + label.
 */
export function SkeletonTree({ count = 8, className }: SkeletonTreeProps) {
  return (
    <div className={cn("space-y-1 px-2 py-2", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton className="h-3 w-3" />
          <Skeleton className="h-3 w-3" />
          <Skeleton className="h-3 w-32" style={{ width: `${60 + (i % 4) * 25}px` }} />
        </div>
      ))}
    </div>
  );
}

interface SkeletonChartProps {
  /** Height of the chart area in px. */
  height?: number;
  className?: string;
}

/**
 * Chart placeholder for Metrics + AiChartRenderer. Shows a labelled
 * placeholder block roughly matching the chart's vertical footprint.
 */
export function SkeletonChart({ height = 220, className }: SkeletonChartProps) {
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-2.5 w-12" />
      </div>
      <Skeleton className="w-full" style={{ height: `${height}px` }} />
    </div>
  );
}

interface SkeletonListProps {
  /** Number of list items. */
  count?: number;
  className?: string;
}

/**
 * Vertical list placeholder for things like LiveQueries, Logs, RecentQueries.
 * Each row has a left icon + title line + metadata line.
 */
export function SkeletonList({ count = 6, className }: SkeletonListProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xs border border-ink-500 bg-ink-100 px-4 py-3"
        >
          <Skeleton className="h-4 w-4" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-full max-w-md" />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

interface SkeletonTextProps {
  /** CSS width (any valid Tailwind width). Defaults to full. */
  width?: string;
  /** Tailwind height class. Defaults to h-3. */
  height?: string;
  className?: string;
}

/**
 * Single skeleton text line. Use for inline placeholders inside otherwise
 * already-rendered surfaces (e.g. "loading the user's name…").
 */
export function SkeletonText({ width = "w-full", height = "h-3", className }: SkeletonTextProps) {
  return <Skeleton className={cn(width, height, className)} />;
}
