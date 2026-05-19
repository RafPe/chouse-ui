import { useEffect, useMemo, useState } from "react";
import { Layers, RefreshCw, Search, Filter } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PartLogTimelineChart } from "@/components/monitoring/PartLogTimelineChart";
import { SkeletonRows } from "@/components/common/Skeletons";
import { usePartLog } from "@/hooks/useMonitoringTimeline";
import { cn } from "@/lib/utils";

interface PartsPageProps {
  embedded?: boolean;
  refreshKey?: number;
  autoRefresh?: boolean;
  onRefreshChange?: (isRefreshing: boolean) => void;
}

const EVENT_TYPES = [
  "all",
  "MergeParts",
  "NewPart",
  "DownloadPart",
  "MutatePart",
  "RemovePart",
] as const;

const EVENT_COLOR: Record<string, string> = {
  MergeParts: "text-brand",
  NewPart: "text-emerald-400",
  DownloadPart: "text-sky-400",
  MutatePart: "text-amber-400",
  RemovePart: "text-violet-400",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function PartsPage({
  embedded = false,
  refreshKey = 0,
  autoRefresh = false,
  onRefreshChange,
}: PartsPageProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [eventType, setEventType] = useState<string>("all");
  const [limit, setLimit] = useState(200);

  const { data, isLoading, isFetching, error, refetch } = usePartLog(limit, 6);

  // Notify parent of refresh status.
  useEffect(() => {
    onRefreshChange?.(isFetching);
  }, [isFetching, onRefreshChange]);

  // Manual refresh trigger from Monitoring header.
  useEffect(() => {
    if (refreshKey > 0) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Auto-refresh every 10s when toggled on.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => refetch(), 10_000);
    return () => clearInterval(id);
  }, [autoRefresh, refetch]);

  const rows = useMemo(() => {
    if (!data) return [];
    const term = searchTerm.trim().toLowerCase();
    return data.filter((r) => {
      if (eventType !== "all" && r.event_type !== eventType) return false;
      if (term.length === 0) return true;
      return (
        r.table.toLowerCase().includes(term) ||
        r.database.toLowerCase().includes(term) ||
        r.part_name.toLowerCase().includes(term) ||
        r.partition_id.toLowerCase().includes(term)
      );
    });
  }, [data, searchTerm, eventType]);

  return (
    <div className="h-full overflow-hidden">
      <div className={cn("flex h-full flex-col gap-4", embedded ? "p-4" : "p-6")}>
        {/* Chart card */}
        <PartLogTimelineChart hoursBack={6} bucket="minute" refreshKey={refreshKey} />

        {/* Filters strip */}
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-ink-500 bg-ink-100 p-3">
          <div className="flex w-full items-center gap-2 md:w-[320px]">
            <Search className="h-4 w-4 text-paper-dim" />
            <Input
              placeholder="Search table, database, part…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-9 rounded-xs border-ink-500 bg-ink-200 font-mono text-[12px] text-paper placeholder:text-paper-faint focus-visible:border-brand focus-visible:ring-0"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-paper-dim" />
            <Select value={eventType} onValueChange={setEventType}>
              <SelectTrigger className="h-9 w-[160px] rounded-xs border-ink-500 bg-ink-200 font-mono text-[12px] text-paper">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === "all" ? "All events" : t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
            <SelectTrigger className="h-9 w-[120px] rounded-xs border-ink-500 bg-ink-200 font-mono text-[12px] text-paper">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="100">100 rows</SelectItem>
              <SelectItem value="200">200 rows</SelectItem>
              <SelectItem value="500">500 rows</SelectItem>
              <SelectItem value="1000">1000 rows</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table card */}
        <div className="flex-1 min-h-0 overflow-hidden rounded-md border border-ink-500 bg-ink-100">
          <div className="h-full overflow-auto">
            {isLoading ? (
              <div className="p-4">
                <SkeletonRows count={8} cols={6} />
              </div>
            ) : error ? (
              <div className="flex h-64 flex-col items-center justify-center gap-1 px-4 text-center">
                <span className="text-[13px] text-paper">Couldn't load part_log</span>
                <span className="text-[12px] text-paper-muted">{error.message}</span>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2 px-4 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-xs border border-ink-500 bg-ink-200 text-paper-dim">
                  <Layers className="h-5 w-5" aria-hidden />
                </span>
                <span className="text-[13px] text-paper">No part events</span>
                <span className="text-[12px] text-paper-muted">
                  {searchTerm || eventType !== "all"
                    ? "Try adjusting the filters."
                    : "MergeTree activity will land here as merges, mutations, and downloads happen."}
                </span>
              </div>
            ) : (
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 z-10 bg-ink-200/90 backdrop-blur">
                  <tr className="border-b border-ink-500">
                    {[
                      "Event time",
                      "Event",
                      "Database",
                      "Table",
                      "Part",
                      "Partition",
                      "Duration",
                      "Rows",
                      "Size",
                    ].map((h, i) => (
                      <th
                        key={h}
                        className={cn(
                          "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint",
                          i >= 6 ? "text-right" : "text-left"
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={`${r.part_name}-${r.event_time}-${i}`}
                      className="border-b border-ink-500/60 transition-colors hover:bg-ink-200/60"
                    >
                      <td className="px-3 py-1.5 font-mono text-paper-muted whitespace-nowrap">
                        {r.event_time.slice(11)}
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className={cn(
                            "font-mono text-[11px]",
                            EVENT_COLOR[r.event_type] ?? "text-paper-muted"
                          )}
                        >
                          {r.event_type}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-paper">{r.database}</td>
                      <td className="px-3 py-1.5 text-paper">{r.table}</td>
                      <td
                        className="max-w-[260px] truncate px-3 py-1.5 font-mono text-paper-muted"
                        title={r.part_name}
                      >
                        {r.part_name}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-paper-muted">{r.partition_id}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-paper">
                        {formatDuration(r.duration_ms)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-paper">
                        {r.rows.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-paper">
                        {formatBytes(r.size_in_bytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Bottom strip */}
        <div className="flex items-center justify-between border-t border-ink-500 pt-3 text-[11px] text-paper-faint">
          <span className="font-mono uppercase tracking-[0.14em]">
            {rows.length.toLocaleString()} / {(data?.length ?? 0).toLocaleString()} events
          </span>
          {isFetching && (
            <span className="inline-flex items-center gap-1.5 font-mono uppercase tracking-[0.14em]">
              <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
              Refreshing
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
