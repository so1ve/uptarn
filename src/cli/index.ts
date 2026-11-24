#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

import { completionsPlugin } from "@clerc/plugin-completions";
import type { FlagsDefinition } from "clerc";
import { Types, clerc } from "clerc";

import manifest from "../../package.json" with { type: "json" };
import { runDatabaseMigrations, startNodeServer } from "../node.ts";
import type {
  DashboardSnapshot,
  JobSummary,
  MonitorSummary,
  NodeSummary,
} from "../shared/index.ts";
import {
  formatAge,
  formatMs,
  formatStatus,
  formatVisibility,
  memPercent,
  renderBanner,
  renderKv,
  renderSection,
  renderTable,
  unixNow,
} from "./format.ts";
import {
  applySyncPlan,
  computeSyncPlan,
  parseSyncSpec,
  renderSyncPlan,
} from "./sync.ts";

interface ResolvedAuth {
  server: string;
  token: string;
}

function resolveAuth(
  flags: { server?: string; token?: string; tokenFile?: string },
  fallbackServer?: string,
): ResolvedAuth {
  const server = (flags.server ?? fallbackServer)?.trim().replace(/\/+$/, "");
  if (!server) {
    throw new Error(
      "Missing hub URL. Pass --server, set UPTARN_SERVER, or declare hub_url in the sync file.",
    );
  }
  const token =
    flags.token?.trim() ||
    (flags.tokenFile ? fs.readFileSync(flags.tokenFile, "utf8").trim() : "");
  if (!token) {
    throw new Error(
      "Missing admin token. Pass --token / --token-file or set UPTARN_ADMIN_TOKEN / UPTARN_ADMIN_TOKEN_FILE.",
    );
  }

  return { server, token };
}

const createAdminRequester = (auth: ResolvedAuth) =>
  async function adminRequest<T>(
    method: string,
    apiPath: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${auth.server}${apiPath}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${auth.token}`,
      "User-Agent": `uptarn-cli/${manifest.version}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) {
          detail = parsed.error;
        }
      } catch {
        // Keep raw body text when response is not JSON.
      }

      throw new Error(
        `admin request ${method} ${url} failed (${response.status}): ${detail || response.statusText}`,
      );
    }

    return await response.json();
  };

const adminAuthFlags = {
  server: {
    type: String,
    placeholder: "url",
    env: "UPTARN_SERVER",
    required: true,
    description: "Base URL of the Uptarn hub",
  },
  token: {
    type: String,
    placeholder: "token",
    env: "UPTARN_ADMIN_TOKEN",
    description: "Admin Bearer token",
  },
  tokenFile: {
    type: String,
    env: "UPTARN_ADMIN_TOKEN_FILE",
    description: "Path to a file containing the admin Bearer token",
  },
} as const satisfies FlagsDefinition;

const optionalServerAuthFlags = {
  server: {
    type: String,
    placeholder: "url",
    env: "UPTARN_SERVER",
    description: "Base URL of the Uptarn hub (overrides hub_url in config)",
  },
  token: adminAuthFlags.token,
  tokenFile: adminAuthFlags.tokenFile,
} as const satisfies FlagsDefinition;

const jsonFlag = {
  json: {
    type: Boolean,
    description: "Output raw JSON",
  },
} as const satisfies FlagsDefinition;

const dbFlags = {
  db: {
    type: String,
    env: "UPTARN_DB_PATH",
    default: "./uptarn.db",
    description: "Local SQLite database path",
  },
} as const satisfies FlagsDefinition;

