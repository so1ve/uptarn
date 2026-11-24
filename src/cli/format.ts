import { stripVTControlCharacters } from "node:util";

import type { Theme } from "clerc";

import type {
  AdminSettingsSummary,
  AlertEventSummary,
  IncidentSummary,
  JobSummary,
  MonitorSummary,
  NodeSummary,
  PasskeySummary,
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
  summarizeDisk,
} from "../shared/index.ts";

export {
  formatAge,
  formatBps,
  formatBytes,
  formatDuration,
  formatMs,
  formatRemaining,
  formatSeriesValue,
  formatUsage,
  memPercent,
  summarizeDisk,
  unixNow,
} from "../shared/index.ts";

export interface TableColumn<T> {
  header: string;
  align?: "left" | "right";
  value: (row: T) => string;
}

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
  subtitle
    ? `${theme.brand("◆")} ${theme.bold(title)}  ${theme.muted(subtitle)}`
    : `${theme.brand("◆")} ${theme.bold(title)}`;

export const renderSection = (
  theme: Theme,
  title: string,
  subtitle?: string,
): string =>
  subtitle
    ? `\n${theme.heading(title.toUpperCase())} ${theme.muted(subtitle)}`
    : `\n${theme.heading(title.toUpperCase())}`;

export function renderKv(
  theme: Theme,
  entries: readonly [label: string, value: string][],
  indent = "  ",
): string {
  const maxLabel = Math.max(
    ...entries.map(([label]) => visibleLength(label)),
    0,
  );

  return entries
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
  const renderedRows = rows.map((row) => columns.map((col) => col.value(row)));
  const widths = columns.map((col, i) =>
    Math.max(
      visibleLength(col.header),
      ...renderedRows.map((row) => visibleLength(row[i])),
    ),
  );
  const lastCol = columns.length - 1;
  const formatCell = (
    text: string,
    idx: number,
    align?: "left" | "right",
  ): string =>
    idx === lastCol && align !== "right"
      ? text
      : padCell(text, widths[idx], align);

  return [
    `${indent}${columns.map((col, i) => theme.muted(formatCell(col.header, i, col.align))).join("  ")}`,
    `${indent}${theme.muted(widths.map((w) => "─".repeat(w)).join("  "))}`,
    ...renderedRows.map(
      (row) =>
        `${indent}${row.map((cell, i) => formatCell(cell, i, columns[i].align)).join("  ")}`,
    ),
  ].join("\n");
}

export function formatStatus(theme: Theme, status: string): string {
  switch (status) {
    case "ok":
    case "resolved": {
      return theme.success(status);
    }
    case "warn":
    case "pending": {
      return theme.warn(status);
    }
    case "fail":
    case "firing":
    case "offline":
    case "overdue": {
      return theme.error(status);
    }
    default: {
      return theme.muted(status);
    }
  }
}

export function formatVisibility(
  theme: Theme,
  isPublic: boolean,
  managed = false,
): string {
  const base = isPublic ? theme.accent("public") : theme.muted("private");

  return managed ? `${base} ${theme.muted("(agent)")}` : base;
}

