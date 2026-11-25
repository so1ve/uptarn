import { stripVTControlCharacters } from "node:util";

import type { Theme } from "clerc";

import type {
  AdminSettingsSummary,
  AlertEventSummary,
  CheckSnapshot,
  DashboardSnapshot,
  IncidentSummary,
  JobSummary,
  MonitorSummary,
  MountSnapshot,
  NodeSummary,
  PasskeySummary,
  SeriesSnapshot,
} from "../shared/index.ts";
import {
  formatAge,
  formatBps,
  formatDuration,
  formatMs,
  formatRemaining,
  formatSeriesValue,
  formatUsage,
  memPercent,
  percent,
  summarizeDisk,
} from "../shared/index.ts";

export interface TableColumn<T> {
  header: string;
  align?: "left" | "right";
  value: (row: T) => string;
}

export type KvEntry = [label: string, value: string] | false | null | undefined;

const col = <T>(
  header: string,
  value: (row: T) => string,
  align?: "left" | "right",
): TableColumn<T> => ({ header, value, align });

const visibleLength = (text: string): number =>
  stripVTControlCharacters(text).length;

function padCell(
  text: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  const spaces = " ".repeat(Math.max(0, width - visibleLength(text)));

  return align === "right" ? `${spaces}${text}` : `${text}${spaces}`;
}

export const renderBanner = (
  theme: Theme,
  title: string,
  subtitle?: string,
): string =>
  `${theme.brand("◆")} ${theme.bold(title)}${subtitle ? `  ${theme.muted(subtitle)}` : ""}`;

export const renderSection = (
  theme: Theme,
  title: string,
  subtitle?: string,
): string =>
  `\n${theme.heading(title.toUpperCase())}${subtitle ? ` ${theme.muted(subtitle)}` : ""}`;

export function renderKv(
  theme: Theme,
  entries: readonly KvEntry[],
  indent = "  ",
): string {
  const active = entries.filter((entry): entry is [string, string] =>
    Boolean(entry),
  );
  const maxLabel = Math.max(...active.map(([l]) => visibleLength(l)), 0);

  return active
    .map(
      ([label, value]) =>
        `${indent}${theme.muted(padCell(label, maxLabel + 2))}${value}`,
    )
    .join("\n");
}

export function renderTable<T>(
  theme: Theme,
  columns: readonly TableColumn<T>[],
  rows: readonly T[],
  indent = "  ",
): string {
  const renderedRows = rows.map((row) => columns.map((c) => c.value(row)));
  const widths = columns.map((c, i) =>
    Math.max(
      visibleLength(c.header),
      ...renderedRows.map((row) => visibleLength(row[i])),
    ),
  );
  const lastCol = columns.length - 1;
  const cell = (text: string, idx: number, align?: "left" | "right"): string =>
    idx === lastCol && align !== "right"
      ? text
      : padCell(text, widths[idx], align);

  return [
    `${indent}${columns.map((c, i) => theme.muted(cell(c.header, i, c.align))).join("  ")}`,
    `${indent}${theme.muted(widths.map((w) => "─".repeat(w)).join("  "))}`,
    ...renderedRows.map(
      (row) =>
        `${indent}${row.map((v, i) => cell(v, i, columns[i].align)).join("  ")}`,
    ),
  ].join("\n");
}

const STATUS_STYLE: Record<string, "success" | "warn" | "error"> = {
  ok: "success",
  resolved: "success",
  warn: "warn",
  pending: "warn",
  fail: "error",
  firing: "error",
  offline: "error",
  overdue: "error",
};

export function formatStatus(theme: Theme, status: string): string {
  const style = STATUS_STYLE[status];

  return style ? theme[style](status) : theme.muted(status);
}

export function formatVisibility(
  theme: Theme,
  isPublic: boolean,
  managed = false,
): string {
  const base = isPublic ? theme.accent("public") : theme.muted("private");

  return managed ? `${base} ${theme.muted("(agent)")}` : base;
}

const mutedOr = (theme: Theme, value: string | null | undefined): string =>
  theme.muted(value ?? "-");

const pctCell = (theme: Theme, pct: number | null | undefined): string =>
  pct === null || pct === undefined ? theme.muted("-") : `${pct.toFixed(0)}%`;

const mutedEntry = (theme: Theme, until: number, now: number): KvEntry =>
  until > now && ["Muted", theme.warn(`for ${formatRemaining(until, now)}`)];

