import type {
  DashboardSnapshot,
  HealthStatus,
  IncidentHistoryRecord,
  IncidentNoteSummary,
  IncidentReportImpact,
  IncidentReportStatus,
  IncidentReportUpdate,
  IncidentSummary,
  MonitorRollupBucket,
  MonitorSummary,
  MountSnapshot,
  NodeSummary,
  PublicIncidentNote,
  PublicMonitorSummary,
  TargetType,
} from "../../../src/shared/index.ts";
import {
  clampPct,
  formatBytes,
  formatSeriesWithLoss,
  formatUsage,
  incidentTargetPath,
  percent,
  splitAlertLabel,
} from "../../../src/shared/index.ts";

export type DotStatus =
  | HealthStatus
  | NodeSummary["overall_status"]
  | "pending"
  | "running"
  | "overdue";

export const mountPercent = (mount: MountSnapshot): number =>
  clampPct(percent(mount.used_bytes, mount.total_bytes) ?? 0);

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

export const uptimeToneClass = (pct: number | null): string =>
  pct === null
    ? "text-dimmed"
    : pct >= 99
      ? "text-emerald-600 dark:text-emerald-400"
      : pct >= 90
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-500 dark:text-red-400";

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
            : formatSeriesWithLoss(s.value, s.unit, s.loss_pct),
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

export type MonitorWindow = "live" | "24h" | "7d" | "15d" | "30d";

export const MONITOR_WINDOWS: readonly {
  value: MonitorWindow;
  label: string;
}[] = [
  { value: "live", label: "Live" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "15d", label: "15d" },
  { value: "30d", label: "30d" },
];

export const ROLLUP_WINDOW_SPEC: Record<
  Exclude<MonitorWindow, "live">,
  { key: "m30" | "h6" | "d1"; step: number; slots: number }
> = {
  "24h": { key: "m30", step: 1800, slots: 48 },
  "7d": { key: "h6", step: 21_600, slots: 28 },
  "15d": { key: "d1", step: 86_400, slots: 15 },
  "30d": { key: "d1", step: 86_400, slots: 30 },
};

export function getMonitorWindowBuckets(
  mon: MonitorSummary | PublicMonitorSummary,
  window: Exclude<MonitorWindow, "live">,
  now: number,
): MonitorRollupBucket[] {
  const { key, step, slots } = ROLLUP_WINDOW_SPEC[window];
  const endTs = Math.floor(now / step) * step;
  const minTs = endTs - (slots - 1) * step;

  return mon.rollups[key].filter((b) => b.ts >= minTs && b.ts <= endTs);
}

export function monitorUptime(
  mon: MonitorSummary | PublicMonitorSummary,
  window: MonitorWindow,
  now: number,
): { pct: number | null; ok: number; total: number } {
  if (window === "live") {
    const recent = mon.samples.slice(-36);
    const total = recent.length;
    const ok = recent.filter((s) => s.ok).length;

    return { pct: total === 0 ? null : (ok / total) * 100, ok, total };
  }
  const buckets = getMonitorWindowBuckets(mon, window, now);
  let ok = 0;
  let total = 0;
  for (const b of buckets) {
    ok += b.ok;
    total += b.total;
  }

  return { pct: total === 0 ? null : (ok / total) * 100, ok, total };
}

export function formatUptimePct(pct: number | null): string {
  if (pct === null) {
    return "-";
  }
  if (pct >= 100) {
    return "100%";
  }
  if (pct >= 99.9) {
    return `${Math.min(99.99, Math.floor(pct * 100) / 100).toFixed(2)}%`;
  }

  return `${pct.toFixed(1)}%`;
}

export const stripUrlScheme = (url: string): string =>
  url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export function monitorLatencyStats(
  mon: MonitorSummary | PublicMonitorSummary,
  window: MonitorWindow = "live",
  now = 0,
): string | null {
  const latencies =
    window === "live"
      ? mon.samples
          .filter((s) => s.ok && s.latency_ms !== null)
          .map((s) => s.latency_ms!)
      : getMonitorWindowBuckets(mon, window, now)
          .filter((b) => b.avg_ms !== null)
          .map((b) => b.avg_ms!);
  if (latencies.length === 0) {
    return null;
  }
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  return `Min ${Math.round(Math.min(...latencies))} ms, avg ${Math.round(avg)} ms, max ${Math.round(Math.max(...latencies))} ms`;
}

export function splitIncident(inc: IncidentSummary): {
  kind: string;
  title: string;
} {
  const { kind, subject } = splitAlertLabel(inc.target_type, inc.label);

  return { kind, title: inc.target_type === "node" ? inc.label : subject };
}

export const incidentRoute = (inc: IncidentSummary): string =>
  incidentTargetPath(inc.target_type, inc.target_id);

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

export interface DeliverySummary {
  text: string;
  warn: boolean;
  muted: boolean;
  detail: string | null;
}

