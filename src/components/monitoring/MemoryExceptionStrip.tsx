import { AlertTriangle, Activity, Clock, Database } from "lucide-react";

import { useMemoryExceptionSummary } from "@/hooks/useMonitoringTimeline";
import { cn, formatBytes } from "@/lib/utils";

interface MemoryExceptionStripProps {
  hoursBack?: number;
}

/**
 * "Did anything blow up?" strip — OOMs, timeouts, exception count, plus the
 * peak attempted memory of the worst OOM. Sits inside the Memory tab card
 * so DE/Data Platform team can see at a glance whether the window had
 * actual incidents, not just nominal usage.
 */
export function MemoryExceptionStrip({ hoursBack = 1 }: MemoryExceptionStripProps) {
  const { data, isLoading } = useMemoryExceptionSummary(hoursBack);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 px-4 py-3 md:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-xs bg-ink-300" />
        ))}
      </div>
    );
  }
  if (!data) return null;

  const tiles = [
    {
      key: "oom",
      icon: AlertTriangle,
      label: "OOM kills",
      value: data.oom_count,
      hint: data.oom_count > 0 ? `peak ${formatBytes(data.worst_memory_attempt_bytes) || "—"}` : "memory_limit_exceeded",
      warn: data.oom_count > 0,
    },
    {
      key: "timeouts",
      icon: Clock,
      label: "Timeouts",
      value: data.timeout_count,
      hint: "max_execution_time",
      warn: data.timeout_count > 0,
    },
    {
      key: "too_many",
      icon: Database,
      label: "Too-many-rows",
      value: data.too_many_rows,
      hint: "result/row limits",
      warn: data.too_many_rows > 0,
    },
    {
      key: "total",
      icon: Activity,
      label: "Total exceptions",
      value: data.total_exceptions,
      hint: `last ${hoursBack}h`,
      warn: false,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 px-4 py-3 md:grid-cols-4">
      {tiles.map(({ key, icon: Icon, label, value, hint, warn }) => (
        <div
          key={key}
          className={cn(
            "flex items-center gap-3 rounded-xs border px-3 py-2",
            warn
              ? "border-amber-500/40 bg-amber-500/[0.06]"
              : "border-ink-500 bg-ink-100"
          )}
        >
          <span
            className={cn(
              "grid h-7 w-7 shrink-0 place-items-center rounded-xs border",
              warn
                ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-ink-500 bg-ink-200 text-paper-muted"
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-paper-faint">
              {label}
            </div>
            <div
              className={cn(
                "font-mono text-[16px] font-semibold leading-tight tabular-nums",
                warn ? "text-amber-800 dark:text-amber-100" : "text-paper"
              )}
            >
              {value.toLocaleString()}
            </div>
            <div className="font-mono text-[9px] text-paper-faint">{hint}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
