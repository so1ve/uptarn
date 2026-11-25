import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import type { EChartsCoreOption } from "echarts/core";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import type {
  MonitorSummary,
  NodeSummary,
  PublicMonitorSummary,
  SeriesPoint,
  SeriesSnapshot,
} from "../../../src/shared/index.ts";
import {
  escapeHtml,
  formatBps,
  formatSeriesValue,
  formatTimestamp,
} from "../../../src/shared/index.ts";
import type { MonitorWindow } from "./telemetry.ts";
import { getMonitorWindowBuckets } from "./telemetry.ts";

use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

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

type ChartPalette = ReturnType<typeof chartPalette>;

interface AxisTooltipItem {
  axisValueLabel?: string;
  seriesName?: string;
  seriesIndex?: number;
  color?: unknown;
  value?: unknown;
}

const baseTooltip = (
  p: ChartPalette,
  valueFormatter: (v: unknown, idx?: number) => string,
) => ({
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
});

const valueAxis = (
  gridColor: string,
  extra: Record<string, unknown> = {},
  formatter?: string | ((v: number) => string),
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
  areaOpacity: number,
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
  areaStyle: { color, opacity: areaOpacity },
});

const cartesianOption = (opts: {
  p: ChartPalette;
  gridLeft: number;
  timestamps: readonly number[];
  showDate: boolean;
  yAxis: unknown;
  series: unknown[];
  tooltipFmt: (v: unknown, idx?: number) => string;
  duration?: number;
}): EChartsCoreOption => ({
  animationDuration: opts.duration ?? 220,
  grid: { left: opts.gridLeft, right: 14, top: 14, bottom: 24 },
  tooltip: baseTooltip(opts.p, opts.tooltipFmt),
  xAxis: {
    type: "category",
    boundaryGap: false,
    data: opts.timestamps.map((ts) => formatTimestamp(ts, opts.showDate)),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: AXIS_LABEL,
  },
  yAxis: opts.yAxis,
  series: opts.series,
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

function buildDualAreaOption(
  channels: readonly [string, string, readonly SeriesPoint[]][],
  p: ChartPalette,
  showDate: boolean,
  gridLeft: number,
  yAxisExtra: Record<string, unknown>,
  yAxisFmt: string | ((v: number) => string),
  tooltipFmt: (v: number) => string,
): EChartsCoreOption | null {
  const active = channels.filter(([, , pts]) => pts.length >= 2);
  if (active.length === 0) {
    return null;
  }
  const timestamps = [
    ...new Set(active.flatMap(([, , pts]) => pts.map((pt) => pt.ts))),
  ].sort((a, b) => a - b);

  return cartesianOption({
    p,
    gridLeft,
    timestamps,
    showDate,
    yAxis: valueAxis(p.gridColor, yAxisExtra, yAxisFmt),
    tooltipFmt: (v) => (typeof v === "number" ? tooltipFmt(v) : "-"),
    series: active.map(([name, color, pts]) => {
      const byTs = new Map(pts.map((pt) => [pt.ts, pt.value]));

      return areaLine(
        name,
        color,
        timestamps.map((ts) => byTs.get(ts) ?? null),
        p.areaOpacity,
        true,
      );
    }),
  });
}

export function buildComputeChartOption(
  node: NodeSummary,
  isDark: boolean,
  history: Record<string, SeriesPoint[]> = node.history,
  showDate = false,
): EChartsCoreOption | null {
  const p = chartPalette(isDark);

  return buildDualAreaOption(
    [
      ["CPU", p.cpu, history._cpu ?? []],
      ["Memory", p.mem, history._mem ?? []],
    ],
    p,
    showDate,
    40,
    { min: 0, max: 100, interval: 25 },
    "{value}%",
    (v) => `${v.toFixed(1)}%`,
  );
}

export function buildNetworkChartOption(
  node: NodeSummary,
  isDark: boolean,
  history: Record<string, SeriesPoint[]> = node.history,
  showDate = false,
): EChartsCoreOption | null {
  const p = chartPalette(isDark);

  return buildDualAreaOption(
    [
      ["RX", p.cpu, history._rx_bps ?? []],
      ["TX", p.mem, history._tx_bps ?? []],
    ],
    p,
    showDate,
    66,
    { min: 0, splitNumber: 3 },
    formatBps,
    formatBps,
  );
}

export interface ProbeChartItem {
  series: SeriesSnapshot;
  stats: string;
  option: EChartsCoreOption;
}

export function buildProbeCharts(
  node: NodeSummary,
  isDark: boolean,
  history: Record<string, SeriesPoint[]> = node.history,
  showDate = false,
): ProbeChartItem[] {
  const p = chartPalette(isDark);
  const items: ProbeChartItem[] = [];

  for (const s of node.series) {
    const pts = history[s.key] ?? [];
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

    const series: unknown[] = [areaLine(s.label, color, vals, p.areaOpacity)];
    if (pts.some((pt) => (pt.aux ?? 0) > 0)) {
      series.push({
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
      option: cartesianOption({
        p,
        gridLeft: 44,
        timestamps: pts.map((pt) => pt.ts),
        showDate,
        yAxis: [
          valueAxis(p.gridColor, { splitNumber: 3 }),
          { type: "value", show: false, min: 0, max: 100 },
        ],
        series,
        tooltipFmt: (v, idx) =>
          typeof v === "number"
            ? idx === 1
              ? `${Math.round(v)}%`
              : formatSeriesValue(v, s.unit)
            : "-",
      }),
    });
  }

  return items;
}

export function buildMonitorLatencyOption(
  mon: MonitorSummary | PublicMonitorSummary,
  isDark: boolean,
  window: MonitorWindow = "live",
  now = 0,
): EChartsCoreOption | null {
  const p = chartPalette(isDark);
  const points =
    window === "live"
      ? mon.samples.map((s) => ({ ts: s.ts, ms: s.ok ? s.latency_ms : null }))
      : getMonitorWindowBuckets(mon, window, now).map((b) => ({
          ts: b.ts,
          ms: b.avg_ms,
        }));
  if (points.length < 2) {
    return null;
  }

  return cartesianOption({
    p,
    gridLeft: 46,
    duration: 180,
    timestamps: points.map((pt) => pt.ts),
    showDate: window !== "live" && window !== "24h",
    yAxis: valueAxis(p.gridColor, { splitNumber: 3 }, "{value} ms"),
    tooltipFmt: (v) =>
      typeof v === "number" ? `${Math.round(v)} ms` : "Failed",
    series: [
      areaLine(
        window === "live" ? "Latency" : "Avg latency",
        p.cpu,
        points.map((pt) => pt.ms),
        p.areaOpacity,
      ),
    ],
  });
}