export function deliveryStatus(
  firing: Record<string, string>,
  resolved?: Record<string, string> | null,
): DeliverySummary {
  const deliveries = [firing, ...(resolved ? [resolved] : [])];
  const failed = new Map<string, string>();
  for (const d of deliveries) {
    if (d.status) {
      continue;
    }
    for (const [k, v] of Object.entries(d)) {
      if (v !== "ok") {
        failed.set(k, v);
      }
    }
  }
  if (failed.size > 0) {
    return {
      text: `${[...failed.keys()].join(", ")} failed`,
      warn: true,
      muted: false,
      detail: [...failed.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"),
    };
  }
  if (deliveries.every((d) => d.status === "muted")) {
    return {
      text: "Muted",
      warn: false,
      muted: true,
      detail: "Notifications were suppressed by mute or maintenance window",
    };
  }
  if (deliveries.every((d) => d.status === "no_channels_configured")) {
    return { text: "No channel", warn: false, muted: false, detail: null };
  }
  const channels = new Set<string>();
  for (const d of deliveries) {
    if (!d.status) {
      for (const k of Object.keys(d)) {
        channels.add(k);
      }
    }
  }

  return {
    text: "Delivered",
    warn: false,
    muted: false,
    detail: channels.size > 0 ? `Sent via ${[...channels].join(", ")}` : null,
  };
}

export const INCIDENT_REPORT_STATUS_LABEL: Record<
  IncidentReportStatus,
  string
> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

export function incidentReportBadgeColor(
  status: IncidentReportStatus,
  impact: IncidentReportImpact,
): "success" | "warning" | "error" | "info" {
  if (status === "resolved") {
    return "success";
  }
  if (status === "monitoring") {
    return "info";
  }
  if (status === "investigating" && impact === "major") {
    return "error";
  }

  return "warning";
}

export function incidentReportDotStatus(
  status: IncidentReportStatus,
  impact: IncidentReportImpact,
): "ok" | "warn" | "fail" | "running" {
  if (status === "resolved") {
    return "ok";
  }
  if (status === "monitoring") {
    return "running";
  }

  return impact === "major" ? "fail" : "warn";
}

export interface TimelineEntry {
  key: string;
  editId?: string;
  status?: IncidentReportStatus | null;
  isPublic?: boolean;
  label: string;
  tone: "ok" | "warn" | "fail" | "info" | "neutral";
  message: string;
  timestamp: number;
  meta?: string | null;
  metaWarn?: boolean;
}

function statusTone(
  status: IncidentReportStatus | null,
  impact: IncidentReportImpact = "minor",
): TimelineEntry["tone"] {
  if (status === null) {
    return "neutral";
  }
  if (status === "resolved") {
    return "ok";
  }
  if (status === "monitoring") {
    return "info";
  }
  if (status === "investigating" && impact === "major") {
    return "fail";
  }

  return "warn";
}

export const incidentReportTimeline = (
  updates: readonly IncidentReportUpdate[],
  impact: IncidentReportImpact,
  editable = false,
): TimelineEntry[] =>
  [...updates]
    .sort((a, b) => b.created_at - a.created_at)
    .map((u): TimelineEntry => ({
      key: u.id,
      editId: editable ? u.id : undefined,
      status: u.status,
      label: u.status ? INCIDENT_REPORT_STATUS_LABEL[u.status] : "Update",
      tone: statusTone(u.status, impact),
      message: u.message,
      timestamp: u.created_at,
    }));

export function activeAutoIncidentTimeline(
  inc: IncidentSummary,
  notes: readonly IncidentNoteSummary[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = notes.map((n) => ({
    key: n.id,
    editId: n.id,
    status: n.status,
    isPublic: n.is_public,
    label: n.status ? INCIDENT_REPORT_STATUS_LABEL[n.status] : "Update",
    tone: statusTone(n.status),
    message: n.message,
    timestamp: n.created_at,
    meta: n.is_public ? null : "Internal only",
  }));

  entries.push({
    key: `auto:${inc.incident_key}`,
    label: inc.state === "open" ? "Alert firing" : "Check failing",
    tone: inc.state === "open" ? "fail" : "warn",
    message: inc.last_summary,
    timestamp: inc.opened_at ?? inc.last_changed_at,
  });

  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

export function historyRecordTimeline(
  rec: IncidentHistoryRecord,
  notes: readonly IncidentNoteSummary[] = [],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  if (rec.state === "resolved" && rec.resolved_at !== null) {
    const d = rec.resolved_delivery
      ? deliveryStatus(rec.resolved_delivery)
      : null;
    entries.push({
      key: `resolved:${rec.id}`,
      label: "Resolved",
      tone: "ok",
      message: rec.resolved_summary ?? "Target recovered",
      timestamp: rec.resolved_at,
      meta: d ? (d.detail ?? d.text) : null,
      metaWarn: d?.warn ?? false,
    });
  }

  for (const n of notes) {
    entries.push({
      key: n.id,
      editId: n.id,
      status: n.status,
      isPublic: n.is_public,
      label: n.status ? INCIDENT_REPORT_STATUS_LABEL[n.status] : "Update",
      tone: statusTone(n.status),
      message: n.message,
      timestamp: n.created_at,
      meta: n.is_public ? null : "Internal only",
    });
  }

  const firingD = deliveryStatus(rec.firing_delivery);
  entries.push({
    key: `firing:${rec.id}`,
    label: "Alert firing",
    tone: "fail",
    message: rec.summary,
    timestamp: rec.started_at,
    meta: firingD.detail ?? firingD.text,
    metaWarn: firingD.warn,
  });

  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

export function publicAutoIncidentTimeline(
  reason: string,
  startedAt: number,
  resolvedAt: number | null,
  notes: readonly PublicIncidentNote[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = notes.map((n) => ({
    key: n.id,
    label: n.status ? INCIDENT_REPORT_STATUS_LABEL[n.status] : "Update",
    tone: statusTone(n.status),
    message: n.message,
    timestamp: n.created_at,
  }));

  if (resolvedAt !== null) {
    entries.push({
      key: `pub-resolved:${resolvedAt}`,
      label: "Resolved",
      tone: "ok",
      message: "Service recovered",
      timestamp: resolvedAt,
    });
  }

  entries.push({
    key: `pub-started:${startedAt}`,
    label: "Detected",
    tone: "fail",
    message: reason,
    timestamp: startedAt,
  });

  return entries.sort((a, b) => b.timestamp - a.timestamp);
}
