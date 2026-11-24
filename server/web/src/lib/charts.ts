import type { EChartsCoreOption } from "echarts/core";

import type {
  MonitorSummary,
  NodeSummary,
  SeriesPoint,
  SeriesSnapshot,
} from "../../../src/shared/index.ts";
import { formatClock, formatSeriesValue } from "./format.ts";

const AXIS_LABEL = {
  color: "#71717a",
  fontSize: 10.5,
  fontFamily: "Geist Mono",
};

const chartPalette = (isDark: boolean) => ({
  gridColor: isDark ? "rgba(255,255,255,0.07)" : "rgba(9,9,11,0.07)",
  areaOpacity: isDark ? 0.14 : 0.1,
  tooltipBg: isDark ? "#18181b" : "#ffffff",
  tooltipBorder: isDark ? "#27272a" : "#e4e4e7",
  tooltipText: isDark ? "#fafafa" : "#09090b",
  tooltipMuted: isDark ? "#a1a1aa" : "#71717a",
  cpu: isDark ? "#60a5fa" : "#2563eb",
  mem: isDark ? "#a78bfa" : "#7c3aed",
  probe: isDark ? "#38bdf8" : "#0284c7",
  loss: isDark ? "#f87171" : "#dc2626",
});

interface AxisTooltipItem {
  axisValueLabel?: string;
  seriesName?: string;
  seriesIndex?: number;
  color?: unknown;
  value?: unknown;
}

const escapeHtml = (input: string) =>
  input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function baseTooltip(
  isDark: boolean,
  valueFormatter: (v: unknown, idx?: number) => string,
) {
  const p = chartPalette(isDark);

  return {
    trigger: "axis",
    backgroundColor: p.tooltipBg,
    borderColor: p.tooltipBorder,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: {
      color: p.tooltipText,
      fontSize: 12,
      fontWeight: 400,
      fontFamily: "Geist Mono, monospace",
    },
    formatter: (raw: unknown) => {
      const items = (Array.isArray(raw) ? raw : [raw]) as AxisTooltipItem[];
      const header = items[0]?.axisValueLabel ?? "";
      const rows = items
        .map((item) => {
          const dotColor =
            typeof item.color === "string" ? item.color : p.tooltipMuted;
          const label = escapeHtml(item.seriesName ?? "");
          const formatted = escapeHtml(
            valueFormatter(item.value, item.seriesIndex),
          );

          return `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;line-height:1.55"><span style="display:inline-flex;align-items:center;gap:6px;color:${p.tooltipMuted};font-weight:400"><span style="width:7px;height:7px;border-radius:9999px;background:${escapeHtml(dotColor)};flex:none"></span>${label}</span><span style="color:${p.tooltipText};font-weight:500;font-variant-numeric:tabular-nums">${formatted}</span></div>`;
        })
        .join("");

      return `<div style="font-size:11px;color:${p.tooltipMuted};font-weight:400;margin-bottom:4px">${escapeHtml(header)}</div>${rows}`;
    },
  };
}

const timeAxis = (timestamps: readonly number[]) => ({
  type: "category",
  boundaryGap: false,
  data: timestamps.map((ts) => formatClock(ts)),
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: AXIS_LABEL,
});

const valueAxis = (
  gridColor: string,
  extra: Record<string, unknown> = {},
  formatter?: string,
) => ({
  type: "value",
  ...extra,
  splitLine: { lineStyle: { color: gridColor, type: "dashed" } },
  axisLabel: formatter ? { ...AXIS_LABEL, formatter } : AXIS_LABEL,
});

const areaLine = (
  name: string,
  color: string,
  data: readonly (number | null)[],
  isDark: boolean,
  connectNulls = false,
) => ({
  name,
  type: "line",
  smooth: 0.2,
  showSymbol: false,
  connectNulls,
  data,
  lineStyle: { width: 2, color },
  itemStyle: { color },
  areaStyle: { color, opacity: chartPalette(isDark).areaOpacity },
});

export const buildSparkOption = (
  points: readonly SeriesPoint[],
  color: string,
  isDark: boolean,
): EChartsCoreOption => ({
  animation: false,
  grid: { left: 1, right: 1, top: 3, bottom: 2 },
  xAxis: {
    type: "category",
    show: false,
    boundaryGap: false,
    data: points.map((p) => p.ts),
  },
  yAxis: { type: "value", show: false, min: 0, max: 100 },
  series: [
    {
      type: "line",
      data: points.map((p) => p.value),
      showSymbol: false,
      smooth: 0.25,
      lineStyle: { width: 1.5, color },
      areaStyle: { color, opacity: isDark ? 0.16 : 0.12 },
    },
  ],
});

