import fs from "node:fs";
import process from "node:process";

import { completionsPlugin } from "@clerc/plugin-completions";
import type {
  CustomRuleDescriptor,
  FlagsDefinition,
  Scope,
  Theme,
} from "clerc";
import { MissingRequiredFlagError, RuleError, Types, clerc } from "clerc";

import manifest from "../../package.json" with { type: "json" };
import type { TickReport } from "../domain/tick.ts";
import { runDatabaseMigrations, startNodeServer } from "../node.ts";
import type {
  DashboardSnapshot,
  MonitorInput,
  TargetType,
} from "../shared/index.ts";
import { unixNow } from "../shared/index.ts";
import {
  renderBanner,
  renderIncidentEventsTable,
  renderIncidentsList,
  renderJobDetail,
  renderJobsTable,
  renderMonitorDetail,
  renderMonitorsTable,
  renderNodeDetail,
  renderNodesTable,
  renderPasskeysTable,
  renderSection,
  renderSettingsDetail,
  renderStatusOverview,
} from "./format.ts";
import type { AdminRequestFn } from "./sync.ts";
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

interface AdminState {
  request: AdminRequestFn;
  fetchSnapshot: () => Promise<DashboardSnapshot>;
}

interface SettingsPatchResponse {
  auto_register: boolean;
  enrollment_token: string | null;
  global_muted_until: number;
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

const createAdminRequester = (auth: ResolvedAuth): AdminRequestFn =>
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

function emitJsonOr(
  ctx: { flags: { json?: boolean }; log: { raw: (s: string) => unknown } },
  data: unknown,
  onHuman: () => void,
): void {
  if (ctx.flags.json) {
    ctx.log.raw(JSON.stringify(data, null, 2));

    return;
  }
  onHuman();
}

const nonEmptyString = Types.String({ trim: true, nonEmpty: true });
const monitorMethodType = Types.Enum("GET", "HEAD", "POST");
const onOffType = Types.Enum("on", "off");
const targetTypeArg = Types.Enum("node", "monitor", "job");
const nonNegativeInt = Types.Integer({ min: 0 });
const httpStatusCode = Types.Integer({ min: 100, max: 599 });
const monitorIntervalSecs = Types.Integer({ min: 30, max: 86_400 });
const monitorTimeoutMs = Types.Integer({ min: 500, max: 30_000 });

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
  json: { type: Boolean, description: "Output raw JSON" },
} as const satisfies FlagsDefinition;

function probeFlags(mode: "add" | "edit") {
  const isAdd = mode === "add";
  const group = isAdd ? undefined : "fields";

  return {
    publicUrl: {
      type: isAdd ? nonEmptyString : String,
      placeholder: "<url>",
      group,
      description: isAdd
        ? "Optional clickable URL shown on the status page"
        : "Public link URL (pass empty string to clear)",
    },
    method: {
      type: monitorMethodType,
      default: isAdd ? ("GET" as const) : undefined,
      group,
      description: "HTTP probe method (GET, HEAD, POST)",
    },
    statusMin: {
      type: httpStatusCode,
      group,
      description: `Minimum accepted HTTP status code${isAdd ? " (default: 200)" : ""}`,
    },
    statusMax: {
      type: httpStatusCode,
      group,
      description: `Maximum accepted HTTP status code${isAdd ? " (default: 299)" : ""}`,
    },
    body: {
      type: String,
      group,
      description: isAdd
        ? "Substring required in the response body"
        : "Required response body substring (empty to clear)",
    },
    interval: {
      type: monitorIntervalSecs,
      group,
      description: `Probe interval in seconds${isAdd ? " (default: 60)" : ""}`,
    },
    timeout: {
      type: monitorTimeoutMs,
      group,
      description: `Probe timeout in milliseconds${isAdd ? " (default: 8000)" : ""}`,
    },
  } as const satisfies FlagsDefinition;
}

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

type AdminScope = Scope<any, AdminState>;

