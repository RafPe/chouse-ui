import { useMemo } from "react";
import { useTheme } from "@/components/common/theme-provider";

export interface ChartColors {
  grid: string;
  tick: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  tooltipLabel: string;
  cursor: string;
}

const DARK: ChartColors = {
  grid: "#262626",
  tick: "#71717a",
  tooltipBg: "#141414",
  tooltipBorder: "#262626",
  tooltipText: "#ffffff",
  tooltipLabel: "#a1a1aa",
  cursor: "rgba(255, 255, 255, 0.03)",
};

const LIGHT: ChartColors = {
  grid: "#e7e5e0",
  tick: "#78716c",
  tooltipBg: "#ffffff",
  tooltipBorder: "#d6d3cd",
  tooltipText: "#1c1917",
  tooltipLabel: "#57534e",
  cursor: "rgba(28, 25, 23, 0.04)",
};

/**
 * Theme-aware color palette for recharts components. SVG attributes don't
 * resolve CSS vars, so we pick concrete hex values here based on the
 * resolved theme from the ThemeProvider.
 */
export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  return useMemo(() => (resolvedTheme === "light" ? LIGHT : DARK), [resolvedTheme]);
}