const cli = clerc({
  name: "uptarn",
  description: manifest.description,
  version: manifest.version,
  notes: [
    "Environment variables:",
    "  UPTARN_SERVER            Base URL of the Uptarn hub",
    "  UPTARN_ADMIN_TOKEN       Admin Bearer token",
    "  UPTARN_ADMIN_TOKEN_FILE  Path to a file containing the admin Bearer token",
  ],
})
  .groups({
    commands: {
      sync: "Declarative Sync",
      admin: "Administration",
      server: "Server",
    },
  })
  .use(completionsPlugin())
  .command("sync <file>", {
    description: "Reconcile hub configuration from a declarative JSON file",
    group: "sync",
    args: {
      file: {
        description: "Path to declarative Uptarn JSON config",
      },
    },
    flags: {
      ...optionalServerAuthFlags,
      dryRun: {
        type: Boolean,
        short: "n",
        description: "Show planned changes without mutating the hub",
      },
      prune: {
        type: Boolean,
        description: "Delete hub-managed monitors not declared in the file",
      },
      ...jsonFlag,
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const raw = JSON.parse(fs.readFileSync(ctx.args.file, "utf8")) as unknown;
      const spec = parseSyncSpec(raw);
      const auth = resolveAuth(ctx.flags, spec.hub_url);
      const request = createAdminRequester(auth);
      const snapshot = await request<DashboardSnapshot>(
        "GET",
        "/api/v1/admin/snapshot",
      );
      const plan = computeSyncPlan(snapshot, spec, { prune: ctx.flags.prune });

      if (ctx.flags.json) {
        if (!ctx.flags.dryRun && plan.hasChanges) {
          await applySyncPlan(request, plan);
        }
        ctx.terminal.stdout(
          JSON.stringify(
            {
              server: auth.server,
              dry_run: Boolean(ctx.flags.dryRun),
              applied: !ctx.flags.dryRun && plan.hasChanges,
              plan,
            },
            null,
            2,
          ),
        );

        return;
      }

      ctx.terminal.stdout(
        renderBanner(
          theme,
          ctx.flags.dryRun ? "Uptarn Plan" : "Uptarn Sync",
          auth.server,
        ),
      );
      ctx.terminal.stdout(
        renderSyncPlan(theme, plan, { dryRun: ctx.flags.dryRun }),
      );

      if (ctx.flags.dryRun || !plan.hasChanges) {
        return;
      }

      await applySyncPlan(request, plan);
      ctx.log.success("Applied changes to hub.");
    },
  })
  .command("status", {
    description: "Show hub overview, nodes, monitors, jobs, and incidents",
    group: "admin",
    flags: { ...adminAuthFlags, ...jsonFlag },
    async run(ctx) {
      const { theme } = ctx.log;
      const request = createAdminRequester(resolveAuth(ctx.flags));
      const data = await request<DashboardSnapshot>(
        "GET",
        "/api/v1/admin/snapshot",
      );

      if (ctx.flags.json) {
        ctx.terminal.stdout(JSON.stringify(data, null, 2));

        return;
      }

      const now = data.now || unixNow();
      const onlineNodes = data.nodes.filter(
        (n) => n.overall_status !== "offline" && n.overall_status !== "pending",
      ).length;
      const okMonitors = data.monitors.filter(
        (m) => m.enabled && m.last_status === "ok",
      ).length;
      const channels = [
        data.settings.channels.telegram && "telegram",
        data.settings.channels.matrix && "matrix",
      ].filter(Boolean);

      ctx.terminal.stdout(
        renderBanner(
          theme,
          "Uptarn Hub",
          `${data.public_base_url} (v${data.version})`,
        ),
      );
      ctx.terminal.stdout(renderSection(theme, "Overview"));
      ctx.terminal.stdout(
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
          [
            "Channels",
            channels.length > 0 ? channels.join(", ") : theme.muted("none"),
          ],
        ]),
      );

      if (data.incidents.length > 0) {
        ctx.terminal.stdout(
          renderSection(
            theme,
            "Active Incidents",
            `(${data.incidents.length})`,
          ),
        );
        for (const inc of data.incidents) {
          ctx.terminal.stdout(
            `  ${theme.error("!")} ${theme.bold(inc.label)} ${theme.muted(`[${inc.state}]`)}  ${inc.last_summary}`,
          );
        }
      }

      ctx.terminal.stdout(
        renderSection(theme, "Nodes", `(${data.nodes.length})`),
      );
      if (data.nodes.length === 0) {
        ctx.terminal.stdout(`  ${theme.muted("No nodes registered.")}`);
      } else {
        ctx.terminal.stdout(
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
                value: (n) =>
                  formatVisibility(theme, n.is_public, n.public_managed),
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
                header: "SEEN",
                align: "right",
                value: (n) => theme.muted(formatAge(n.last_seen_at, now)),
              },
              {
                header: "LABEL",
                value: (n) => theme.muted(n.label),
              },
            ],
            data.nodes,
          ),
        );
      }

      ctx.terminal.stdout(
        renderSection(theme, "Monitors", `(${data.monitors.length})`),
      );
      if (data.monitors.length === 0) {
        ctx.terminal.stdout(`  ${theme.muted("No monitors configured.")}`);
      } else {
        ctx.terminal.stdout(
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
                  formatVisibility(
                    theme,
                    m.is_public,
                    m.managed_by_node_id !== null,
                  ),
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
                header: "NAME",
                value: (m) => m.name,
              },
              {
                header: "URL",
                value: (m) => theme.muted(m.url),
              },
            ],
            data.monitors,
          ),
        );
      }

      if (data.jobs.length > 0) {
        ctx.terminal.stdout(
          renderSection(theme, "Jobs", `(${data.jobs.length})`),
        );
        ctx.terminal.stdout(
          renderTable<JobSummary>(
            theme,
            [
              { header: "KEY", value: (j) => theme.bold(j.key) },
              {
                header: "STATUS",
                value: (j) => formatStatus(theme, j.overall_status),
              },
              {
                header: "LAST RUN",
                align: "right",
                value: (j) => theme.muted(formatAge(j.last_run_at, now)),
              },
              {
                header: "SUMMARY",
                value: (j) => theme.muted(j.last_summary ?? "-"),
              },
            ],
            data.jobs,
          ),
        );
      }
    },
  })
  .command("node", {
    description: "Manage registered nodes",
    group: "admin",
  })
  .command("node add <id>", {
    description: "Register a new node and issue its ingest token",
    args: {
      id: { description: "Unique node identifier" },
    },
    flags: {
      ...adminAuthFlags,
      label: { type: String, description: "Human-readable node label" },
      interval: {
        type: Types.Integer,
        description: "Expected report interval in seconds",
      },
      grace: {
        type: Types.Integer,
        description: "Offline grace period in seconds",
      },
      public: {
        type: Boolean,
        description: "Show this node on the public status page",
      },
      ...jsonFlag,
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const request = createAdminRequester(resolveAuth(ctx.flags));
      const res = await request<{ id: string; label: string; token: string }>(
        "POST",
        "/api/v1/admin/nodes",
        {
          id: ctx.args.id,
          label: ctx.flags.label,
          interval_secs: ctx.flags.interval,
          grace_secs: ctx.flags.grace,
          is_public: ctx.flags.public,
        },
      );
      if (ctx.flags.json) {
        ctx.terminal.stdout(JSON.stringify(res, null, 2));

        return;
      }
      ctx.log
        .success(`Registered node ${theme.bold(res.id)} (${res.label})`)
        .line(`Token  ${theme.warn(res.token)}`);
    },
  })
  .command("node public <id> <state>", {
    description: "Set a node's public status page visibility (on/off)",
    args: {
      id: { description: "Node identifier" },
      state: {
        type: Types.Enum("on", "off"),
        description: "Visibility: on or off",
      },
    },
    flags: adminAuthFlags,
    async run(ctx) {
      const { theme } = ctx.log;
      const isPublic = ctx.args.state === "on";
      const request = createAdminRequester(resolveAuth(ctx.flags));
      await request(
        "PATCH",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}`,
        { is_public: isPublic },
      );
      ctx.log.success(
        `Node ${theme.bold(ctx.args.id)} is now ${isPublic ? theme.accent("public") : theme.muted("private")}.`,
      );
    },
  })
  .command("node rotate <id>", {
    description: "Rotate a node's ingest Bearer token",
    args: {
      id: { description: "Node identifier" },
    },
    flags: { ...adminAuthFlags, ...jsonFlag },
    async run(ctx) {
      const { theme } = ctx.log;
      const request = createAdminRequester(resolveAuth(ctx.flags));
      const res = await request<{ id: string; token: string }>(
        "POST",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}/rotate-token`,
      );
      if (ctx.flags.json) {
        ctx.terminal.stdout(JSON.stringify(res, null, 2));

        return;
      }
      ctx.log
        .success(`Rotated token for ${theme.bold(res.id)}`)
        .line(`Token  ${theme.warn(res.token)}`);
    },
  })
  .command("node rm <id>", {
    description: "Delete a registered node and its telemetry",
    args: {
      id: { description: "Node identifier" },
    },
    flags: adminAuthFlags,
    async run(ctx) {
      const { theme } = ctx.log;
      const request = createAdminRequester(resolveAuth(ctx.flags));
      await request(
        "DELETE",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}`,
      );
      ctx.log.success(`Removed node ${theme.bold(ctx.args.id)}.`);
    },
  })
  .command("monitor", {
    description: "Manage HTTP monitors",
    group: "admin",
  })
  .command("monitor rm <id>", {
    description: "Delete a hub-managed HTTP monitor",
    args: {
      id: { description: "Monitor identifier" },
    },
    flags: adminAuthFlags,
    async run(ctx) {
      const { theme } = ctx.log;
      const request = createAdminRequester(resolveAuth(ctx.flags));
      await request(
        "DELETE",
        `/api/v1/admin/monitors/${encodeURIComponent(ctx.args.id)}`,
      );
      ctx.log.success(`Removed monitor ${theme.bold(ctx.args.id)}.`);
    },
  })
  .command("mute <targetType> <targetId>", {
    description: "Mute or unmute alerts for a node, monitor, or job",
    group: "admin",
    args: {
      targetType: {
        type: Types.Enum("node", "monitor", "job"),
        description: "node, monitor, or job",
      },
      targetId: { description: "Target identifier" },
    },
    flags: {
      ...adminAuthFlags,
      duration: {
        type: Types.Integer,
        short: "d",
        default: 3600,
        description: "Mute duration in seconds (0 unmutes)",
      },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const request = createAdminRequester(resolveAuth(ctx.flags));
      const res = await request<{ muted_until: number }>(
        "POST",
        "/api/v1/admin/mute",
        {
          target_type: ctx.args.targetType,
          target_id: ctx.args.targetId,
          duration_secs: ctx.flags.duration,
        },
      );
      if (res.muted_until === 0) {
        ctx.log.success(
          `Unmuted ${ctx.args.targetType} ${theme.bold(ctx.args.targetId)}.`,
        );
      } else {
        ctx.log.success(
          `Muted ${ctx.args.targetType} ${theme.bold(ctx.args.targetId)} for ${ctx.flags.duration}s.`,
        );
      }
    },
  })
  .command("tick", {
    description: "Trigger an immediate hub tick and force-probe monitors",
    group: "admin",
    flags: { ...adminAuthFlags, ...jsonFlag },
    async run(ctx) {
      const request = createAdminRequester(resolveAuth(ctx.flags));
      const res = await request<{
        probed_monitors: number;
        offline_nodes: number;
        overdue_jobs: number;
      }>("POST", "/api/v1/admin/tick");
      if (ctx.flags.json) {
        ctx.terminal.stdout(JSON.stringify(res, null, 2));

        return;
      }
      ctx.log.success(
        `Tick completed: ${res.probed_monitors} monitors probed, ${res.offline_nodes} offline nodes, ${res.overdue_jobs} overdue jobs.`,
      );
    },
  })
  .command("notify", {
    description: "Manage notification channels",
    group: "admin",
  })
  .command("notify test", {
    description: "Send a test notification to configured IM channels",
    flags: { ...adminAuthFlags, ...jsonFlag },
    async run(ctx) {
      const request = createAdminRequester(resolveAuth(ctx.flags));
      const res = await request<{ delivery: Record<string, string> }>(
        "POST",
        "/api/v1/admin/notifications/test",
      );
      if (ctx.flags.json) {
        ctx.terminal.stdout(JSON.stringify(res, null, 2));

        return;
      }
      const entries = Object.entries(res.delivery);
      if (entries.length === 0) {
        ctx.log.warn("No notification channels configured.");

        return;
      }
      ctx.log.success(
        `Test notification sent: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`,
      );
    },
  })
  .command("serve", {
    description: "Run the portable Node.js + SQLite Uptarn hub server",
    group: "server",
    flags: {
      host: {
        type: String,
        env: "HOST",
        default: "127.0.0.1",
        description: "Bind address",
      },
      port: {
        type: Types.Integer,
        env: "PORT",
        default: 8787,
        description: "Bind port",
      },
      ...dbFlags,
      tickInterval: {
        type: Types.Integer,
        env: "TICK_INTERVAL_SECS",
        default: 60,
        description: "Periodic tick interval in seconds (0 disables)",
      },
    },
    async run(ctx) {
      const running = await startNodeServer({
        host: ctx.flags.host,
        port: ctx.flags.port,
        dbPath: ctx.flags.db,
        tickIntervalSecs: ctx.flags.tickInterval,
        env: { ...ctx.terminal.env },
      });

      function shutdown(signal: string) {
        ctx.terminal.stdout(
          JSON.stringify({ message: "shutting down uptarn hub", signal }),
        );
        void running.close().finally(() => process.exit(0));
      }
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    },
  })
  .command("migrate", {
    description: "Apply SQL migrations to a local SQLite database",
    group: "server",
    flags: dbFlags,
    async run(ctx) {
      const { applied, dbPath } = await runDatabaseMigrations(ctx.flags.db);
      if (applied.length === 0) {
        ctx.log.info(`Database (${dbPath}) is already up to date.`);
      } else {
        ctx.log.success(
          `Applied ${applied.length} migration(s) to ${dbPath}: ${applied.join(", ")}`,
        );
      }
    },
  });

await cli.runMain();