interface ResourceOpts<T> {
  label: string;
  apiBase: string;
  arg?: "id" | "key";
  argDesc: string;
  listDesc: string;
  empty: string;
  pick: (snap: DashboardSnapshot) => readonly T[];
  renderList: (theme: Theme, items: readonly T[], now: number) => string;
  show?: {
    description: string;
    find: (snap: DashboardSnapshot, id: string) => T | undefined;
    render: (theme: Theme, item: T, now: number) => string;
  };
  order?: {
    description: string;
    itemDesc: string;
  };
  rmDesc: string;
}

function addResourceCmds<T>(sub: AdminScope, opts: ResourceOpts<T>) {
  const argName = opts.arg ?? "id";

  sub.command("ls", {
    default: true,
    description: opts.listDesc,
    flags: jsonFlag,
    async run(ctx) {
      const data = await ctx.state.fetchSnapshot();
      const items = opts.pick(data);
      emitJsonOr(ctx, items, () => {
        ctx.log.raw(
          items.length === 0
            ? `  ${ctx.log.theme.muted(opts.empty)}`
            : opts.renderList(ctx.log.theme, items, data.now || unixNow()),
        );
      });
    },
  });

  function addTargetCmd(
    verb: "show" | "rm",
    description: string,
    flags: typeof jsonFlag | undefined,
    handler: (
      ctx: {
        state: AdminState;
        flags: { json?: boolean };
        log: {
          raw: (s: string) => unknown;
          success: (s: string) => unknown;
          theme: Theme;
        };
      },
      targetId: string,
    ) => Promise<void>,
  ) {
    if (argName === "key") {
      sub.command(`${verb} <key>`, {
        description,
        args: { key: { description: opts.argDesc } },
        flags,
        run: (ctx) => handler(ctx, ctx.args.key),
      });
    } else {
      sub.command(`${verb} <id>`, {
        description,
        args: { id: { description: opts.argDesc } },
        flags,
        run: (ctx) => handler(ctx, ctx.args.id),
      });
    }
  }

  if (opts.show) {
    const show = opts.show;
    addTargetCmd("show", show.description, jsonFlag, async (ctx, id) => {
      const data = await ctx.state.fetchSnapshot();
      const item = show.find(data, id);
      if (!item) {
        throw new Error(
          `${opts.label[0].toUpperCase()}${opts.label.slice(1)} "${id}" not found`,
        );
      }
      emitJsonOr(ctx, item, () => {
        ctx.log.raw(show.render(ctx.log.theme, item, data.now || unixNow()));
      });
    });
  }

  if (opts.order) {
    sub.command("order <ids...>", {
      description: opts.order.description,
      args: {
        ids: {
          unique: true,
          minItems: 1,
          maxItems: 500,
          description: opts.order.itemDesc,
        },
      },
      async run(ctx) {
        await ctx.state.request("PUT", `${opts.apiBase}/order`, {
          ids: ctx.args.ids,
        });
        ctx.log.success(
          `Updated display order for ${ctx.args.ids.length} ${opts.label}(s).`,
        );
      },
    });
  }

  addTargetCmd("rm", opts.rmDesc, undefined, async (ctx, id) => {
    await ctx.state.request(
      "DELETE",
      `${opts.apiBase}/${encodeURIComponent(id)}`,
    );
    ctx.log.success(`Removed ${opts.label} ${ctx.log.theme.bold(id)}.`);
  });
}

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
      flags: { auth: "Authentication", fields: "Monitor Fields" },
    })
    .use(completionsPlugin());

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
      const spec = parseSyncSpec(
        JSON.parse(fs.readFileSync(ctx.args.file, "utf8")) as unknown,
      );
      const auth = resolveAuth(ctx.flags, spec.hub_url);
      const request = createAdminRequester(auth);
      const snapshot = await request<DashboardSnapshot>(
        "GET",
        "/api/v1/admin/snapshot",
      );
      const plan = computeSyncPlan(snapshot, spec, { prune: ctx.flags.prune });
      const shouldApply = !ctx.flags.dryRun && plan.hasChanges;

      if (ctx.flags.json) {
        if (shouldApply) {
          await applySyncPlan(request, plan);
        }
        ctx.log.raw(
          JSON.stringify(
            {
              server: auth.server,
              dry_run: Boolean(ctx.flags.dryRun),
              applied: shouldApply,
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
          ctx.log.theme,
          ctx.flags.dryRun ? "Uptarn Plan" : "Uptarn Sync",
          auth.server,
        ),
      );
      ctx.log.raw(
        renderSyncPlan(ctx.log.theme, plan, { dryRun: ctx.flags.dryRun }),
      );
      if (shouldApply) {
        await applySyncPlan(request, plan);
        ctx.log.success("Applied changes to hub.");
      }
    },
  });

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
      const data = await ctx.state.fetchSnapshot();
      emitJsonOr(ctx, data, () => {
        ctx.log.raw(
          renderStatusOverview(ctx.log.theme, data, data.now || unixNow()),
        );
      });
    },
  });

  // ── node ──
  const node = admin.subcommand("node", {
    description: "Manage registered nodes",
  });
  addResourceCmds(node, {
    label: "node",
    apiBase: "/api/v1/admin/nodes",
    argDesc: "Node identifier",
    listDesc: "List all registered nodes",
    empty: "No nodes registered.",
    pick: (d) => d.nodes,
    renderList: renderNodesTable,
    show: {
      description: "Show detailed telemetry and configuration for a node",
      find: (d, id) => d.nodes.find((n) => n.id === id),
      render: renderNodeDetail,
    },
    order: {
      description: "Set display order for nodes",
      itemDesc: "Ordered list of node identifiers",
    },
    rmDesc: "Delete a registered node and its telemetry",
  });
  node.command("add <id>", {
    description: "Register a new node and issue its ingest token",
    args: { id: { description: "Unique node identifier" } },
    flags: {
      label: { type: String, description: "Human-readable node label" },
      interval: {
        type: Types.Integer({ min: 10, max: 86_400 }),
        description: "Expected report interval in seconds",
      },
      grace: {
        type: Types.Integer({ min: 10, max: 604_800 }),
        description: "Offline grace period in seconds",
      },
      public: {
        type: Boolean,
        description: "Show this node on the public status page",
      },
      ...jsonFlag,
    },
    async run(ctx) {
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
      emitJsonOr(ctx, res, () => {
        ctx.log
          .success(
            `Registered node ${ctx.log.theme.bold(res.id)} (${res.label})`,
          )
          .line(`Token  ${ctx.log.theme.warn(res.token)}`);
      });
    },
  });
  node.command("public <id> <state>", {
    description: "Set a node's public status page visibility (on/off)",
    args: {
      id: { description: "Node identifier" },
      state: { type: onOffType, description: "Visibility: on or off" },
    },
    async run(ctx) {
      const isPublic = ctx.args.state === "on";
      await ctx.state.request(
        "PATCH",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}`,
        { is_public: isPublic },
      );
      ctx.log.success(
        `Node ${ctx.log.theme.bold(ctx.args.id)} is now ${isPublic ? ctx.log.theme.accent("public") : ctx.log.theme.muted("private")}.`,
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
      const primaryMount =
        ctx.args.mount === "sum" ? null : ctx.args.mount.trim();
      await ctx.state.request(
        "PATCH",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}`,
        { primary_mount: primaryMount },
      );
      ctx.log.success(
        primaryMount
          ? `Node ${ctx.log.theme.bold(ctx.args.id)} disk summary set to ${ctx.log.theme.accent(primaryMount)}.`
          : `Node ${ctx.log.theme.bold(ctx.args.id)} disk summary set to sum of all mounts.`,
      );
    },
  });
  node.command("rotate <id>", {
    description: "Rotate a node's ingest Bearer token",
    args: { id: { description: "Node identifier" } },
    flags: jsonFlag,
    async run(ctx) {
      const res = await ctx.state.request<{ id: string; token: string }>(
        "POST",
        `/api/v1/admin/nodes/${encodeURIComponent(ctx.args.id)}/rotate-token`,
      );
      emitJsonOr(ctx, res, () => {
        ctx.log
          .success(`Rotated token for ${ctx.log.theme.bold(res.id)}`)
          .line(`Token  ${ctx.log.theme.warn(res.token)}`);
      });
    },
  });

  // ── monitor ──
  const monitor = admin.subcommand("monitor", {
    aliases: ["mon"],
    description: "Manage HTTP monitors",
  });
  addResourceCmds(monitor, {
    label: "monitor",
    apiBase: "/api/v1/admin/monitors",
    argDesc: "Monitor identifier",
    listDesc: "List all HTTP monitors",
    empty: "No monitors configured.",
    pick: (d) => d.monitors,
    renderList: (theme, items) => renderMonitorsTable(theme, items),
    show: {
      description: "Show status and configuration for an HTTP monitor",
      find: (d, id) => d.monitors.find((m) => m.id === id),
      render: renderMonitorDetail,
    },
    order: {
      description: "Set display order for HTTP monitors",
      itemDesc: "Ordered list of monitor identifiers",
    },
    rmDesc: "Delete a hub-managed HTTP monitor",
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
      ...probeFlags("add"),
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
      emitJsonOr(ctx, res, () => {
        ctx.log.success(
          `Created monitor ${ctx.log.theme.bold(res.id)} (${ctx.args.name}).`,
        );
      });
    },
  });
  monitor.command("edit <id>", {
    description: "Update an existing hub-managed HTTP monitor",
    args: { id: { description: "Monitor identifier" } },
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
      ...probeFlags("edit"),
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
      emitJsonOr(ctx, res, () => {
        ctx.log.success(`Updated monitor ${ctx.log.theme.bold(res.id)}.`);
      });
    },
  });

  // ── job ──
  const job = admin.subcommand("job", {
    description: "Manage scheduled jobs",
  });
  addResourceCmds(job, {
    label: "job",
    apiBase: "/api/v1/admin/jobs",
    arg: "key",
    argDesc: "Job key",
    listDesc: "List all reported jobs",
    empty: "No jobs reported.",
    pick: (d) => d.jobs,
    renderList: renderJobsTable,
    show: {
      description: "Show status and last run details for a job",
      find: (d, key) => d.jobs.find((j) => j.key === key),
      render: renderJobDetail,
    },
    rmDesc: "Delete a job and its incident state",
  });

  // ── incident ──
  admin
    .subcommand("incident", {
      aliases: ["inc"],
      description: "Inspect active incidents and incident history",
    })
    .command("ls", {
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
        emitJsonOr(ctx, { incidents: data.incidents, events }, () => {
          const now = data.now || unixNow();
          ctx.log.raw(
            [
              renderSection(
                theme,
                "Active Incidents",
                `(${data.incidents.length})`,
              ),
              data.incidents.length === 0
                ? `  ${theme.success("No active incidents.")}`
                : renderIncidentsList(theme, data.incidents),
              renderSection(theme, "History", `(${events.length})`),
              events.length === 0
                ? `  ${theme.muted("No incident history recorded.")}`
                : renderIncidentEventsTable(theme, events, now),
            ].join("\n"),
          );
        });
      },
    });

  // ── mute / unmute ──
  const muteArgs = {
    targetType: { type: targetTypeArg, description: "node, monitor, or job" },
    targetId: { description: "Target identifier" },
  } as const;

  const applyMute = async (
    request: AdminRequestFn,
    targetType: TargetType,
    targetId: string,
    durationSecs: number,
  ) =>
    request<{ muted_until: number }>("POST", "/api/v1/admin/mute", {
      target_type: targetType,
      target_id: targetId,
      duration_secs: durationSecs,
    });

  admin.command("mute <targetType> <targetId>", {
    description: "Mute or unmute notifications for a node, monitor, or job",
    args: muteArgs,
    flags: {
      duration: {
        type: nonNegativeInt,
        short: "d",
        default: 3600,
        description: "Mute duration in seconds (0 unmutes)",
      },
    },
    async run(ctx) {
      const res = await applyMute(
        ctx.state.request,
        ctx.args.targetType,
        ctx.args.targetId,
        ctx.flags.duration,
      );
      ctx.log.success(
        res.muted_until === 0
          ? `Unmuted ${ctx.args.targetType} ${ctx.log.theme.bold(ctx.args.targetId)}.`
          : `Muted ${ctx.args.targetType} ${ctx.log.theme.bold(ctx.args.targetId)} for ${ctx.flags.duration}s.`,
      );
    },
  });
  admin.command("unmute <targetType> <targetId>", {
    description: "Unmute notifications for a node, monitor, or job",
    args: muteArgs,
    async run(ctx) {
      await applyMute(
        ctx.state.request,
        ctx.args.targetType,
        ctx.args.targetId,
        0,
      );
      ctx.log.success(
        `Unmuted ${ctx.args.targetType} ${ctx.log.theme.bold(ctx.args.targetId)}.`,
      );
    },
  });

  // ── settings ──
  const settings = admin.subcommand("settings", {
    description: "Inspect and update hub runtime settings",
  });
  const patchSettings = (
    request: AdminRequestFn,
    body: Record<string, unknown>,
  ) => request<SettingsPatchResponse>("PATCH", "/api/v1/admin/settings", body);

  settings.command("show", {
    default: true,
    description: "Show current hub runtime settings",
    flags: jsonFlag,
    async run(ctx) {
      const data = await ctx.state.fetchSnapshot();
      emitJsonOr(ctx, data.settings, () => {
        ctx.log.raw(
          [
            renderBanner(ctx.log.theme, "Hub Settings"),
            renderSettingsDetail(
              ctx.log.theme,
              data.settings,
              data.now || unixNow(),
            ),
          ].join("\n"),
        );
      });
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
      const res = await patchSettings(ctx.state.request, {
        auto_register: ctx.args.state === "on",
      });
      emitJsonOr(ctx, res, () => {
        const { theme } = ctx.log;
        const msg = `Auto-registration is now ${res.auto_register ? theme.warn("enabled") : theme.muted("disabled")}.`;
        if (res.auto_register && res.enrollment_token) {
          ctx.log
            .success(msg)
            .line(`Enrollment token  ${theme.warn(res.enrollment_token)}`);
        } else {
          ctx.log.success(msg);
        }
      });
    },
  });
  settings.command("rotate-enroll", {
    description: "Rotate the agent auto-registration enrollment token",
    flags: jsonFlag,
    async run(ctx) {
      const res = await patchSettings(ctx.state.request, {
        rotate_enrollment_token: true,
      });
      emitJsonOr(ctx, res, () => {
        ctx.log
          .success("Rotated enrollment token.")
          .line(
            `Enrollment token  ${ctx.log.theme.warn(res.enrollment_token ?? "-")}`,
          );
      });
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
      const res = await patchSettings(ctx.state.request, {
        global_mute_secs: ctx.flags.duration,
      });
      emitJsonOr(ctx, res, () => {
        ctx.log.success(
          res.global_muted_until === 0
            ? "Unmuted global notifications."
            : `Muted all notifications globally for ${ctx.flags.duration}s.`,
        );
      });
    },
  });

  // ── passkey ──
  const passkey = admin.subcommand("passkey", {
    description: "Manage registered admin passkeys",
  });
  addResourceCmds(passkey, {
    label: "passkey",
    apiBase: "/api/v1/admin/passkeys",
    argDesc: "Passkey identifier",
    listDesc: "List registered WebAuthn passkeys",
    empty: "No passkeys registered.",
    pick: (d) => d.passkeys,
    renderList: renderPasskeysTable,
    rmDesc: "Delete a registered WebAuthn passkey",
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
      emitJsonOr(ctx, res, () => {
        ctx.log.success(
          `Tick completed: ${res.probed_monitors} monitors probed, ${res.evaluated_nodes} nodes evaluated, ${res.evaluated_jobs} jobs evaluated.`,
        );
      });
    },
  });
  admin
    .subcommand("notify", { description: "Manage notification channels" })
    .command("test", {
      description: "Send a test notification to configured IM channels",
      flags: jsonFlag,
      async run(ctx) {
        const res = await ctx.state.request<{
          delivery: Record<string, string>;
        }>("POST", "/api/v1/admin/notifications/test");
        emitJsonOr(ctx, res, () => {
          const entries = Object.entries(res.delivery);
          if (entries.length === 0) {
            ctx.log.warn("No notification channels configured.");

            return;
          }
          ctx.log.success(
            `Test notification sent: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`,
          );
        });
      },
    });

  // ── server ──
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
        type: Types.Integer({ min: 1, max: 65_535 }),
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
