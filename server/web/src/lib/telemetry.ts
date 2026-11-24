import type {
  DashboardSnapshot,
  HealthStatus,
  IncidentSummary,
  MonitorSample,
  MonitorSummary,
  MountSnapshot,
  NodeSummary,
  SystemSnapshot,
  TargetType,
} from "../../../src/shared/index.ts";
import {
  formatBytes,
  formatSeriesValue,
  formatUsage,
  percent,
} from "./format.ts";

export type DotStatus =
  HealthStatus | NodeSummary["overall_status"] | "pending" | "overdue";

export function memPercent(system: SystemSnapshot | null): number | null {
  if (
    system?.mem_used_bytes === undefined ||
    system.mem_total_bytes === undefined
  ) {
    return null;
  }

  return percent(system.mem_used_bytes, system.mem_total_bytes);
}

export const mountPercent = (mount: MountSnapshot): number =>
  Math.min(100, Math.max(0, percent(mount.used_bytes, mount.total_bytes) ?? 0));

export function formatMountText(
  mount: MountSnapshot,
  includeFree = false,
): string {
  if (mount.total_bytes <= 0) {
    return mount.summary ?? mount.status;
  }
  const pct = Math.round(mountPercent(mount));
  const free = includeFree
    ? `, ${formatBytes(Math.max(0, mount.total_bytes - mount.used_bytes))} free`
    : "";

  return `${formatUsage(mount.used_bytes, mount.total_bytes)} (${pct}%${free})`;
}

export function usageTextClass(
  pct: number,
  warn: number,
  fail: number,
): string {
  if (pct >= fail) {
    return "text-red-500 dark:text-red-400";
  }

  return pct >= warn ? "text-amber-600 dark:text-amber-400" : "";
}

export const sparkLineColor = (
  pct: number,
  warn: number,
  fail: number,
  isDark: boolean,
  darkHex: string,
  lightHex: string,
): string =>
  pct >= fail
    ? "#ef4444"
    : pct >= warn
      ? "#f59e0b"
      : isDark
        ? darkHex
        : lightHex;

export function peakMount(
  mounts: readonly MountSnapshot[],
): MountSnapshot | null {
  if (mounts.length === 0) {
    return null;
  }

  return (
    mounts.find((m) => m.total_bytes === 0 && m.status === "fail") ??
    mounts.reduce((acc, m) => (mountPercent(m) > mountPercent(acc) ? m : acc))
  );
}

export interface NodeIssueSummary {
  text: string;
  compact: string;
  tone: "warn" | "fail";
}

export function nodeIssueSummary(
  node: NodeSummary,
  includeMounts = true,
): NodeIssueSummary | null {
  const problems = [
    ...(includeMounts ? node.mounts : [])
      .filter((m) => m.status !== "ok")
      .map((m) => ({
        label: m.label ?? m.path,
        detail:
          m.total_bytes > 0
            ? `${Math.round(mountPercent(m))}%`
            : (m.summary ?? "error"),
        fail: m.status === "fail",
      })),
    ...node.series
      .filter((s) => s.status && s.status !== "ok")
      .map((s) => ({
        label: s.label,
        detail:
          s.status === "fail" && s.summary
            ? s.summary
            : `${formatSeriesValue(s.value, s.unit)}${s.loss_pct && s.loss_pct > 0 ? `, ${Math.round(s.loss_pct)}% loss` : ""}`,
        fail: s.status === "fail",
      })),
    ...node.checks
      .filter((c) => c.status !== "ok")
      .map((c) => ({
        label: c.label,
        detail: c.summary ?? c.status,
        fail: c.status === "fail",
      })),
  ].sort((a, b) => Number(b.fail) - Number(a.fail));

  if (problems.length === 0) {
    return null;
  }

  const first = problems[0];
  const more = problems.length - 1;

  return {
    text: `${first.label} ${first.detail}${more > 0 ? ` (+${more} more)` : ""}`,
    compact: more > 0 ? `${first.label} +${more}` : first.label,
    tone: first.fail ? "fail" : "warn",
  };
}

export function sampleUptime(samples: readonly MonitorSample[]): number | null {
  const recent = samples.slice(-36);

  return recent.length === 0
    ? null
    : (recent.filter((s) => s.ok).length / recent.length) * 100;
}

export function monitorTarget(mon: MonitorSummary): string {
  const hostPath = mon.url.replace(/^https?:\/\//, "").replace(/\/$/, "");

  return mon.method === "GET" ? hostPath : `${mon.method} ${hostPath}`;
}

export function monitorLatencyStats(mon: MonitorSummary): string | null {
  const latencies = mon.samples
    .filter((s) => s.ok && s.latency_ms !== null)
    .map((s) => s.latency_ms!);
  if (latencies.length === 0) {
    return null;
  }
  const min = Math.round(Math.min(...latencies));
  const max = Math.round(Math.max(...latencies));
  const avg = Math.round(
    latencies.reduce((a, b) => a + b, 0) / latencies.length,
  );

  return `Min ${min} ms, avg ${avg} ms, max ${max} ms`;
}

export function splitIncident(inc: IncidentSummary): {
  kind: string;
  title: string;
} {
  if (inc.target_type === "monitor") {
    return { kind: "HTTP", title: inc.label.replace(/^HTTP:\s*/i, "") };
  }
  if (inc.target_type === "job") {
    return { kind: "Job", title: inc.label.replace(/^Job:\s*/i, "") };
  }

  return { kind: "Node", title: inc.label };
}

export const incidentRoute = (inc: IncidentSummary): string =>
  inc.target_type === "node"
    ? `/nodes/${encodeURIComponent(inc.target_id)}`
    : inc.target_type === "monitor"
      ? "/monitors"
      : "/jobs";

export function targetMutedUntil(
  snap: DashboardSnapshot,
  targetType: TargetType,
  targetId: string,
): number {
  if (targetType === "node") {
    return snap.nodes.find((n) => n.id === targetId)?.muted_until ?? 0;
  }
  if (targetType === "monitor") {
    return snap.monitors.find((m) => m.id === targetId)?.muted_until ?? 0;
  }

  return snap.jobs.find((j) => j.key === targetId)?.muted_until ?? 0;
}

export function deliveryStatus(delivery: Record<string, string>): {
  text: string;
  warn: boolean;
} {
  if (delivery.status === "no_channels_configured") {
    return { text: "No channel", warn: false };
  }
  const failed = Object.entries(delivery).filter(([, v]) => v !== "ok");

  return failed.length === 0
    ? { text: "Delivered", warn: false }
    : { text: `${failed.map(([k]) => k).join(", ")} failed`, warn: true };
}

export function statusDotClass(status: DotStatus): string {
  if (status === "ok") {
    return "bg-emerald-500";
  }
  if (status === "warn") {
    return "bg-amber-500";
  }

  return status === "pending" ? "bg-zinc-400 dark:bg-zinc-600" : "bg-red-500";
}

export function statusTextClass(
  status: HealthStatus | "ok" | "warn" | "fail",
  okClass = "text-muted",
): string {
  if (status === "fail") {
    return "text-red-500 dark:text-red-400";
  }

  return status === "warn" ? "text-amber-600 dark:text-amber-400" : okClass;
}

export function mountBarClass(status: HealthStatus): string {
  if (status === "fail") {
    return "bg-red-500";
  }

  return status === "warn" ? "bg-amber-500" : "bg-zinc-500 dark:bg-zinc-400";
}