const formatMonitorState = (theme: Theme, mon: MonitorSummary): string =>
  mon.enabled ? formatStatus(theme, mon.last_status) : theme.muted("paused");

const formatChannels = (
  theme: Theme,
  channels: AdminSettingsSummary["channels"],
): string =>
  [channels.telegram && "telegram", channels.matrix && "matrix"]
    .filter(Boolean)
    .join(", ") || theme.muted("none");

export const renderNodesTable = (
  theme: Theme,
  nodes: readonly NodeSummary[],
  now: number,
): string =>
  renderTable<NodeSummary>(
    theme,
    [
      col("ID", (n) => theme.bold(n.id)),
      ...(nodes.some((n) => n.group)
        ? [col<NodeSummary>("GROUP", (n) => mutedOr(theme, n.group))]
        : []),
      col("STATUS", (n) => formatStatus(theme, n.overall_status)),
      col("VISIBILITY", (n) =>
        formatVisibility(theme, n.is_public, n.public_managed),
      ),
      col("CPU", (n) => pctCell(theme, n.system?.cpu_pct), "right"),
      col("MEM", (n) => pctCell(theme, memPercent(n.system)), "right"),
      col(
        "DISK",
        (n) => pctCell(theme, summarizeDisk(n.mounts, n.primary_mount)?.pct),
        "right",
      ),
      col("SEEN", (n) => theme.muted(formatAge(n.last_seen_at, now)), "right"),
      col("LABEL", (n) => theme.muted(n.label)),
    ],
    nodes,
  );

export function renderNodeDetail(
  theme: Theme,
  node: NodeSummary,
  now: number,
): string {
  const disk = summarizeDisk(node.mounts, node.primary_mount);
  const memPct = memPercent(node.system);
  const sys = node.system;
  const cpuLoad = sys
    ? [
        sys.cpu_pct !== undefined && `${sys.cpu_pct.toFixed(1)}%`,
        sys.load_1m !== undefined && `load ${sys.load_1m.toFixed(2)}`,
      ]
        .filter(Boolean)
        .join("  ") || theme.muted("-")
    : "";

  const lines = [
    renderBanner(
      theme,
      node.id,
      node.label === node.id ? undefined : node.label,
    ),
    renderSection(theme, "Summary"),
    renderKv(theme, [
      ["Status", formatStatus(theme, node.overall_status)],
      node.group ? ["Group", node.group] : false,
      [
        "Visibility",
        formatVisibility(theme, node.is_public, node.public_managed),
      ],
      ["Last seen", formatAge(node.last_seen_at, now)],
      [
        "Interval / Grace",
        `${formatDuration(node.interval_secs)} / ${formatDuration(node.grace_secs)}`,
      ],
      ["Disk summary", node.primary_mount ?? "sum (all mounts)"],
      node.agent_version ? ["Agent", node.agent_version] : false,
      mutedEntry(theme, node.muted_until, now),
      sys ? ["Uptime", formatDuration(sys.uptime_secs)] : false,
      sys ? ["CPU / Load", cpuLoad] : false,
      sys
        ? [
            "Memory",
            memPct !== null &&
            sys.mem_used_bytes !== undefined &&
            sys.mem_total_bytes !== undefined
              ? `${memPct.toFixed(1)}% (${formatUsage(sys.mem_used_bytes, sys.mem_total_bytes)})`
              : theme.muted("-"),
          ]
        : false,
      disk
        ? [
            "Disk",
            disk.pct === null
              ? theme.warn(disk.error ?? "Unavailable")
              : `${disk.pct.toFixed(1)}% (${formatUsage(disk.used_bytes, disk.total_bytes)})`,
          ]
        : false,
      node.rx_bps !== null || node.tx_bps !== null
        ? [
            "Network",
            `RX ${formatBps(node.rx_bps ?? 0)}  TX ${formatBps(node.tx_bps ?? 0)}`,
          ]
        : false,
    ]),
  ];

  if (node.mounts.length > 0) {
    lines.push(
      renderSection(theme, "Mounts", `(${node.mounts.length})`),
      renderTable<MountSnapshot>(
        theme,
        [
          col("PATH", (m) =>
            node.primary_mount === m.path
              ? `${theme.bold(m.path)} ${theme.accent("*")}`
              : theme.bold(m.path),
          ),
          col("STATUS", (m) => formatStatus(theme, m.status)),
          col(
            "USED",
            (m) => pctCell(theme, percent(m.used_bytes, m.total_bytes)),
            "right",
          ),
          col(
            "CAPACITY",
            (m) =>
              m.total_bytes > 0
                ? formatUsage(m.used_bytes, m.total_bytes)
                : mutedOr(theme, m.summary),
            "right",
          ),
          col("LABEL", (m) => mutedOr(theme, m.label)),
        ],
        node.mounts,
      ),
    );
  }

  if (node.checks.length > 0) {
    lines.push(
      renderSection(theme, "Checks", `(${node.checks.length})`),
      renderTable<CheckSnapshot>(
        theme,
        [
          col("KEY", (c) => theme.bold(c.key)),
          col("STATUS", (c) => formatStatus(theme, c.status)),
          col("GROUP", (c) => mutedOr(theme, c.group)),
          col("LABEL", (c) => c.label),
          col("SUMMARY", (c) => mutedOr(theme, c.summary)),
        ],
        node.checks,
      ),
    );
  }

  if (node.series.length > 0) {
    lines.push(
      renderSection(theme, "Series", `(${node.series.length})`),
      renderTable<SeriesSnapshot>(
        theme,
        [
          col("KEY", (s) => theme.bold(s.key)),
          col("VALUE", (s) => formatSeriesValue(s.value, s.unit), "right"),
          col("STATUS", (s) =>
            s.status ? formatStatus(theme, s.status) : theme.muted("-"),
          ),
          col("GROUP", (s) => mutedOr(theme, s.group)),
          col("LABEL", (s) => s.label),
        ],
        node.series,
      ),
    );
  }

  if (node.info.length > 0) {
    lines.push(
      renderSection(theme, "Info", `(${node.info.length})`),
      renderKv(
        theme,
        node.info.map((item) => [item.label, item.value]),
      ),
    );
  }

  return lines.join("\n");
}