export function buildComputeChartOption(
  node: NodeSummary,
  isDark: boolean,
): EChartsCoreOption | null {
  const cpuPts = node.history._cpu ?? [];
  const memPts = node.history._mem ?? [];
  if (cpuPts.length < 2 && memPts.length < 2) {
    return null;
  }

  const timestamps = [
    ...new Set([...cpuPts.map((p) => p.ts), ...memPts.map((p) => p.ts)]),
  ].sort((a, b) => a - b);
  const cpuMap = new Map(cpuPts.map((p) => [p.ts, p.value]));
  const memMap = new Map(memPts.map((p) => [p.ts, p.value]));
  const p = chartPalette(isDark);

  const series: unknown[] = [];
  if (cpuPts.length >= 2) {
    series.push(
      areaLine(
        "CPU",
        p.cpu,
        timestamps.map((ts) => cpuMap.get(ts) ?? null),
        isDark,
        true,
      ),
    );
  }
  if (memPts.length >= 2) {
    series.push(
      areaLine(
        "Memory",
        p.mem,
        timestamps.map((ts) => memMap.get(ts) ?? null),
        isDark,
        true,
      ),
    );
  }

  return {
    animationDuration: 220,
    grid: { left: 40, right: 14, top: 14, bottom: 24 },
    tooltip: baseTooltip(isDark, (v) =>
      typeof v === "number" ? `${v.toFixed(1)}%` : "-",
    ),
    xAxis: timeAxis(timestamps),
    yAxis: valueAxis(
      p.gridColor,
      { min: 0, max: 100, interval: 25 },
      "{value}%",
    ),
    series,
  };
}

export interface ProbeChartItem {
  series: SeriesSnapshot;
  stats: string;
  option: EChartsCoreOption;
}

export function buildProbeCharts(
  node: NodeSummary,
  isDark: boolean,
): ProbeChartItem[] {
  const p = chartPalette(isDark);
  const items: ProbeChartItem[] = [];

  for (const s of node.series) {
    const pts = node.history[s.key] ?? [];
    if (pts.length < 2) {
      continue;
    }
    const vals = pts.map((pt) => pt.value);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    if (s.unit !== "ms" && minV === maxV) {
      continue;
    }
    const avgV = vals.reduce((a, b) => a + b, 0) / vals.length;
    const color =
      s.status === "fail"
        ? "#ef4444"
        : s.status === "warn"
          ? "#f59e0b"
          : p.probe;

    const chartSeries: unknown[] = [areaLine(s.label, color, vals, isDark)];
    if (pts.some((pt) => (pt.aux ?? 0) > 0)) {
      chartSeries.push({
        name: "Packet loss",
        type: "bar",
        yAxisIndex: 1,
        barWidth: 4,
        data: pts.map((pt) => pt.aux ?? 0),
        itemStyle: {
          color: p.loss,
          opacity: 0.85,
          borderRadius: [2, 2, 0, 0],
        },
      });
    }

    items.push({
      series: s,
      stats: `Min ${formatSeriesValue(minV, s.unit)}, avg ${formatSeriesValue(avgV, s.unit)}, max ${formatSeriesValue(maxV, s.unit)}`,
      option: {
        animationDuration: 220,
        grid: { left: 44, right: 14, top: 14, bottom: 24 },
        tooltip: baseTooltip(isDark, (v, idx) =>
          typeof v === "number"
            ? idx === 1
              ? `${Math.round(v)}%`
              : formatSeriesValue(v, s.unit)
            : "-",
        ),
        xAxis: timeAxis(pts.map((pt) => pt.ts)),
        yAxis: [
          valueAxis(p.gridColor, { splitNumber: 3 }),
          { type: "value", show: false, min: 0, max: 100 },
        ],
        series: chartSeries,
      },
    });
  }

  return items;
}

export function buildMonitorLatencyOption(
  mon: MonitorSummary,
  isDark: boolean,
): EChartsCoreOption {
  const p = chartPalette(isDark);

  return {
    animationDuration: 180,
    grid: { left: 46, right: 14, top: 14, bottom: 24 },
    tooltip: baseTooltip(isDark, (v) =>
      typeof v === "number" ? `${Math.round(v)} ms` : "Failed",
    ),
    xAxis: timeAxis(mon.samples.map((s) => s.ts)),
    yAxis: valueAxis(p.gridColor, { splitNumber: 3 }, "{value} ms"),
    series: [
      areaLine(
        "Latency",
        p.cpu,
        mon.samples.map((s) => (s.ok ? s.latency_ms : null)),
        isDark,
      ),
    ],
  };
}
