import fs from "node:fs";
import process from "node:process";

import { completionsPlugin } from "@clerc/plugin-completions";
import type { ClercSchema, FlagsDefinition, RuleBuilder } from "clerc";
import { MissingRequiredFlagError, RuleError, Types, clerc } from "clerc";

import manifest from "../../package.json" with { type: "json" };
import type { TickReport } from "../domain/tick.ts";
import { runDatabaseMigrations, startNodeServer } from "../node.ts";
import type { DashboardSnapshot, MonitorInput } from "../shared/index.ts";
import {
  renderAlertEventsTable,
  renderBanner,
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

function intRange(min: number, max?: number): ClercSchema<number> {
  const display = max === undefined ? `>=${min}` : `${min}..${max}`;

  return {
    display,
    "~standard": {
      version: 1,
      vendor: "uptarn",
      validate(raw) {
        const value = Number(raw);
        if (!Number.isInteger(value)) {
          return { issues: [{ message: "expected an integer" }] };
        }
        if (value < min || (max !== undefined && value > max)) {
          return {
            issues: [
              {
                message:
                  max === undefined
                    ? `expected an integer >= ${min}`
                    : `expected an integer between ${min} and ${max}`,
              },
            ],
          };
        }

        return { value };
      },
    },
  };
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
    flags.token?.trim() ||
    (flags.tokenFile ? fs.readFileSync(flags.tokenFile, "utf8").trim() : "");
  if (!token) {
    throw new RuleError(
      flags.tokenFile
        ? `token file '${flags.tokenFile}' is empty`
        : "admin token must not be empty",
    ).addHint(
      "provide a non-empty '--token' / '--token-file' or set UPTARN_ADMIN_TOKEN / UPTARN_ADMIN_TOKEN_FILE",
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

const fetchSnapshot = (flags: {
  server?: string;
  token?: string;
  tokenFile?: string;
}): Promise<DashboardSnapshot> =>
  createAdminRequester(resolveAuth(flags))<DashboardSnapshot>(
    "GET",
    "/api/v1/admin/snapshot",
  );

const adminAuthFlags = {
  server: {
    type: String,
    placeholder: "<url>",
    env: "UPTARN_SERVER",
    required: true,
    description: "Base URL of the Uptarn hub",
  },
  token: {
    type: String,
    placeholder: "<token>",
    env: "UPTARN_ADMIN_TOKEN",
    description: "Admin Bearer token",
  },
  tokenFile: {
    type: String,
    placeholder: "<path>",
    env: "UPTARN_ADMIN_TOKEN_FILE",
    description: "Path to a file containing the admin Bearer token",
  },
} as const satisfies FlagsDefinition;

const optionalServerAuthFlags = {
  server: {
    type: String,
    placeholder: "<url>",
    env: "UPTARN_SERVER",
    description: "Base URL of the Uptarn hub (overrides hub_url in config)",
  },
  token: adminAuthFlags.token,
  tokenFile: adminAuthFlags.tokenFile,
} as const satisfies FlagsDefinition;

const adminAuthRules = (
  r: Pick<RuleBuilder<"token" | "tokenFile">, "flag" | "oneOf">,
) => [r.oneOf(r.flag("token"), r.flag("tokenFile"))];

function statusRangeRule({
  flags,
}: {
  flags: { statusMin?: number; statusMax?: number };
}): string | undefined {
  if (
    flags.statusMin !== undefined &&
    flags.statusMax !== undefined &&
    flags.statusMax < flags.statusMin
  ) {
    return "'--status-max' must be greater than or equal to '--status-min'";
  }
}

function uniqueIdsRule({
  args,
}: {
  args: { ids: string[] };
}): string | undefined {
  const seen = new Set<string>();
  for (const id of args.ids) {
    if (seen.has(id)) {
      return `duplicate identifier '${id}'`;
    }
    seen.add(id);
  }
}

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

const monitorMethodType = Types.Enum("GET", "HEAD", "POST");
const onOffType = Types.Enum("on", "off");
const targetTypeArg = Types.Enum("node", "monitor", "job");
const nonNegativeInt = intRange(0);
const httpStatusCode = intRange(100, 599);
const nodeIntervalSecs = intRange(10, 86_400);
const nodeGraceSecs = intRange(10, 604_800);
const monitorIntervalSecs = intRange(30, 86_400);
const monitorTimeoutMs = intRange(500, 30_000);
const tcpPort = intRange(1, 65_535);

export const createCli = () =>
  clerc({
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
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const raw = JSON.parse(
          fs.readFileSync(ctx.args.file, "utf8"),
        ) as unknown;
        const spec = parseSyncSpec(raw);
        const auth = resolveAuth(ctx.flags, spec.hub_url);
        const request = createAdminRequester(auth);
        const snapshot = await request<DashboardSnapshot>(
          "GET",
          "/api/v1/admin/snapshot",
        );
        const plan = computeSyncPlan(snapshot, spec, {
          prune: ctx.flags.prune,
        });

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
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const data = await fetchSnapshot(ctx.flags);

        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(data, null, 2));

          return;
        }

        const now = data.now || unixNow();
        const onlineNodes = data.nodes.filter(
          (n) =>
            n.overall_status !== "offline" && n.overall_status !== "pending",
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
          ctx.terminal.stdout(renderIncidentsList(theme, data.incidents));
        }

        ctx.terminal.stdout(
          renderSection(theme, "Nodes", `(${data.nodes.length})`),
        );
        ctx.terminal.stdout(
          data.nodes.length === 0
            ? `  ${theme.muted("No nodes registered.")}`
            : renderNodesTable(theme, data.nodes, now),
        );

        ctx.terminal.stdout(
          renderSection(theme, "Monitors", `(${data.monitors.length})`),
        );
        ctx.terminal.stdout(
          data.monitors.length === 0
            ? `  ${theme.muted("No monitors configured.")}`
            : renderMonitorsTable(theme, data.monitors),
        );

        if (data.jobs.length > 0) {
          ctx.terminal.stdout(
            renderSection(theme, "Jobs", `(${data.jobs.length})`),
          );
          ctx.terminal.stdout(renderJobsTable(theme, data.jobs, now));
        }
      },
    })
    .command("node", {
      description: "Manage registered nodes",
      group: "admin",
    })
    .command("node ls", {
      description: "List all registered nodes",
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const data = await fetchSnapshot(ctx.flags);
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(data.nodes, null, 2));

          return;
        }
        if (data.nodes.length === 0) {
          ctx.terminal.stdout(`  ${theme.muted("No nodes registered.")}`);

          return;
        }
        ctx.terminal.stdout(
          renderNodesTable(theme, data.nodes, data.now || unixNow()),
        );
      },
    })
    .command("node show <id>", {
      description: "Show detailed telemetry and configuration for a node",
      args: {
        id: { description: "Node identifier" },
      },
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const data = await fetchSnapshot(ctx.flags);
        const node = data.nodes.find((n) => n.id === ctx.args.id);
        if (!node) {
          throw new Error(`Node "${ctx.args.id}" not found`);
        }
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(node, null, 2));

          return;
        }
        ctx.terminal.stdout(
          renderNodeDetail(ctx.log.theme, node, data.now || unixNow()),
        );
      },
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
      rules: adminAuthRules,
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
          type: onOffType,
          description: "Visibility: on or off",
        },
      },
      flags: adminAuthFlags,
      rules: adminAuthRules,
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
    .command("node disk <id> <mount>", {
      description:
        "Set the disk summary source for a node ('sum' or a mount path)",
      args: {
        id: { description: "Node identifier" },
        mount: {
          description: "'sum' for all mounts, or a mount path like '/'",
        },
      },
      flags: adminAuthFlags,
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const primaryMount =
          ctx.args.mount === "sum" ? null : ctx.args.mount.trim();
        const request = createAdminRequester(resolveAuth(ctx.flags));
        await request(
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
    })
    .command("node order <ids...>", {
      description: "Set display order for nodes",
      args: {
        ids: { description: "Ordered list of node identifiers" },
      },
      flags: adminAuthFlags,
      rules: (r) => [...adminAuthRules(r), uniqueIdsRule],
      async run(ctx) {
        const request = createAdminRequester(resolveAuth(ctx.flags));
        await request("PUT", "/api/v1/admin/nodes/order", {
          ids: ctx.args.ids,
        });
        ctx.log.success(
          `Updated display order for ${ctx.args.ids.length} node(s).`,
        );
      },
    })
    .command("node rotate <id>", {
      description: "Rotate a node's ingest Bearer token",
      args: {
        id: { description: "Node identifier" },
      },
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
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
      rules: adminAuthRules,
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
    .command("monitor ls", {
      description: "List all HTTP monitors",
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const data = await fetchSnapshot(ctx.flags);
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(data.monitors, null, 2));

          return;
        }
        if (data.monitors.length === 0) {
          ctx.terminal.stdout(`  ${theme.muted("No monitors configured.")}`);

          return;
        }
        ctx.terminal.stdout(renderMonitorsTable(theme, data.monitors));
      },
    })
    .command("monitor show <id>", {
      description: "Show status and configuration for an HTTP monitor",
      args: {
        id: { description: "Monitor identifier" },
      },
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const data = await fetchSnapshot(ctx.flags);
        const monitor = data.monitors.find((m) => m.id === ctx.args.id);
        if (!monitor) {
          throw new Error(`Monitor "${ctx.args.id}" not found`);
        }
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(monitor, null, 2));

          return;
        }
        ctx.terminal.stdout(
          renderMonitorDetail(ctx.log.theme, monitor, data.now || unixNow()),
        );
      },
    })
    .command("monitor add <name> <url>", {
      description: "Create a hub-managed HTTP monitor",
      args: {
        name: { description: "Display name for the monitor" },
        url: { description: "HTTP(S) URL to probe" },
      },
      flags: {
        ...adminAuthFlags,
        id: {
          type: String,
          description: "Optional custom monitor identifier",
        },
        publicUrl: {
          type: String,
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
      rules: (r) => [...adminAuthRules(r), statusRangeRule],
      async run(ctx) {
        const { theme } = ctx.log;
        const request = createAdminRequester(resolveAuth(ctx.flags));
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
        const res = await request<{ ok: boolean; id: string }>(
          "POST",
          "/api/v1/admin/monitors",
          payload,
        );
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(res, null, 2));

          return;
        }
        ctx.log.success(
          `Created monitor ${theme.bold(res.id)} (${ctx.args.name}).`,
        );
      },
    })
    .command("monitor edit <id>", {
      description: "Update an existing hub-managed HTTP monitor",
      args: {
        id: { description: "Monitor identifier" },
      },
      flags: {
        ...adminAuthFlags,
        name: { type: String, description: "New display name" },
        url: { type: String, description: "New probe URL" },
        publicUrl: {
          type: String,
          placeholder: "<url>",
          description: "Public link URL (pass empty string to clear)",
        },
        method: {
          type: monitorMethodType,
          description: "HTTP probe method (GET, HEAD, POST)",
        },
        statusMin: {
          type: httpStatusCode,
          description: "Minimum accepted HTTP status code",
        },
        statusMax: {
          type: httpStatusCode,
          description: "Maximum accepted HTTP status code",
        },
        body: {
          type: String,
          description: "Required response body substring (empty to clear)",
        },
        interval: {
          type: monitorIntervalSecs,
          description: "Probe interval in seconds",
        },
        timeout: {
          type: monitorTimeoutMs,
          description: "Probe timeout in milliseconds",
        },
        enabled: {
          type: onOffType,
          description: "Enable or pause probing (on/off)",
        },
        public: {
          type: onOffType,
          description: "Public status page visibility (on/off)",
        },
        ...jsonFlag,
      },
      rules: (r) => [
        ...adminAuthRules(r),
        r.atLeastOne(
          r.flag("name"),
          r.flag("url"),
          r.flag("publicUrl"),
          r.flag("method"),
          r.flag("statusMin"),
          r.flag("statusMax"),
          r.flag("body"),
          r.flag("interval"),
          r.flag("timeout"),
          r.flag("enabled"),
          r.flag("public"),
        ),
        statusRangeRule,
      ],
      async run(ctx) {
        const { theme } = ctx.log;
        const request = createAdminRequester(resolveAuth(ctx.flags));
        const snapshot = await request<DashboardSnapshot>(
          "GET",
          "/api/v1/admin/snapshot",
        );
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
        const res = await request<{ ok: boolean; id: string }>(
          "POST",
          "/api/v1/admin/monitors",
          payload,
        );
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(res, null, 2));

          return;
        }
        ctx.log.success(`Updated monitor ${theme.bold(res.id)}.`);
      },
    })
    .command("monitor order <ids...>", {
      description: "Set display order for HTTP monitors",
      args: {
        ids: { description: "Ordered list of monitor identifiers" },
      },
      flags: adminAuthFlags,
      rules: (r) => [...adminAuthRules(r), uniqueIdsRule],
      async run(ctx) {
        const request = createAdminRequester(resolveAuth(ctx.flags));
        await request("PUT", "/api/v1/admin/monitors/order", {
          ids: ctx.args.ids,
        });
        ctx.log.success(
          `Updated display order for ${ctx.args.ids.length} monitor(s).`,
        );
      },
    })
    .command("monitor rm <id>", {
      description: "Delete a hub-managed HTTP monitor",
      args: {
        id: { description: "Monitor identifier" },
      },
      flags: adminAuthFlags,
      rules: adminAuthRules,
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
    .command("job", {
      description: "Manage scheduled jobs",
      group: "admin",
    })
    .command("job ls", {
      description: "List all reported jobs",
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const data = await fetchSnapshot(ctx.flags);
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(data.jobs, null, 2));

          return;
        }
        if (data.jobs.length === 0) {
          ctx.terminal.stdout(`  ${theme.muted("No jobs reported.")}`);

          return;
        }
        ctx.terminal.stdout(
          renderJobsTable(theme, data.jobs, data.now || unixNow()),
        );
      },
    })
    .command("job show <key>", {
      description: "Show status and last run details for a job",
      args: {
        key: { description: "Job key" },
      },
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const data = await fetchSnapshot(ctx.flags);
        const job = data.jobs.find((j) => j.key === ctx.args.key);
        if (!job) {
          throw new Error(`Job "${ctx.args.key}" not found`);
        }
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(job, null, 2));

          return;
        }
        ctx.terminal.stdout(
          renderJobDetail(ctx.log.theme, job, data.now || unixNow()),
        );
      },
    })
    .command("job rm <key>", {
      description: "Delete a job and its alert state",
      args: {
        key: { description: "Job key" },
      },
      flags: adminAuthFlags,
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const request = createAdminRequester(resolveAuth(ctx.flags));
        await request(
          "DELETE",
          `/api/v1/admin/jobs/${encodeURIComponent(ctx.args.key)}`,
        );
        ctx.log.success(`Removed job ${theme.bold(ctx.args.key)}.`);
      },
    })
    .command("alert", {
      description: "Inspect active incidents and alert history",
      group: "admin",
    })
    .command("alert ls", {
      description: "List active incidents and recent alert events",
      flags: {
        ...adminAuthFlags,
        limit: {
          type: nonNegativeInt,
          default: 20,
          description: "Maximum number of recent alert events to display",
        },
        ...jsonFlag,
      },
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const data = await fetchSnapshot(ctx.flags);
        const events = data.events.slice(0, ctx.flags.limit);
        if (ctx.flags.json) {
          ctx.terminal.stdout(
            JSON.stringify({ incidents: data.incidents, events }, null, 2),
          );

          return;
        }
        const now = data.now || unixNow();
        ctx.terminal.stdout(
          renderSection(
            theme,
            "Active Incidents",
            `(${data.incidents.length})`,
          ),
        );
        ctx.terminal.stdout(
          data.incidents.length === 0
            ? `  ${theme.success("No active incidents.")}`
            : renderIncidentsList(theme, data.incidents),
        );
        ctx.terminal.stdout(
          renderSection(theme, "Recent Events", `(${events.length})`),
        );
        ctx.terminal.stdout(
          events.length === 0
            ? `  ${theme.muted("No alert events recorded.")}`
            : renderAlertEventsTable(theme, events, now),
        );
      },
    })
    .command("mute <targetType> <targetId>", {
      description: "Mute or unmute alerts for a node, monitor, or job",
      group: "admin",
      args: {
        targetType: {
          type: targetTypeArg,
          description: "node, monitor, or job",
        },
        targetId: { description: "Target identifier" },
      },
      flags: {
        ...adminAuthFlags,
        duration: {
          type: nonNegativeInt,
          short: "d",
          default: 3600,
          description: "Mute duration in seconds (0 unmutes)",
        },
      },
      rules: adminAuthRules,
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
    .command("unmute <targetType> <targetId>", {
      description: "Unmute alerts for a node, monitor, or job",
      group: "admin",
      args: {
        targetType: {
          type: targetTypeArg,
          description: "node, monitor, or job",
        },
        targetId: { description: "Target identifier" },
      },
      flags: adminAuthFlags,
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const request = createAdminRequester(resolveAuth(ctx.flags));
        await request("POST", "/api/v1/admin/mute", {
          target_type: ctx.args.targetType,
          target_id: ctx.args.targetId,
          duration_secs: 0,
        });
        ctx.log.success(
          `Unmuted ${ctx.args.targetType} ${theme.bold(ctx.args.targetId)}.`,
        );
      },
    })
    .command("settings", {
      description: "Inspect and update hub runtime settings",
      group: "admin",
    })
    .command("settings show", {
      description: "Show current hub runtime settings",
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const data = await fetchSnapshot(ctx.flags);
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(data.settings, null, 2));

          return;
        }
        ctx.terminal.stdout(renderBanner(ctx.log.theme, "Hub Settings"));
        ctx.terminal.stdout(
          renderSettingsDetail(
            ctx.log.theme,
            data.settings,
            data.now || unixNow(),
          ),
        );
      },
    })
    .command("settings auto-register <state>", {
      description: "Enable or disable agent auto-registration (on/off)",
      args: {
        state: {
          type: onOffType,
          description: "Auto-registration state: on or off",
        },
      },
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const enabled = ctx.args.state === "on";
        const request = createAdminRequester(resolveAuth(ctx.flags));
        const res = await request<{
          auto_register: boolean;
          enrollment_token: string | null;
          global_muted_until: number;
        }>("PATCH", "/api/v1/admin/settings", { auto_register: enabled });
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(res, null, 2));

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
    })
    .command("settings rotate-enroll", {
      description: "Rotate the agent auto-registration enrollment token",
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const request = createAdminRequester(resolveAuth(ctx.flags));
        const res = await request<{
          auto_register: boolean;
          enrollment_token: string | null;
          global_muted_until: number;
        }>("PATCH", "/api/v1/admin/settings", {
          rotate_enrollment_token: true,
        });
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(res, null, 2));

          return;
        }
        ctx.log
          .success("Rotated enrollment token.")
          .line(`Enrollment token  ${theme.warn(res.enrollment_token ?? "-")}`);
      },
    })
    .command("settings mute", {
      description: "Mute or unmute all alerts globally",
      flags: {
        ...adminAuthFlags,
        duration: {
          type: nonNegativeInt,
          short: "d",
          default: 3600,
          description: "Global mute duration in seconds (0 unmutes)",
        },
        ...jsonFlag,
      },
      rules: adminAuthRules,
      async run(ctx) {
        const request = createAdminRequester(resolveAuth(ctx.flags));
        const res = await request<{
          auto_register: boolean;
          enrollment_token: string | null;
          global_muted_until: number;
        }>("PATCH", "/api/v1/admin/settings", {
          global_mute_secs: ctx.flags.duration,
        });
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(res, null, 2));

          return;
        }
        if (res.global_muted_until === 0) {
          ctx.log.success("Unmuted global alerts.");
        } else {
          ctx.log.success(
            `Muted all alerts globally for ${ctx.flags.duration}s.`,
          );
        }
      },
    })
    .command("passkey", {
      description: "Manage registered admin passkeys",
      group: "admin",
    })
    .command("passkey ls", {
      description: "List registered WebAuthn passkeys",
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const data = await fetchSnapshot(ctx.flags);
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(data.passkeys, null, 2));

          return;
        }
        if (data.passkeys.length === 0) {
          ctx.terminal.stdout(`  ${theme.muted("No passkeys registered.")}`);

          return;
        }
        ctx.terminal.stdout(
          renderPasskeysTable(theme, data.passkeys, data.now || unixNow()),
        );
      },
    })
    .command("passkey rm <id>", {
      description: "Delete a registered WebAuthn passkey",
      args: {
        id: { description: "Passkey identifier" },
      },
      flags: adminAuthFlags,
      rules: adminAuthRules,
      async run(ctx) {
        const { theme } = ctx.log;
        const request = createAdminRequester(resolveAuth(ctx.flags));
        await request(
          "DELETE",
          `/api/v1/admin/passkeys/${encodeURIComponent(ctx.args.id)}`,
        );
        ctx.log.success(`Removed passkey ${theme.bold(ctx.args.id)}.`);
      },
    })
    .command("tick", {
      description: "Trigger an immediate hub tick and force-probe monitors",
      group: "admin",
      flags: { ...adminAuthFlags, ...jsonFlag },
      rules: adminAuthRules,
      async run(ctx) {
        const request = createAdminRequester(resolveAuth(ctx.flags));
        const res = await request<TickReport>("POST", "/api/v1/admin/tick");
        if (ctx.flags.json) {
          ctx.terminal.stdout(JSON.stringify(res, null, 2));

          return;
        }
        ctx.log.success(
          `Tick completed: ${res.probed_monitors} monitors probed, ${res.evaluated_nodes} nodes evaluated, ${res.evaluated_jobs} jobs evaluated.`,
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
      rules: adminAuthRules,
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
          type: tcpPort,
          env: "PORT",
          default: 8787,
          description: "Bind port",
        },
        ...dbFlags,
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