const formatMonitorProbe = (mon: MonitorSummary): string =>
  mon.probe.from === "agent" ? `${mon.probe.type} (agent)` : mon.probe.type;

const monitorTarget = (mon: MonitorSummary): string =>
  mon.probe.from === "hub" ? mon.probe.url : (mon.probe.target ?? "-");

export const renderMonitorsTable = (
  theme: Theme,
  monitors: readonly MonitorSummary[],
): string =>
  renderTable<MonitorSummary>(
    theme,
    [
      col("ID", (m) => theme.bold(m.id)),
      ...(monitors.some((m) => m.group)
        ? [col<MonitorSummary>("GROUP", (m) => mutedOr(theme, m.group))]
        : []),
      col("STATUS", (m) => formatMonitorState(theme, m)),
      col("PROBE", (m) => theme.muted(formatMonitorProbe(m))),
      col("VISIBILITY", (m) =>
        formatVisibility(theme, m.is_public, m.public_managed),
      ),
      col(
        "LATENCY",
        (m) =>
          m.last_latency_ms === null
            ? theme.muted("-")
            : formatMs(m.last_latency_ms),
        "right",
      ),
      col(
        "INTERVAL",
        (m) => theme.muted(formatDuration(m.interval_secs)),
        "right",
      ),
      col("NAME", (m) => m.name),
      col("TARGET", (m) => theme.muted(monitorTarget(m))),
    ],
    monitors,
  );

