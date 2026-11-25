import fs from "node:fs";
import process from "node:process";

import { completionsPlugin } from "@clerc/plugin-completions";
import type { CustomRuleDescriptor, FlagsDefinition } from "clerc";
import { MissingRequiredFlagError, RuleError, Types, clerc } from "clerc";

import manifest from "../../package.json" with { type: "json" };
import type { TickReport } from "../domain/tick.ts";
import { runDatabaseMigrations, startNodeServer } from "../node.ts";
import type { DashboardSnapshot, MonitorInput } from "../shared/index.ts";
import {
  renderBanner,
  renderIncidentEventsTable,
  renderIncidentsList,
  renderJobDetail,
  renderJobsTable,
  renderKv,
  renderMonitorDetail,
  renderMonitorsTable,
  renderNodeDetail,
  renderNodesTable,
  renderPasskeysTable,
  renderSection,
  renderSettingsDetail,
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
    throw new MissingRequiredFlagError(
      ["server"],
      [
        "provide '--server', set UPTARN_SERVER, or declare 'hub_url' in the sync file",
      ],
    );
  }
  const token =
    flags.token ??
    (flags.tokenFile ? fs.readFileSync(flags.tokenFile, "utf8").trim() : "");
  if (!token) {
    throw new RuleError(`token file '${flags.tokenFile}' is empty`).addHint(
      "write your admin token to the file or pass '--token'",
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

const nonEmptyString = Types.String({ trim: true, nonEmpty: true });
const monitorMethodType = Types.Enum("GET", "HEAD", "POST");
const onOffType = Types.Enum("on", "off");
const targetTypeArg = Types.Enum("node", "monitor", "job");
const nonNegativeInt = Types.Integer({ min: 0 });
const httpStatusCode = Types.Integer({ min: 100, max: 599 });
const nodeIntervalSecs = Types.Integer({ min: 10, max: 86_400 });
const nodeGraceSecs = Types.Integer({ min: 10, max: 604_800 });
const monitorIntervalSecs = Types.Integer({ min: 30, max: 86_400 });
const monitorTimeoutMs = Types.Integer({ min: 500, max: 30_000 });
const tcpPort = Types.Integer({ min: 1, max: 65_535 });

const tokenAuthFlags = {
  token: {
    type: nonEmptyString,
    placeholder: "<token>",
    env: "UPTARN_ADMIN_TOKEN",
    group: "auth",
    description: "Admin Bearer token",
  },
  tokenFile: {
    type: nonEmptyString,
    placeholder: "<path>",
    env: "UPTARN_ADMIN_TOKEN_FILE",
    group: "auth",
    description: "Path to a file containing the admin Bearer token",
  },
} as const satisfies FlagsDefinition;

const jsonFlag = {
  json: {
    type: Boolean,
    description: "Output raw JSON",
  },
} as const satisfies FlagsDefinition;

const statusRangeRule: CustomRuleDescriptor<
  any,
  { statusMin?: number; statusMax?: number }
> = {
  description: "--status-max must be >= --status-min",
  check({ flags }) {
    if (
      flags.statusMin !== undefined &&
      flags.statusMax !== undefined &&
      flags.statusMax < flags.statusMin
    ) {
      return {
        message:
          "'--status-max' must be greater than or equal to '--status-min'",
        detail: `received status-min=${flags.statusMin}, status-max=${flags.statusMax}`,
        hints: [
          `try '--status-min ${flags.statusMax} --status-max ${flags.statusMin}'`,
        ],
      };
    }
  },
};

export function createCli() {
  const cli = clerc({
    name: "uptarn",
    description: manifest.description,
    version: manifest.version,
    examples: [
      ["$ uptarn status", "Show hub overview, nodes, monitors, and incidents"],
      [
        "$ uptarn sync uptarn.json --dry-run",
        "Preview declarative hub sync changes",
      ],
      [
        "$ uptarn monitor add Blog https://example.com --public-url https://example.com",
        "Create a hub-managed HTTP monitor",
      ],
      [
        "$ uptarn monitor edit blog --interval 120 --public on",
        "Update specific monitor fields",
      ],
      [
        "$ uptarn serve --port 8787 --db ./uptarn.db",
        "Run the portable SQLite hub server",
      ],
    ],
  })
    .groups({
      commands: {
        sync: "Declarative Sync",
        admin: "Administration",
        server: "Server",
      },
      flags: {
        auth: "Authentication",
        fields: "Monitor Fields",
      },
    })
    .use(completionsPlugin());

  // ── Declarative sync (server may come from --server, env, or hub_url in file) ──
  cli.command("sync <file>", {
    description: "Reconcile hub configuration from a declarative JSON file",
    group: "sync",
    args: {
      file: {
        description: "Path to declarative Uptarn JSON config",
        complete: () => ({ files: ["json"] }),
      },
    },
    flags: {
      server: {
        type: nonEmptyString,
        placeholder: "<url>",
        env: "UPTARN_SERVER",
        group: "auth",
        description: "Base URL of the Uptarn hub (overrides hub_url in config)",
      },
      ...tokenAuthFlags,
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
    rules: (r) => [r.oneOf(r.flag("token"), r.flag("tokenFile"))],
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
        ctx.log.raw(
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

      ctx.log.raw(
        renderBanner(
          theme,
          ctx.flags.dryRun ? "Uptarn Plan" : "Uptarn Sync",
          auth.server,
        ),
      );
      ctx.log.raw(renderSyncPlan(theme, plan, { dryRun: ctx.flags.dryRun }));

      if (ctx.flags.dryRun || !plan.hasChanges) {
        return;
      }

      await applySyncPlan(request, plan);
      ctx.log.success("Applied changes to hub.");
    },
  });

  // ── Shared admin scope: auth flags + oneOf rule + typed requester middleware ──
  const admin = cli
    .scope({ group: "admin" })
    .flags({
      server: {
        type: nonEmptyString,
        placeholder: "<url>",
        env: "UPTARN_SERVER",
        required: true,
        group: "auth",
        description: "Base URL of the Uptarn hub",
      },
      ...tokenAuthFlags,
    })
    .rules((r) => [r.oneOf(r.flag("token"), r.flag("tokenFile"))])
    .middleware((ctx, next) => {
      const request = createAdminRequester(resolveAuth(ctx.flags));

      return next({
        request,
        fetchSnapshot: () =>
          request<DashboardSnapshot>("GET", "/api/v1/admin/snapshot"),
      });
    });

  admin.command("status", {
    description: "Show hub overview, nodes, monitors, jobs, and incidents",
    flags: jsonFlag,
    async run(ctx) {
      const { theme } = ctx.log;
      const data = await ctx.state.fetchSnapshot();

      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(data, null, 2));

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

      ctx.log.raw(
        renderBanner(
          theme,
          "Uptarn Hub",
          `${data.public_base_url} (v${data.version})`,
        ),
      );
      ctx.log.raw(renderSection(theme, "Overview"));
      ctx.log.raw(
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
        ctx.log.raw(
          renderSection(
            theme,
            "Active Incidents",
            `(${data.incidents.length})`,
          ),
        );
        ctx.log.raw(renderIncidentsList(theme, data.incidents));
      }

      ctx.log.raw(renderSection(theme, "Nodes", `(${data.nodes.length})`));
      ctx.log.raw(
        data.nodes.length === 0
          ? `  ${theme.muted("No nodes registered.")}`
          : renderNodesTable(theme, data.nodes, now),
      );

      ctx.log.raw(
        renderSection(theme, "Monitors", `(${data.monitors.length})`),
      );
      ctx.log.raw(
        data.monitors.length === 0
          ? `  ${theme.muted("No monitors configured.")}`
          : renderMonitorsTable(theme, data.monitors),
      );

      if (data.jobs.length > 0) {
        ctx.log.raw(renderSection(theme, "Jobs", `(${data.jobs.length})`));
        ctx.log.raw(renderJobsTable(theme, data.jobs, now));
      }
    },
  });

  // ── node ──
  const node = admin.subcommand("node", {
    description: "Manage registered nodes",
  });

  node.command("ls", {
    default: true,
    description: "List all registered nodes",
    flags: jsonFlag,
    async run(ctx) {
      const { theme } = ctx.log;
      const data = await ctx.state.fetchSnapshot();
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(data.nodes, null, 2));

        return;
      }
      ctx.log.raw(
        data.nodes.length === 0
          ? `  ${theme.muted("No nodes registered.")}`
          : renderNodesTable(theme, data.nodes, data.now || unixNow()),
      );
    },
  });

  node.command("show <id>", {
    description: "Show detailed telemetry and configuration for a node",
    args: {
      id: { description: "Node identifier" },
    },
    flags: jsonFlag,
    async run(ctx) {
      const data = await ctx.state.fetchSnapshot();
      const item = data.nodes.find((n) => n.id === ctx.args.id);
      if (!item) {
        throw new Error(`Node "${ctx.args.id}" not found`);
      }
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(item, null, 2));

        return;
      }
      ctx.log.raw(renderNodeDetail(ctx.log.theme, item, data.now || unixNow()));
    },
  });

  node.command("add <id>", {
    description: "Register a new node and issue its ingest token",
    args: {
      id: { description: "Unique node identifier" },
    },
    flags: {
      label: { type: String, description: "Human-readable node label" },
      interval: {
        type: nodeIntervalSecs,
        description: "Expected report interval in seconds",
      },
      grace: {
        type: nodeGraceSecs,
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
      const res = await ctx.state.request<{
        id: string;
        label: string;
        token: string;
      }>("POST", "/api/v1/admin/nodes", {
        id: ctx.args.id,
        label: ctx.flags.label,
        interval_secs: ctx.flags.interval,
        grace_secs: ctx.flags.grace,
        is_public: ctx.flags.public,
      });
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(res, null, 2));

        return;
      }
      ctx.log
        .success(`Registered node ${theme.bold(res.id)} (${res.label})`)
        .line(`Token  ${theme.warn(res.token)}`);
    },
  });

  node.command("public <id> <state>", {
    description: "Set a node's public status page visibility (on/off)",
    args: {
      id: { description: "Node identifier" },
      state: {
        type: onOffType,
        description: "Visibility: on or off",
      },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const isPublic = ctx.args.state === "on";
      await ctx.state.request(
        "PATCH",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}`,
        { is_public: isPublic },
      );
      ctx.log.success(
        `Node ${theme.bold(ctx.args.id)} is now ${isPublic ? theme.accent("public") : theme.muted("private")}.`,
      );
    },
  });

  node.command("disk <id> <mount>", {
    description:
      "Set the disk summary source for a node ('sum' or a mount path)",
    args: {
      id: { description: "Node identifier" },
      mount: { description: "'sum' for all mounts, or a mount path like '/'" },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const primaryMount =
        ctx.args.mount === "sum" ? null : ctx.args.mount.trim();
      await ctx.state.request(
        "PATCH",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}`,
        { primary_mount: primaryMount },
      );
      ctx.log.success(
        primaryMount
          ? `Node ${theme.bold(ctx.args.id)} disk summary set to ${theme.accent(primaryMount)}.`
          : `Node ${theme.bold(ctx.args.id)} disk summary set to sum of all mounts.`,
      );
    },
  });

  node.command("order <ids...>", {
    description: "Set display order for nodes",
    args: {
      ids: {
        unique: true,
        minItems: 1,
        maxItems: 500,
        description: "Ordered list of node identifiers",
      },
    },
    async run(ctx) {
      await ctx.state.request("PUT", "/api/v1/admin/nodes/order", {
        ids: ctx.args.ids,
      });
      ctx.log.success(
        `Updated display order for ${ctx.args.ids.length} node(s).`,
      );
    },
  });

  node.command("rotate <id>", {
    description: "Rotate a node's ingest Bearer token",
    args: {
      id: { description: "Node identifier" },
    },
    flags: jsonFlag,
    async run(ctx) {
      const { theme } = ctx.log;
      const res = await ctx.state.request<{ id: string; token: string }>(
        "POST",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}/rotate-token`,
      );
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(res, null, 2));

        return;
      }
      ctx.log
        .success(`Rotated token for ${theme.bold(res.id)}`)
        .line(`Token  ${theme.warn(res.token)}`);
    },
  });

  node.command("rm <id>", {
    description: "Delete a registered node and its telemetry",
    args: {
      id: { description: "Node identifier" },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      await ctx.state.request(
        "DELETE",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}`,
      );
      ctx.log.success(`Removed node ${theme.bold(ctx.args.id)}.`);
    },
  });

  // ── monitor ──
  const monitor = admin.subcommand("monitor", {
    aliases: ["mon"],
    description: "Manage HTTP monitors",
  });

  monitor.command("ls", {
    default: true,
    description: "List all HTTP monitors",
    flags: jsonFlag,
    async run(ctx) {
      const { theme } = ctx.log;
      const data = await ctx.state.fetchSnapshot();
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(data.monitors, null, 2));

        return;
      }
      ctx.log.raw(
        data.monitors.length === 0
          ? `  ${theme.muted("No monitors configured.")}`
          : renderMonitorsTable(theme, data.monitors),
      );
    },
  });

  monitor.command("show <id>", {
    description: "Show status and configuration for an HTTP monitor",
    args: {
      id: { description: "Monitor identifier" },
    },
    flags: jsonFlag,
    async run(ctx) {
      const data = await ctx.state.fetchSnapshot();
      const item = data.monitors.find((m) => m.id === ctx.args.id);
      if (!item) {
        throw new Error(`Monitor "${ctx.args.id}" not found`);
      }
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(item, null, 2));

        return;
      }
      ctx.log.raw(
        renderMonitorDetail(ctx.log.theme, item, data.now || unixNow()),
      );
    },
  });

  monitor.command("add <name> <url>", {
    description: "Create a hub-managed HTTP monitor",
    args: {
      name: { description: "Display name for the monitor" },
      url: { description: "HTTP(S) URL to probe" },
    },
    flags: {
      id: {
        type: nonEmptyString,
        description: "Optional custom monitor identifier",
      },
      publicUrl: {
        type: nonEmptyString,
        placeholder: "<url>",
        description: "Optional clickable URL shown on the status page",
      },
      method: {
        type: monitorMethodType,
        default: "GET",
        description: "HTTP probe method (GET, HEAD, POST)",
      },
      statusMin: {
        type: httpStatusCode,
        description: "Minimum accepted HTTP status code (default: 200)",
      },
      statusMax: {
        type: httpStatusCode,
        description: "Maximum accepted HTTP status code (default: 299)",
      },
      body: {
        type: String,
        description: "Substring required in the response body",
      },
      interval: {
        type: monitorIntervalSecs,
        description: "Probe interval in seconds (default: 60)",
      },
      timeout: {
        type: monitorTimeoutMs,
        description: "Probe timeout in milliseconds (default: 8000)",
      },
      disabled: {
        type: Boolean,
        description: "Create the monitor in paused/disabled state",
      },
      private: {
        type: Boolean,
        description: "Hide the monitor from the public status page",
      },
      ...jsonFlag,
    },
    rules: [statusRangeRule],
    async run(ctx) {
      const { theme } = ctx.log;
      const payload: MonitorInput = {
        id: ctx.flags.id,
        name: ctx.args.name,
        url: ctx.args.url,
        public_url: ctx.flags.publicUrl,
        method: ctx.flags.method,
        expected_status_min: ctx.flags.statusMin,
        expected_status_max: ctx.flags.statusMax,
        expected_body: ctx.flags.body,
        interval_secs: ctx.flags.interval,
        timeout_ms: ctx.flags.timeout,
        enabled: !ctx.flags.disabled,
        is_public: !ctx.flags.private,
      };
      const res = await ctx.state.request<{ ok: boolean; id: string }>(
        "POST",
        "/api/v1/admin/monitors",
        payload,
      );
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(res, null, 2));

        return;
      }
      ctx.log.success(
        `Created monitor ${theme.bold(res.id)} (${ctx.args.name}).`,
      );
    },
  });

  monitor.command("edit <id>", {
    description: "Update an existing hub-managed HTTP monitor",
    args: {
      id: { description: "Monitor identifier" },
    },
    flags: {
      name: {
        type: nonEmptyString,
        group: "fields",
        description: "New display name",
      },
      url: {
        type: nonEmptyString,
        group: "fields",
        description: "New probe URL",
      },
      publicUrl: {
        type: String,
        placeholder: "<url>",
        group: "fields",
        description: "Public link URL (pass empty string to clear)",
      },
      method: {
        type: monitorMethodType,
        group: "fields",
        description: "HTTP probe method (GET, HEAD, POST)",
      },
      statusMin: {
        type: httpStatusCode,
        group: "fields",
        description: "Minimum accepted HTTP status code",
      },
      statusMax: {
        type: httpStatusCode,
        group: "fields",
        description: "Maximum accepted HTTP status code",
      },
      body: {
        type: String,
        group: "fields",
        description: "Required response body substring (empty to clear)",
      },
      interval: {
        type: monitorIntervalSecs,
        group: "fields",
        description: "Probe interval in seconds",
      },
      timeout: {
        type: monitorTimeoutMs,
        group: "fields",
        description: "Probe timeout in milliseconds",
      },
      enabled: {
        type: onOffType,
        group: "fields",
        description: "Enable or pause probing (on/off)",
      },
      public: {
        type: onOffType,
        group: "fields",
        description: "Public status page visibility (on/off)",
      },
      ...jsonFlag,
    },
    rules: [(r) => [r.atLeastOne(r.group("fields"))], statusRangeRule],
    async run(ctx) {
      const { theme } = ctx.log;
      const snapshot = await ctx.state.fetchSnapshot();
      const existing = snapshot.monitors.find((m) => m.id === ctx.args.id);
      if (!existing) {
        throw new Error(`Monitor "${ctx.args.id}" not found`);
      }

      const payload: MonitorInput = {
        id: existing.id,
        name: ctx.flags.name ?? existing.name,
        url: ctx.flags.url ?? existing.url,
        public_url:
          ctx.flags.publicUrl === undefined
            ? existing.public_url
            : ctx.flags.publicUrl.trim() || null,
        method: ctx.flags.method ?? existing.method,
        expected_status_min:
          ctx.flags.statusMin ?? existing.expected_status_min,
        expected_status_max:
          ctx.flags.statusMax ?? existing.expected_status_max,
        expected_body:
          ctx.flags.body === undefined
            ? existing.expected_body
            : ctx.flags.body.trim() || null,
        interval_secs: ctx.flags.interval ?? existing.interval_secs,
        timeout_ms: ctx.flags.timeout ?? existing.timeout_ms,
        enabled:
          ctx.flags.enabled === undefined
            ? existing.enabled
            : ctx.flags.enabled === "on",
        is_public:
          ctx.flags.public === undefined
            ? existing.is_public
            : ctx.flags.public === "on",
      };
      const res = await ctx.state.request<{ ok: boolean; id: string }>(
        "POST",
        "/api/v1/admin/monitors",
        payload,
      );
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(res, null, 2));

        return;
      }
      ctx.log.success(`Updated monitor ${theme.bold(res.id)}.`);
    },
  });

  monitor.command("order <ids...>", {
    description: "Set display order for HTTP monitors",
    args: {
      ids: {
        unique: true,
        minItems: 1,
        maxItems: 500,
        description: "Ordered list of monitor identifiers",
      },
    },
    async run(ctx) {
      await ctx.state.request("PUT", "/api/v1/admin/monitors/order", {
        ids: ctx.args.ids,
      });
      ctx.log.success(
        `Updated display order for ${ctx.args.ids.length} monitor(s).`,
      );
    },
  });

  monitor.command("rm <id>", {
    description: "Delete a hub-managed HTTP monitor",
    args: {
      id: { description: "Monitor identifier" },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      await ctx.state.request(
        "DELETE",
        `/api/v1/admin/monitors/${encodeURIComponent(ctx.args.id)}`,
      );
      ctx.log.success(`Removed monitor ${theme.bold(ctx.args.id)}.`);
    },
  });

  // ── job ──
  const job = admin.subcommand("job", {
    description: "Manage scheduled jobs",
  });

  job.command("ls", {
    default: true,
    description: "List all reported jobs",
    flags: jsonFlag,
    async run(ctx) {
      const { theme } = ctx.log;
      const data = await ctx.state.fetchSnapshot();
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(data.jobs, null, 2));

        return;
      }
      ctx.log.raw(
        data.jobs.length === 0
          ? `  ${theme.muted("No jobs reported.")}`
          : renderJobsTable(theme, data.jobs, data.now || unixNow()),
      );
    },
  });

  job.command("show <key>", {
    description: "Show status and last run details for a job",
    args: {
      key: { description: "Job key" },
    },
    flags: jsonFlag,
    async run(ctx) {
      const data = await ctx.state.fetchSnapshot();
      const item = data.jobs.find((j) => j.key === ctx.args.key);
      if (!item) {
        throw new Error(`Job "${ctx.args.key}" not found`);
      }
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(item, null, 2));

        return;
      }
      ctx.log.raw(renderJobDetail(ctx.log.theme, item, data.now || unixNow()));
    },
  });

  job.command("rm <key>", {
    description: "Delete a job and its incident state",
    args: {
      key: { description: "Job key" },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      await ctx.state.request(
        "DELETE",
        `/api/v1/admin/jobs/${encodeURIComponent(ctx.args.key)}`,
      );
      ctx.log.success(`Removed job ${theme.bold(ctx.args.key)}.`);
    },
  });

  // ── incident ──
  const incident = admin.subcommand("incident", {
    aliases: ["inc"],
    description: "Inspect active incidents and incident history",
  });

  incident.command("ls", {
    default: true,
    description: "List active incidents and recent history events",
    flags: {
      limit: {
        type: nonNegativeInt,
        default: 20,
        description: "Maximum number of recent incident events to display",
      },
      ...jsonFlag,
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const data = await ctx.state.fetchSnapshot();
      const events = data.events.slice(0, ctx.flags.limit);
      if (ctx.flags.json) {
        ctx.log.raw(
          JSON.stringify({ incidents: data.incidents, events }, null, 2),
        );

        return;
      }
      const now = data.now || unixNow();
      ctx.log.raw(
        renderSection(theme, "Active Incidents", `(${data.incidents.length})`),
      );
      ctx.log.raw(
        data.incidents.length === 0
          ? `  ${theme.success("No active incidents.")}`
          : renderIncidentsList(theme, data.incidents),
      );
      ctx.log.raw(renderSection(theme, "History", `(${events.length})`));
      ctx.log.raw(
        events.length === 0
          ? `  ${theme.muted("No incident history recorded.")}`
          : renderIncidentEventsTable(theme, events, now),
      );
    },
  });

  // ── mute / unmute ──
  admin.command("mute <targetType> <targetId>", {
    description: "Mute or unmute notifications for a node, monitor, or job",
    args: {
      targetType: {
        type: targetTypeArg,
        description: "node, monitor, or job",
      },
      targetId: { description: "Target identifier" },
    },
    flags: {
      duration: {
        type: nonNegativeInt,
        short: "d",
        default: 3600,
        description: "Mute duration in seconds (0 unmutes)",
      },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const res = await ctx.state.request<{ muted_until: number }>(
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
  });

  admin.command("unmute <targetType> <targetId>", {
    description: "Unmute notifications for a node, monitor, or job",
    args: {
      targetType: {
        type: targetTypeArg,
        description: "node, monitor, or job",
      },
      targetId: { description: "Target identifier" },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      await ctx.state.request("POST", "/api/v1/admin/mute", {
        target_type: ctx.args.targetType,
        target_id: ctx.args.targetId,
        duration_secs: 0,
      });
      ctx.log.success(
        `Unmuted ${ctx.args.targetType} ${theme.bold(ctx.args.targetId)}.`,
      );
    },
  });

  // ── settings ──
  const settings = admin.subcommand("settings", {
    description: "Inspect and update hub runtime settings",
  });

  settings.command("show", {
    default: true,
    description: "Show current hub runtime settings",
    flags: jsonFlag,
    async run(ctx) {
      const data = await ctx.state.fetchSnapshot();
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(data.settings, null, 2));

        return;
      }
      ctx.log.raw(renderBanner(ctx.log.theme, "Hub Settings"));
      ctx.log.raw(
        renderSettingsDetail(
          ctx.log.theme,
          data.settings,
          data.now || unixNow(),
        ),
      );
    },
  });

  settings.command("auto-register <state>", {
    description: "Enable or disable agent auto-registration (on/off)",
    args: {
      state: {
        type: onOffType,
        description: "Auto-registration state: on or off",
      },
    },
    flags: jsonFlag,
    async run(ctx) {
      const { theme } = ctx.log;
      const res = await ctx.state.request<{
        auto_register: boolean;
        enrollment_token: string | null;
        global_muted_until: number;
      }>("PATCH", "/api/v1/admin/settings", {
        auto_register: ctx.args.state === "on",
      });
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(res, null, 2));

        return;
      }
      const msg = `Auto-registration is now ${res.auto_register ? theme.warn("enabled") : theme.muted("disabled")}.`;
      if (res.auto_register && res.enrollment_token) {
        ctx.log
          .success(msg)
          .line(`Enrollment token  ${theme.warn(res.enrollment_token)}`);
      } else {
        ctx.log.success(msg);
      }
    },
  });

  settings.command("rotate-enroll", {
    description: "Rotate the agent auto-registration enrollment token",
    flags: jsonFlag,
    async run(ctx) {
      const { theme } = ctx.log;
      const res = await ctx.state.request<{
        auto_register: boolean;
        enrollment_token: string | null;
        global_muted_until: number;
      }>("PATCH", "/api/v1/admin/settings", {
        rotate_enrollment_token: true,
      });
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(res, null, 2));

        return;
      }
      ctx.log
        .success("Rotated enrollment token.")
        .line(`Enrollment token  ${theme.warn(res.enrollment_token ?? "-")}`);
    },
  });

  settings.command("mute", {
    description: "Mute or unmute all notifications globally",
    flags: {
      duration: {
        type: nonNegativeInt,
        short: "d",
        default: 3600,
        description: "Global mute duration in seconds (0 unmutes)",
      },
      ...jsonFlag,
    },
    async run(ctx) {
      const res = await ctx.state.request<{
        auto_register: boolean;
        enrollment_token: string | null;
        global_muted_until: number;
      }>("PATCH", "/api/v1/admin/settings", {
        global_mute_secs: ctx.flags.duration,
      });
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(res, null, 2));

        return;
      }
      if (res.global_muted_until === 0) {
        ctx.log.success("Unmuted global notifications.");
      } else {
        ctx.log.success(
          `Muted all notifications globally for ${ctx.flags.duration}s.`,
        );
      }
    },
  });

  // ── passkey ──
  const passkey = admin.subcommand("passkey", {
    description: "Manage registered admin passkeys",
  });

  passkey.command("ls", {
    default: true,
    description: "List registered WebAuthn passkeys",
    flags: jsonFlag,
    async run(ctx) {
      const { theme } = ctx.log;
      const data = await ctx.state.fetchSnapshot();
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(data.passkeys, null, 2));

        return;
      }
      ctx.log.raw(
        data.passkeys.length === 0
          ? `  ${theme.muted("No passkeys registered.")}`
          : renderPasskeysTable(theme, data.passkeys, data.now || unixNow()),
      );
    },
  });

  passkey.command("rm <id>", {
    description: "Delete a registered WebAuthn passkey",
    args: {
      id: { description: "Passkey identifier" },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      await ctx.state.request(
        "DELETE",
        `/api/v1/admin/passkeys/${encodeURIComponent(ctx.args.id)}`,
      );
      ctx.log.success(`Removed passkey ${theme.bold(ctx.args.id)}.`);
    },
  });

  // ── tick & notify ──
  admin.command("tick", {
    description: "Trigger an immediate hub tick and force-probe monitors",
    flags: jsonFlag,
    async run(ctx) {
      const res = await ctx.state.request<TickReport>(
        "POST",
        "/api/v1/admin/tick",
      );
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(res, null, 2));

        return;
      }
      ctx.log.success(
        `Tick completed: ${res.probed_monitors} monitors probed, ${res.evaluated_nodes} nodes evaluated, ${res.evaluated_jobs} jobs evaluated.`,
      );
    },
  });

  const notify = admin.subcommand("notify", {
    description: "Manage notification channels",
  });

  notify.command("test", {
    description: "Send a test notification to configured IM channels",
    flags: jsonFlag,
    async run(ctx) {
      const res = await ctx.state.request<{ delivery: Record<string, string> }>(
        "POST",
        "/api/v1/admin/notifications/test",
      );
      if (ctx.flags.json) {
        ctx.log.raw(JSON.stringify(res, null, 2));

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
  });

  // ── Server scope (shares --db) ──
  const server = cli.scope({ group: "server" }).flags({
    db: {
      type: nonEmptyString,
      placeholder: "<path>",
      env: "UPTARN_DB_PATH",
      default: "./uptarn.db",
      description: "Local SQLite database path",
    },
  });

  server.command("serve", {
    description: "Run the portable Node.js + SQLite Uptarn hub server",
    flags: {
      host: {
        type: nonEmptyString,
        env: "HOST",
        default: "127.0.0.1",
        description: "Bind address",
      },
      port: {
        type: tcpPort,
        env: "PORT",
        default: 8787,
        description: "Bind port",
      },
      tickInterval: {
        type: nonNegativeInt,
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
        ctx.log.raw(
          JSON.stringify({ message: "shutting down uptarn hub", signal }),
        );
        void running.close().finally(() => process.exit(0));
      }
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    },
  });

  server.command("migrate", {
    description: "Apply SQL migrations to a local SQLite database",
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

  return cli;
}
