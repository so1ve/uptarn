import type {
  DashboardSnapshot,
  HealthStatus,
  IncidentSummary,
  MonitorSample,
  MonitorSummary,
  MountSnapshot,
  NodeSummary,
  TargetType,
} from "../../../src/shared/index.ts";
import {
  formatBytes,
  formatSeriesValue,
  formatUsage,
  percent,
} from "../../../src/shared/index.ts";

export type DotStatus =
  HealthStatus | NodeSummary["overall_status"] | "pending" | "overdue";

export const mountPercent = (mount: MountSnapshot): number =>
  Math.min(100, Math.max(0, percent(mount.used_bytes, mount.total_bytes) ?? 0));

export function formatMountText(
  mount: MountSnapshot,
  includeFree = false,
): string {
  if (mount.total_bytes <= 0) {
    return mount.summary ?? mount.status;
  }
  const free = includeFree
    ? `, ${formatBytes(Math.max(0, mount.total_bytes - mount.used_bytes))} free`
    : "";

  return `${formatUsage(mount.used_bytes, mount.total_bytes)} (${Math.round(mountPercent(mount))}%${free})`;
}

export const usageTextClass = (
  pct: number,
  warn: number,
  fail: number,
): string =>
  pct >= fail
    ? "text-red-500 dark:text-red-400"
    : pct >= warn
      ? "text-amber-600 dark:text-amber-400"
      : "";

export const statusTextClass = (
  status: HealthStatus | "ok" | "warn" | "fail",
  okClass = "text-muted",
): string =>
  status === "fail"
    ? "text-red-500 dark:text-red-400"
    : status === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : okClass;

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

  const first = problems[0];
  if (!first) {
    return null;
  }
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

export const stripUrlScheme = (url: string): string =>
  url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export function monitorLatencyStats(mon: MonitorSummary): string | null {
  const latencies = mon.samples
    .filter((s) => s.ok && s.latency_ms !== null)
    .map((s) => s.latency_ms!);
  if (latencies.length === 0) {
    return null;
  }
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  return `Min ${Math.round(Math.min(...latencies))} ms, avg ${Math.round(avg)} ms, max ${Math.round(Math.max(...latencies))} ms`;
}

export const splitIncident = (
  inc: IncidentSummary,
): { kind: string; title: string } =>
  inc.target_type === "monitor"
    ? { kind: "HTTP", title: inc.label.replace(/^HTTP:\s*/i, "") }
    : inc.target_type === "job"
      ? { kind: "Job", title: inc.label.replace(/^Job:\s*/i, "") }
      : { kind: "Node", title: inc.label };

export const incidentRoute = (inc: IncidentSummary): string =>
  inc.target_type === "node"
    ? `/nodes/${encodeURIComponent(inc.target_id)}`
    : inc.target_type === "monitor"
      ? "/monitors"
      : "/jobs";

export const targetMutedUntil = (
  snap: DashboardSnapshot,
  targetType: TargetType,
  targetId: string,
): number =>
  (targetType === "node"
    ? snap.nodes.find((n) => n.id === targetId)?.muted_until
    : targetType === "monitor"
      ? snap.monitors.find((m) => m.id === targetId)?.muted_until
      : snap.jobs.find((j) => j.key === targetId)?.muted_until) ?? 0;

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
