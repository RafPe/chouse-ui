import { Combine, FileStack, Network, GitMerge, HardDriveDownload, Activity } from "lucide-react";

import { useBackgroundPoolSaturation } from "@/hooks/useMonitoringTimeline";
import { cn } from "@/lib/utils";

/**
 * Live snapshot of the background pools that drive merges, mutations,
 * fetches, schedules, and replication coordination. When any of these pin
 * for sustained periods, DE/Data Platform team needs to see it because
 * downstream symptoms (slow inserts, replication lag, "too many parts"
 * errors) trace back here.
 */
export function BackgroundPoolStrip() {
  const { data, isLoading } = useBackgroundPoolSaturation();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 px-4 py-3 md:grid-cols-3 lg:grid-cols-6">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-xs bg-ink-300" />
        ))}
      </div>
    );
  }
  if (!data) return null;

  const tiles = [
    {
      key: "merges",
      icon: GitMerge,
      label: "Merges/mutations",
      value: data.merges_mutations_running,
      hint: "active workers",
    },
    {
      key: "fetches",
      icon: HardDriveDownload,
      label: "Replica fetches",
      value: data.fetches_running,
      hint: "pulling parts",
    },
    {
      key: "schedule",
      icon: Activity,
      label: "Schedule pool",
      value: data.schedule_pool_running,
      hint: "periodic tasks",
    },
    {
      key: "common",
      icon: Combine,
      label: "Common pool",
      value: data.common_pool_running,
      hint: "shared workers",
    },
    {
      key: "distributed",
      icon: Network,
      label: "Distributed",
      value: data.distributed_running,
      hint: "shard coordination",
    },
    {
      key: "buffer",
      icon: FileStack,
      label: "Buffer flush",
      value: data.buffer_flush_running,
      hint: "Buffer engine",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 px-4 py-3 md:grid-cols-3 lg:grid-cols-6">
      {tiles.map(({ key, icon: Icon, label, value, hint }) => {
        // Mild warning threshold — anything >5 in a normal pool, >20 for merges
        const warn = key === "merges" ? value >= 20 : value >= 5;
        return (
          <div
            key={key}
            className={cn(
              "flex items-center gap-2.5 rounded-xs border px-3 py-2",
              warn
                ? "border-amber-500/40 bg-amber-500/[0.06]"
                : "border-ink-500 bg-ink-100"
            )}
          >
            <span
              className={cn(
                "grid h-6 w-6 shrink-0 place-items-center rounded-xs border",
                warn
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-ink-500 bg-ink-200 text-paper-muted"
              )}
            >
              <Icon className="h-3 w-3" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-paper-faint truncate">
                {label}
              </div>
              <div
                className={cn(
                  "font-mono text-[14px] font-semibold leading-tight tabular-nums",
                  warn ? "text-amber-800 dark:text-amber-100" : "text-paper"
                )}
              >
                {value.toLocaleString()}
              </div>
              <div className="font-mono text-[9px] text-paper-faint truncate">{hint}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