export const renderNodesTable = (
  theme: Theme,
  nodes: readonly NodeSummary[],
  now: number,
): string =>
  renderTable<NodeSummary>(
    theme,
    [
      { header: "ID", value: (n) => theme.bold(n.id) },
      {
        header: "STATUS",
        value: (n) => formatStatus(theme, n.overall_status),
      },
      {
        header: "VISIBILITY",
        value: (n) => formatVisibility(theme, n.is_public, n.public_managed),
      },
      {
        header: "CPU",
        align: "right",
        value: (n) =>
          n.system?.cpu_pct === undefined
            ? theme.muted("-")
            : `${n.system.cpu_pct.toFixed(0)}%`,
      },
      {
        header: "MEM",
        align: "right",
        value: (n) => {
          const pct = memPercent(n.system);

          return pct === null ? theme.muted("-") : `${pct.toFixed(0)}%`;
        },
      },
      {
        header: "DISK",
        align: "right",
        value: (n) => {
          const disk = summarizeDisk(n.mounts, n.primary_mount);

          return disk?.pct === null || disk === null
            ? theme.muted("-")
            : `${disk.pct.toFixed(0)}%`;
        },
      },
      {
        header: "SEEN",
        align: "right",
        value: (n) => theme.muted(formatAge(n.last_seen_at, now)),
      },
      {
        header: "LABEL",
        value: (n) => theme.muted(n.label),
      },
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
  const lines: string[] = [
    renderBanner(
      theme,
      node.id,
      node.label === node.id ? undefined : node.label,
    ),
    renderSection(theme, "Summary"),
    renderKv(theme, [
      ["Status", formatStatus(theme, node.overall_status)],
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
      ...(node.agent_version
        ? [["Agent", node.agent_version] as [string, string]]
        : []),
      ...(node.muted_until > now
        ? [
            [
              "Muted",
              theme.warn(`for ${formatRemaining(node.muted_until, now)}`),
            ] as [string, string],
          ]
        : []),
      ...(node.system
        ? [
            ["Uptime", formatDuration(node.system.uptime_secs)] as [
              string,
              string,
            ],
            [
              "CPU / Load",
              [
                node.system.cpu_pct === undefined
                  ? null
                  : `${node.system.cpu_pct.toFixed(1)}%`,
                node.system.load_1m === undefined
                  ? null
                  : `load ${node.system.load_1m.toFixed(2)}`,
              ]
                .filter(Boolean)
                .join("  ") || theme.muted("-"),
            ] as [string, string],
            [
              "Memory",
              memPct !== null &&
              node.system.mem_used_bytes !== undefined &&
              node.system.mem_total_bytes !== undefined
                ? `${memPct.toFixed(1)}% (${formatUsage(node.system.mem_used_bytes, node.system.mem_total_bytes)})`
                : theme.muted("-"),
            ] as [string, string],
          ]
        : []),
      ...(disk
        ? [
            [
              "Disk",
              disk.pct === null
                ? theme.warn(disk.error ?? "Unavailable")
                : `${disk.pct.toFixed(1)}% (${formatUsage(disk.used_bytes, disk.total_bytes)})`,
            ] as [string, string],
          ]
        : []),
      ...(node.rx_bps !== null || node.tx_bps !== null
        ? [
            [
              "Network",
              `RX ${formatBps(node.rx_bps ?? 0)}  TX ${formatBps(node.tx_bps ?? 0)}`,
            ] as [string, string],
          ]
        : []),
    ]),
  ];

  if (node.mounts.length > 0) {
    lines.push(
      renderSection(theme, "Mounts", `(${node.mounts.length})`),
      renderTable(
        theme,
        [
          {
            header: "PATH",
            value: (m) =>
              node.primary_mount === m.path
                ? `${theme.bold(m.path)} ${theme.accent("*")}`
                : theme.bold(m.path),
          },
          { header: "STATUS", value: (m) => formatStatus(theme, m.status) },
          {
            header: "USED",
            align: "right",
            value: (m) =>
              m.total_bytes > 0
                ? `${((m.used_bytes / m.total_bytes) * 100).toFixed(0)}%`
                : theme.muted("-"),
          },
          {
            header: "CAPACITY",
            align: "right",
            value: (m) =>
              m.total_bytes > 0
                ? formatUsage(m.used_bytes, m.total_bytes)
                : theme.muted(m.summary ?? "-"),
          },
          { header: "LABEL", value: (m) => theme.muted(m.label ?? "-") },
        ],
        node.mounts,
      ),
    );
  }

  if (node.checks.length > 0) {
    lines.push(
      renderSection(theme, "Checks", `(${node.checks.length})`),
      renderTable(
        theme,
        [
          { header: "KEY", value: (c) => theme.bold(c.key) },
          { header: "STATUS", value: (c) => formatStatus(theme, c.status) },
          { header: "GROUP", value: (c) => theme.muted(c.group ?? "-") },
          { header: "LABEL", value: (c) => c.label },
          { header: "SUMMARY", value: (c) => theme.muted(c.summary ?? "-") },
        ],
        node.checks,
      ),
    );
  }

  if (node.series.length > 0) {
    lines.push(
      renderSection(theme, "Series", `(${node.series.length})`),
      renderTable(
        theme,
        [
          { header: "KEY", value: (s) => theme.bold(s.key) },
          {
            header: "VALUE",
            align: "right",
            value: (s) => formatSeriesValue(s.value, s.unit),
          },
          {
            header: "STATUS",
            value: (s) =>
              s.status ? formatStatus(theme, s.status) : theme.muted("-"),
          },
          { header: "GROUP", value: (s) => theme.muted(s.group ?? "-") },
          { header: "LABEL", value: (s) => s.label },
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

export const renderMonitorsTable = (
  theme: Theme,
  monitors: readonly MonitorSummary[],
): string =>
  renderTable<MonitorSummary>(
    theme,
    [
      { header: "ID", value: (m) => theme.bold(m.id) },
      {
        header: "STATUS",
        value: (m) =>
          m.enabled
            ? formatStatus(theme, m.last_status)
            : theme.muted("paused"),
      },
      {
        header: "VISIBILITY",
        value: (m) =>
          formatVisibility(theme, m.is_public, m.managed_by_node_id !== null),
      },
      {
        header: "LATENCY",
        align: "right",
        value: (m) =>
          m.last_latency_ms === null
            ? theme.muted("-")
            : formatMs(m.last_latency_ms),
      },
      {
        header: "INTERVAL",
        align: "right",
        value: (m) => theme.muted(formatDuration(m.interval_secs)),
      },
      { header: "NAME", value: (m) => m.name },
      { header: "URL", value: (m) => theme.muted(m.url) },
    ],
    monitors,
  );

export function renderMonitorDetail(
  theme: Theme,
  monitor: MonitorSummary,
  now: number,
): string {
  const okSamples = monitor.samples.filter((s) => s.ok).length;
  const uptimeText =
    monitor.samples.length > 0
      ? `${((okSamples / monitor.samples.length) * 100).toFixed(1)}% (${okSamples}/${monitor.samples.length})`
      : theme.muted("-");
  const manager = monitor.managed_by_node_id
    ? `agent (${monitor.managed_by_node_id})`
    : "hub";

  return [
    renderBanner(theme, monitor.id, monitor.name),
    renderSection(theme, "Status"),
    renderKv(theme, [
      [
        "State",
        monitor.enabled
          ? formatStatus(theme, monitor.last_status)
          : theme.muted("paused"),
      ],
      [
        "HTTP / Latency",
        [
          monitor.last_http_status === null
            ? null
            : `HTTP ${monitor.last_http_status}`,
          monitor.last_latency_ms === null
            ? null
            : formatMs(monitor.last_latency_ms),
        ]
          .filter(Boolean)
          .join("  ") || theme.muted("-"),
      ],
      ["Last checked", formatAge(monitor.last_checked_at, now)],
      ["Recent uptime", uptimeText],
      ...(monitor.last_error
        ? [["Last error", theme.error(monitor.last_error)] as [string, string]]
        : []),
      ...(monitor.muted_until > now
        ? [
            [
              "Muted",
              theme.warn(`for ${formatRemaining(monitor.muted_until, now)}`),
            ] as [string, string],
          ]
        : []),
    ]),
    renderSection(theme, "Configuration"),
    renderKv(theme, [
      ["URL", monitor.url],
      ...(monitor.public_url
        ? [["Public URL", monitor.public_url] as [string, string]]
        : []),
      ["Method", monitor.method],
      [
        "Expected status",
        monitor.expected_status_min === monitor.expected_status_max
          ? String(monitor.expected_status_min)
          : `${monitor.expected_status_min}..${monitor.expected_status_max}`,
      ],
      ...(monitor.expected_body
        ? [["Expected body", monitor.expected_body] as [string, string]]
        : []),
      [
        "Interval / Timeout",
        `${formatDuration(monitor.interval_secs)} / ${formatMs(monitor.timeout_ms)}`,
      ],
      [
        "Visibility",
        formatVisibility(
          theme,
          monitor.is_public,
          monitor.managed_by_node_id !== null,
        ),
      ],
      ["Managed by", theme.muted(manager)],
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
      { header: "KEY", value: (j) => theme.bold(j.key) },
      { header: "STATUS", value: (j) => formatStatus(theme, j.overall_status) },
      { header: "NODE", value: (j) => theme.muted(j.node_id ?? "-") },
      {
        header: "LAST RUN",
        align: "right",
        value: (j) => theme.muted(formatAge(j.last_run_at, now)),
      },
      {
        header: "INTERVAL",
        align: "right",
        value: (j) => theme.muted(formatDuration(j.interval_secs)),
      },
      { header: "SUMMARY", value: (j) => theme.muted(j.last_summary ?? "-") },
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
      ...(job.muted_until > now
        ? [
            [
              "Muted",
              theme.warn(`for ${formatRemaining(job.muted_until, now)}`),
            ] as [string, string],
          ]
        : []),
      ...(job.last_summary
        ? [["Summary", job.last_summary] as [string, string]]
        : []),
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
      { header: "KIND", value: (e) => formatStatus(theme, e.kind) },
      {
        header: "TARGET",
        value: (e) => `${e.target_type}:${theme.bold(e.target_id)}`,
      },
      { header: "LABEL", value: (e) => e.label },
      {
        header: "WHEN",
        align: "right",
        value: (e) => theme.muted(formatAge(e.created_at, now)),
      },
      { header: "SUMMARY", value: (e) => theme.muted(e.summary) },
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
      { header: "ID", value: (p) => theme.bold(p.id) },
      { header: "NAME", value: (p) => p.name },
      { header: "TYPE", value: (p) => theme.muted(p.device_type) },
      {
        header: "BACKED UP",
        value: (p) => (p.backed_up ? theme.success("yes") : theme.muted("no")),
      },
      {
        header: "CREATED",
        align: "right",
        value: (p) => theme.muted(formatAge(p.created_at, now)),
      },
      {
        header: "LAST USED",
        align: "right",
        value: (p) => theme.muted(formatAge(p.last_used_at, now)),
      },
    ],
    passkeys,
  );

export function renderSettingsDetail(
  theme: Theme,
  settings: AdminSettingsSummary,
  now: number,
): string {
  const channels = [
    settings.channels.telegram && "telegram",
    settings.channels.matrix && "matrix",
  ].filter(Boolean);
  const authMethods = [
    settings.auth.password_enabled && "password",
    settings.auth.cf_access_enabled && "cloudflare-access",
    settings.auth.passkey_count > 0 &&
      `passkeys (${settings.auth.passkey_count})`,
  ].filter(Boolean);

  return renderKv(theme, [
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
    [
      "Channels",
      channels.length > 0 ? channels.join(", ") : theme.muted("none"),
    ],
    [
      "Auth methods",
      authMethods.length > 0
        ? authMethods.join(", ")
        : theme.muted("token only"),
    ],
  ]);
}