export function renderMonitorDetail(
  theme: Theme,
  mon: MonitorSummary,
  now: number,
): string {
  const okSamples = mon.samples.filter((s) => s.ok).length;
  const httpLatency =
    [
      mon.last_http_status !== null && `HTTP ${mon.last_http_status}`,
      mon.last_latency_ms !== null && formatMs(mon.last_latency_ms),
    ]
      .filter(Boolean)
      .join("  ") || theme.muted("-");

  return [
    renderBanner(theme, mon.id, mon.name),
    renderSection(theme, "Status"),
    renderKv(theme, [
      ["State", formatMonitorState(theme, mon)],
      ["HTTP / Latency", httpLatency],
      ["Last checked", formatAge(mon.last_checked_at, now)],
      [
        "Recent uptime",
        mon.samples.length > 0
          ? `${((okSamples / mon.samples.length) * 100).toFixed(1)}% (${okSamples}/${mon.samples.length})`
          : theme.muted("-"),
      ],
      mon.last_error ? ["Last error", theme.error(mon.last_error)] : false,
      mutedEntry(theme, mon.muted_until, now),
    ]),
    renderSection(theme, "Configuration"),
    renderKv(theme, [
      mon.group ? ["Group", mon.group] : false,
      ["Probe", `${mon.probe.type} (${mon.probe.from})`],
      ...(mon.probe.from === "hub"
        ? ([
            ["URL", mon.probe.url],
            mon.public_url ? ["Public URL", mon.public_url] : false,
            ["Method", mon.probe.method],
            [
              "Expected status",
              mon.probe.expected_status_min === mon.probe.expected_status_max
                ? String(mon.probe.expected_status_min)
                : `${mon.probe.expected_status_min}..${mon.probe.expected_status_max}`,
            ],
            mon.probe.expected_body
              ? ["Expected body", mon.probe.expected_body]
              : false,
            [
              "Interval / Timeout",
              `${formatDuration(mon.interval_secs)} / ${formatMs(mon.probe.timeout_ms)}`,
            ],
          ] as KvEntry[])
        : ([
            mon.probe.target ? ["Target", mon.probe.target] : false,
            mon.public_url ? ["Public URL", mon.public_url] : false,
            [
              "Interval / Grace",
              `${formatDuration(mon.interval_secs)} / ${formatDuration(mon.probe.grace_secs)}`,
            ],
          ] as KvEntry[])),
      [
        "Visibility",
        formatVisibility(theme, mon.is_public, mon.public_managed),
      ],
      [
        "Managed by",
        theme.muted(
          mon.managed_by_node_id ? `agent (${mon.managed_by_node_id})` : "hub",
        ),
      ],
    ]),
  ].join("\n");
}

export const renderJobsTable = (
  theme: Theme,
  jobs: readonly JobSummary[],
  now: number,
): string =>
  renderTable<JobSummary>(
    theme,
    [
      col("KEY", (j) => theme.bold(j.key)),
      col("STATUS", (j) => formatStatus(theme, j.overall_status)),
      col("NODE", (j) => mutedOr(theme, j.node_id)),
      col(
        "LAST RUN",
        (j) => theme.muted(formatAge(j.last_run_at, now)),
        "right",
      ),
      col(
        "INTERVAL",
        (j) => theme.muted(formatDuration(j.interval_secs)),
        "right",
      ),
      col("SUMMARY", (j) => mutedOr(theme, j.last_summary)),
    ],
    jobs,
  );

export function renderJobDetail(
  theme: Theme,
  job: JobSummary,
  now: number,
): string {
  const lines = [
    renderBanner(theme, job.key, job.label === job.key ? undefined : job.label),
    renderSection(theme, "Summary"),
    renderKv(theme, [
      ["Status", formatStatus(theme, job.overall_status)],
      ["Last status", formatStatus(theme, job.last_status)],
      ["Node", job.node_id ?? theme.muted("-")],
      ["Last run", formatAge(job.last_run_at, now)],
      [
        "Next due",
        job.next_due_at > now
          ? `in ${formatRemaining(job.next_due_at, now)}`
          : theme.error(`overdue by ${formatDuration(now - job.next_due_at)}`),
      ],
      [
        "Interval / Grace",
        `${formatDuration(job.interval_secs)} / ${formatDuration(job.grace_secs)}`,
      ],
      [
        "Duration",
        job.last_duration_ms === null
          ? theme.muted("-")
          : formatMs(job.last_duration_ms),
      ],
      mutedEntry(theme, job.muted_until, now),
      job.last_summary ? ["Summary", job.last_summary] : false,
    ]),
  ];
  if (job.last_detail) {
    lines.push(renderSection(theme, "Detail"), `  ${job.last_detail}`);
  }

  return lines.join("\n");
}

export const renderIncidentsList = (
  theme: Theme,
  incidents: readonly IncidentSummary[],
): string =>
  incidents
    .map(
      (inc) =>
        `  ${theme.error("!")} ${theme.bold(inc.label)} ${theme.muted(`[${inc.target_type}:${inc.target_id} ${inc.state}]`)}  ${inc.last_summary}`,
    )
    .join("\n");

export const renderIncidentEventsTable = (
  theme: Theme,
  events: readonly AlertEventSummary[],
  now: number,
): string =>
  renderTable<AlertEventSummary>(
    theme,
    [
      col("KIND", (e) => formatStatus(theme, e.kind)),
      col("TARGET", (e) => `${e.target_type}:${theme.bold(e.target_id)}`),
      col("LABEL", (e) => e.label),
      col("WHEN", (e) => theme.muted(formatAge(e.created_at, now)), "right"),
      col("SUMMARY", (e) => theme.muted(e.summary)),
    ],
    events,
  );

export const renderPasskeysTable = (
  theme: Theme,
  passkeys: readonly PasskeySummary[],
  now: number,
): string =>
  renderTable<PasskeySummary>(
    theme,
    [
      col("ID", (p) => theme.bold(p.id)),
      col("NAME", (p) => p.name),
      col("TYPE", (p) => theme.muted(p.device_type)),
      col("BACKED UP", (p) =>
        p.backed_up ? theme.success("yes") : theme.muted("no"),
      ),
      col("CREATED", (p) => theme.muted(formatAge(p.created_at, now)), "right"),
      col(
        "LAST USED",
        (p) => theme.muted(formatAge(p.last_used_at, now)),
        "right",
      ),
    ],
    passkeys,
  );

export function renderSettingsDetail(
  theme: Theme,
  settings: AdminSettingsSummary,
  now: number,
): string {
  const authMethods = [
    settings.auth.password_enabled && "password",
    settings.auth.cf_access_enabled && "cloudflare-access",
    settings.auth.passkey_count > 0 &&
      `passkeys (${settings.auth.passkey_count})`,
  ].filter(Boolean);

  return renderKv(theme, [
    settings.site_title ? ["Site title", settings.site_title] : false,
    settings.site_links.length > 0
      ? [
          "Site links",
          settings.site_links.map((l) => `${l.label} (${l.url})`).join(", "),
        ]
      : false,
    [
      "Auto-register",
      settings.auto_register ? theme.warn("enabled") : theme.muted("disabled"),
    ],
    [
      "Enrollment token",
      settings.enrollment_token
        ? theme.warn(settings.enrollment_token)
        : theme.muted("not set"),
    ],
    [
      "Global mute",
      settings.global_muted_until > now
        ? theme.warn(
            `muted for ${formatRemaining(settings.global_muted_until, now)}`,
          )
        : theme.muted("off"),
    ],
    ["Channels", formatChannels(theme, settings.channels)],
    [
      "Auth methods",
      authMethods.length > 0
        ? authMethods.join(", ")
        : theme.muted("token only"),
    ],
  ]);
}

export function renderStatusOverview(
  theme: Theme,
  data: DashboardSnapshot,
  now: number,
): string {
  const onlineNodes = data.nodes.filter(
    (n) => n.overall_status !== "offline" && n.overall_status !== "pending",
  ).length;
  const okMonitors = data.monitors.filter(
    (m) => m.enabled && m.last_status === "ok",
  ).length;

  const blocks = [
    renderBanner(
      theme,
      "Uptarn Hub",
      `${data.public_base_url} (v${data.version})`,
    ),
    renderSection(theme, "Overview"),
    renderKv(theme, [
      [
        "Nodes",
        `${theme.bold(String(onlineNodes))}/${data.nodes.length} online`,
      ],
      [
        "Monitors",
        `${theme.bold(String(okMonitors))}/${data.monitors.length} ok`,
      ],
      ["Jobs", theme.bold(String(data.jobs.length))],
      [
        "Incidents",
        data.incidents.length > 0
          ? theme.bold(theme.error(String(data.incidents.length)))
          : theme.success("0"),
      ],
      [
        "Auto-register",
        data.settings.auto_register
          ? theme.warn("enabled")
          : theme.muted("disabled"),
      ],
      ["Channels", formatChannels(theme, data.settings.channels)],
    ]),
  ];

  if (data.incidents.length > 0) {
    blocks.push(
      renderSection(theme, "Active Incidents", `(${data.incidents.length})`),
      renderIncidentsList(theme, data.incidents),
    );
  }
  blocks.push(
    renderSection(theme, "Nodes", `(${data.nodes.length})`),
    data.nodes.length === 0
      ? `  ${theme.muted("No nodes registered.")}`
      : renderNodesTable(theme, data.nodes, now),
    renderSection(theme, "Monitors", `(${data.monitors.length})`),
    data.monitors.length === 0
      ? `  ${theme.muted("No monitors configured.")}`
      : renderMonitorsTable(theme, data.monitors),
  );
  if (data.jobs.length > 0) {
    blocks.push(
      renderSection(theme, "Jobs", `(${data.jobs.length})`),
      renderJobsTable(theme, data.jobs, now),
    );
  }

  return blocks.join("\n");
}
