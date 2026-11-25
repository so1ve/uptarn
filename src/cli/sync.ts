import type { Theme } from "clerc";

import type {
  DashboardSnapshot,
  MaintenanceSummary,
  MonitorSummary,
  SiteLink,
} from "../shared/index.ts";
import {
  normalizeGroup,
  normalizePrimaryMount,
  normalizeSiteLinks,
  normalizeSiteTitle,
  parseMaintenanceInput,
  parseMonitorInput,
  parseMonitorPatch,
} from "../validation.ts";
import { renderSection } from "./format.ts";

export type NormalizedSyncMonitor = ReturnType<typeof parseMonitorInput>;
export type NormalizedSyncMaintenance = ReturnType<
  typeof parseMaintenanceInput
>;

export type SyncMonitorEntry =
  | ({ kind: "hub" } & NormalizedSyncMonitor)
  | {
      kind: "override";
      id: string;
      is_public?: boolean;
      public_url?: string | null;
      group?: string | null;
    };

export interface SyncSpec {
  hub_url?: string;
  auto_register?: boolean;
  site_title?: string | null;
  site_links?: SiteLink[];
  nodes?: {
    id: string;
    is_public?: boolean;
    primary_mount?: string | null;
    group?: string | null;
  }[];
  monitors?: SyncMonitorEntry[];
  maintenances?: NormalizedSyncMaintenance[];
}

export interface SyncPlan {
  settingsPatch: {
    auto_register?: boolean;
    site_title?: string | null;
    site_links?: SiteLink[];
  } | null;
  nodePatches: {
    id: string;
    patch: {
      is_public?: boolean;
      primary_mount?: string | null;
      group?: string | null;
    };
    changes: string[];
  }[];
  missingNodes: string[];
  managedNodeConflicts: { id: string; declared: boolean; current: boolean }[];
  nodeOrder: string[] | null;
  monitorsCreate: NormalizedSyncMonitor[];
  monitorsUpdate: { monitor: NormalizedSyncMonitor; changes: string[] }[];
  monitorPatches: {
    id: string;
    patch: {
      is_public?: boolean;
      public_url?: string | null;
      group?: string | null;
    };
    changes: string[];
  }[];
  missingMonitors: string[];
  monitorsDelete: { id: string; name: string }[];
  unmanagedMonitors: { id: string; name: string }[];
  managedMonitorConflicts: { id: string; nodeId: string; reason: string }[];
  monitorOrder: string[] | null;
  maintenancesCreate: NormalizedSyncMaintenance[];
  maintenancesUpdate: {
    maintenance: NormalizedSyncMaintenance;
    changes: string[];
  }[];
  maintenancesDelete: { id: string; title: string }[];
  unmanagedMaintenances: { id: string; title: string }[];
  hasChanges: boolean;
  hasConflicts: boolean;
}

export type AdminRequestFn = <T>(
  method: string,
  apiPath: string,
  body?: unknown,
) => Promise<T>;

function asRecord(val: unknown, label: string): Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    throw new Error(`${label} must be an object`);
  }

  return val as Record<string, unknown>;
}

function optionalBool(val: unknown, label: string): boolean | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }

  return val;
}

function parseUniqueArray<T extends { id: string }>(
  raw: unknown,
  field: string,
  parseItem: (obj: Record<string, unknown>, label: string) => T,
): T[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new TypeError(`${field} must be an array`);
  }
  const seen = new Set<string>();

  return raw.map((entry, idx) => {
    const label = `${field}[${idx}]`;
    const item = parseItem(asRecord(entry, label), label);
    if (seen.has(item.id)) {
      throw new Error(`${label}.id duplicate "${item.id}"`);
    }
    seen.add(item.id);

    return item;
  });
}

export function parseSyncSpec(raw: unknown): SyncSpec {
  const obj = asRecord(raw, "sync config");
  const spec: SyncSpec = {};

  if (typeof obj.hub_url === "string" && obj.hub_url.trim()) {
    spec.hub_url = obj.hub_url.trim().replace(/\/+$/, "");
  }

  const autoRegister = optionalBool(obj.auto_register, "auto_register");
  if (autoRegister !== undefined) {
    spec.auto_register = autoRegister;
  }
  if (Object.hasOwn(obj, "site_title")) {
    spec.site_title = normalizeSiteTitle(obj.site_title, "site_title");
  }
  if (Object.hasOwn(obj, "site_links")) {
    spec.site_links = normalizeSiteLinks(obj.site_links, "site_links");
  }

  spec.nodes = parseUniqueArray(obj.nodes, "nodes", (node, label) => {
    if (typeof node.id !== "string" || !node.id.trim()) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    const isPublic = optionalBool(node.is_public, `${label}.is_public`);
    const primaryMount = Object.hasOwn(node, "primary_mount")
      ? normalizePrimaryMount(node.primary_mount, `${label}.primary_mount`)
      : undefined;
    const group = Object.hasOwn(node, "group")
      ? normalizeGroup(node.group, `${label}.group`)
      : undefined;

    return {
      id: node.id.trim(),
      ...(isPublic === undefined ? {} : { is_public: isPublic }),
      ...(primaryMount === undefined ? {} : { primary_mount: primaryMount }),
      ...(group === undefined ? {} : { group }),
    };
  });

  spec.monitors = parseUniqueArray<SyncMonitorEntry>(
    obj.monitors,
    "monitors",
    (mon, label) => {
      if (typeof mon.id !== "string" || !mon.id.trim()) {
        throw new Error(`${label}.id is required for declarative sync`);
      }
      if (mon.url === undefined || mon.url === null) {
        const hasPatch =
          mon.is_public !== undefined ||
          Object.hasOwn(mon, "public_url") ||
          Object.hasOwn(mon, "group");
        const patch = hasPatch ? parseMonitorPatch(mon) : {};

        return { kind: "override", id: mon.id.trim(), ...patch };
      }

      return { kind: "hub", ...parseMonitorInput(mon) };
    },
  );

  spec.maintenances = parseUniqueArray(
    obj.maintenances,
    "maintenances",
    (maint, label) => {
      if (typeof maint.id !== "string" || !maint.id.trim()) {
        throw new Error(`${label}.id is required for declarative sync`);
      }

      return parseMaintenanceInput(maint);
    },
  );

  return spec;
}

const HUB_MONITOR_DIFF_KEYS = [
  "name",
  "group",
  "url",
  "public_url",
  "method",
  "expected_status_min",
  "expected_status_max",
  "expected_body",
  "timeout_ms",
  "interval_secs",
  "enabled",
  "is_public",
] as const;

function diffMonitor(
  current: MonitorSummary,
  desired: NormalizedSyncMonitor,
): string[] {
  const flat =
    current.probe.from === "hub"
      ? {
          name: current.name,
          group: current.group,
          url: current.probe.url,
          public_url: current.public_url,
          method: current.probe.method,
          expected_status_min: current.probe.expected_status_min,
          expected_status_max: current.probe.expected_status_max,
          expected_body: current.probe.expected_body,
          timeout_ms: current.probe.timeout_ms,
          interval_secs: current.interval_secs,
          enabled: current.enabled,
          is_public: current.is_public,
        }
      : null;
  if (!flat) {
    return ["probe: agent -> hub"];
  }

  return HUB_MONITOR_DIFF_KEYS.filter((f) => flat[f] !== desired[f]).map(
    (f) => `${f}: ${JSON.stringify(flat[f])} -> ${JSON.stringify(desired[f])}`,
  );
}

function diffMaintenance(
  current: MaintenanceSummary,
  desired: NormalizedSyncMaintenance,
): string[] {
  const changes: string[] = [];
  if (current.title !== desired.title) {
    changes.push(
      `title: ${JSON.stringify(current.title)} -> ${JSON.stringify(desired.title)}`,
    );
  }
  if (current.body !== desired.body) {
    changes.push("body updated");
  }
  if (current.starts_at !== desired.starts_at) {
    changes.push(`starts_at: ${current.starts_at} -> ${desired.starts_at}`);
  }
  if (current.ends_at !== desired.ends_at) {
    changes.push(`ends_at: ${current.ends_at} -> ${desired.ends_at}`);
  }
  if (JSON.stringify(current.targets) !== JSON.stringify(desired.targets)) {
    changes.push(
      `targets: ${current.targets.length} -> ${desired.targets.length}`,
    );
  }

  return changes;
}

function computeReorder(
  baselineOrder: readonly string[],
  declaredOrder: readonly string[],
  survivingExisting: readonly string[],
  declaredSet: ReadonlySet<string>,
): string[] | null {
  const desired = [
    ...declaredOrder,
    ...survivingExisting.filter((id) => !declaredSet.has(id)),
  ];
  const unchanged =
    desired.length === 0 ||
    (desired.length === baselineOrder.length &&
      desired.every((id, i) => id === baselineOrder[i]));

  return unchanged ? null : desired;
}

export function computeSyncPlan(
  current: DashboardSnapshot,
  spec: SyncSpec,
  options: { prune?: boolean } = {},
): SyncPlan {
  const prune = options.prune ?? false;
  const nextSettings: NonNullable<SyncPlan["settingsPatch"]> = {};
  if (
    spec.auto_register !== undefined &&
    spec.auto_register !== current.settings.auto_register
  ) {
    nextSettings.auto_register = spec.auto_register;
  }
  if (
    spec.site_title !== undefined &&
    spec.site_title !== current.settings.site_title
  ) {
    nextSettings.site_title = spec.site_title;
  }
  if (
    spec.site_links !== undefined &&
    JSON.stringify(spec.site_links) !==
      JSON.stringify(current.settings.site_links)
  ) {
    nextSettings.site_links = spec.site_links;
  }
  const settingsPatch =
    Object.keys(nextSettings).length > 0 ? nextSettings : null;

  const nodePatches: SyncPlan["nodePatches"] = [];
  const missingNodes: string[] = [];
  const managedNodeConflicts: SyncPlan["managedNodeConflicts"] = [];
  let nodeOrder: string[] | null = null;

  if (spec.nodes !== undefined) {
    const byId = new Map(current.nodes.map((n) => [n.id, n]));
    const declaredOrder: string[] = [];
    const declaredSet = new Set<string>();

    for (const declared of spec.nodes) {
      const existing = byId.get(declared.id);
      if (!existing) {
        missingNodes.push(declared.id);

        continue;
      }
      declaredOrder.push(declared.id);
      declaredSet.add(declared.id);

      const patch: {
        is_public?: boolean;
        primary_mount?: string | null;
        group?: string | null;
      } = {};
      const changes: string[] = [];
      if (
        declared.is_public !== undefined &&
        declared.is_public !== existing.is_public
      ) {
        if (existing.public_managed) {
          managedNodeConflicts.push({
            id: declared.id,
            declared: declared.is_public,
            current: existing.is_public,
          });
        } else {
          patch.is_public = declared.is_public;
          changes.push(
            `is_public: ${existing.is_public} -> ${declared.is_public}`,
          );
        }
      }
      if (
        declared.primary_mount !== undefined &&
        declared.primary_mount !== existing.primary_mount
      ) {
        patch.primary_mount = declared.primary_mount;
        changes.push(
          `primary_mount: ${existing.primary_mount ?? "sum"} -> ${declared.primary_mount ?? "sum"}`,
        );
      }
      if (declared.group !== undefined && declared.group !== existing.group) {
        patch.group = declared.group;
        changes.push(
          `group: ${JSON.stringify(existing.group)} -> ${JSON.stringify(declared.group)}`,
        );
      }
      if (changes.length > 0) {
        nodePatches.push({ id: declared.id, patch, changes });
      }
    }

    const currentIds = current.nodes.map((n) => n.id);
    nodeOrder = computeReorder(
      currentIds,
      declaredOrder,
      currentIds,
      declaredSet,
    );
  }

  const monitorsCreate: NormalizedSyncMonitor[] = [];
  const monitorsUpdate: SyncPlan["monitorsUpdate"] = [];
  const monitorPatches: SyncPlan["monitorPatches"] = [];
  const missingMonitors: string[] = [];
  const monitorsDelete: SyncPlan["monitorsDelete"] = [];
  const unmanagedMonitors: SyncPlan["unmanagedMonitors"] = [];
  const managedMonitorConflicts: SyncPlan["managedMonitorConflicts"] = [];
  let monitorOrder: string[] | null = null;

  if (spec.monitors !== undefined) {
    const byId = new Map(current.monitors.map((m) => [m.id, m]));
    const declaredSet = new Set<string>();
    const declaredOrder: string[] = [];

    for (const desired of spec.monitors) {
      declaredSet.add(desired.id);
      const existing = byId.get(desired.id);
      if (desired.kind === "override") {
        if (!existing) {
          missingMonitors.push(desired.id);

          continue;
        }
        declaredOrder.push(desired.id);
        const patch: {
          is_public?: boolean;
          public_url?: string | null;
          group?: string | null;
        } = {};
        const changes: string[] = [];
        if (
          desired.is_public !== undefined &&
          desired.is_public !== existing.is_public
        ) {
          if (existing.public_managed) {
            managedMonitorConflicts.push({
              id: desired.id,
              nodeId: existing.managed_by_node_id ?? "agent",
              reason: `is_public is managed by node "${existing.managed_by_node_id ?? "agent"}"`,
            });
          } else {
            patch.is_public = desired.is_public;
            changes.push(
              `is_public: ${existing.is_public} -> ${desired.is_public}`,
            );
          }
        }
        if (
          desired.public_url !== undefined &&
          desired.public_url !== existing.public_url
        ) {
          patch.public_url = desired.public_url;
          changes.push(
            `public_url: ${JSON.stringify(existing.public_url)} -> ${JSON.stringify(desired.public_url)}`,
          );
        }
        if (desired.group !== undefined && desired.group !== existing.group) {
          patch.group = desired.group;
          changes.push(
            `group: ${JSON.stringify(existing.group)} -> ${JSON.stringify(desired.group)}`,
          );
        }
        if (changes.length > 0) {
          monitorPatches.push({ id: desired.id, patch, changes });
        }

        continue;
      }

      const { kind: _kind, ...hubSpec } = desired;
      if (!existing) {
        monitorsCreate.push(hubSpec);
        declaredOrder.push(hubSpec.id);

        continue;
      }
      if (existing.managed_by_node_id) {
        managedMonitorConflicts.push({
          id: hubSpec.id,
          nodeId: existing.managed_by_node_id,
          reason: `managed by node "${existing.managed_by_node_id}"`,
        });

        continue;
      }
      declaredOrder.push(hubSpec.id);
      const changes = diffMonitor(existing, hubSpec);
      if (changes.length > 0) {
        monitorsUpdate.push({ monitor: hubSpec, changes });
      }
    }

    const deletedSet = new Set<string>();
    for (const existing of current.monitors) {
      if (declaredSet.has(existing.id) || existing.managed_by_node_id) {
        continue;
      }
      const ref = { id: existing.id, name: existing.name };
      if (prune) {
        monitorsDelete.push(ref);
        deletedSet.add(existing.id);
      } else {
        unmanagedMonitors.push(ref);
      }
    }

    const surviving = current.monitors
      .map((m) => m.id)
      .filter((id) => !deletedSet.has(id));
    monitorOrder = computeReorder(
      [...surviving, ...monitorsCreate.map((m) => m.id)],
      declaredOrder,
      surviving,
      declaredSet,
    );
  }

  const maintenancesCreate: NormalizedSyncMaintenance[] = [];
  const maintenancesUpdate: SyncPlan["maintenancesUpdate"] = [];
  const maintenancesDelete: SyncPlan["maintenancesDelete"] = [];
  const unmanagedMaintenances: SyncPlan["unmanagedMaintenances"] = [];

  if (spec.maintenances !== undefined) {
    const byId = new Map(current.maintenances.map((m) => [m.id, m]));
    const declaredSet = new Set<string>();
    for (const desired of spec.maintenances) {
      declaredSet.add(desired.id);
      const existing = byId.get(desired.id);
      if (!existing) {
        maintenancesCreate.push(desired);

        continue;
      }
      const changes = diffMaintenance(existing, desired);
      if (changes.length > 0) {
        maintenancesUpdate.push({ maintenance: desired, changes });
      }
    }
    for (const existing of current.maintenances) {
      if (declaredSet.has(existing.id)) {
        continue;
      }
      const ref = { id: existing.id, title: existing.title };
      if (prune) {
        maintenancesDelete.push(ref);
      } else {
        unmanagedMaintenances.push(ref);
      }
    }
  }

  return {
    settingsPatch,
    nodePatches,
    missingNodes,
    managedNodeConflicts,
    nodeOrder,
    monitorsCreate,
    monitorsUpdate,
    monitorPatches,
    missingMonitors,
    monitorsDelete,
    unmanagedMonitors,
    managedMonitorConflicts,
    monitorOrder,
    maintenancesCreate,
    maintenancesUpdate,
    maintenancesDelete,
    unmanagedMaintenances,
    hasChanges:
      settingsPatch !== null ||
      nodePatches.length > 0 ||
      nodeOrder !== null ||
      monitorsCreate.length > 0 ||
      monitorsUpdate.length > 0 ||
      monitorPatches.length > 0 ||
      monitorsDelete.length > 0 ||
      monitorOrder !== null ||
      maintenancesCreate.length > 0 ||
      maintenancesUpdate.length > 0 ||
      maintenancesDelete.length > 0,
    hasConflicts:
      managedNodeConflicts.length > 0 || managedMonitorConflicts.length > 0,
  };
}

export function renderSyncPlan(
  theme: Theme,
  plan: SyncPlan,
  options: { dryRun?: boolean } = {},
): string {
  const lines: string[] = [];
  const row = (mark: string, id: string, detail: string) =>
    `  ${mark} ${id}  ${detail}`;
  function pushSection(title: string, items: string[]) {
    if (items.length > 0) {
      lines.push(renderSection(theme, title), ...items);
    }
  }
  const orderRow = (ids: string[] | null) =>
    ids
      ? [
          row(
            theme.warn("~"),
            theme.bold("order"),
            theme.muted(ids.join(" -> ")),
          ),
        ]
      : [];

  pushSection(
    "Settings",
    plan.settingsPatch
      ? [
          ...(plan.settingsPatch.auto_register === undefined
            ? []
            : [
                `  ${theme.warn("~")} auto_register ${theme.muted("->")} ${theme.bold(String(plan.settingsPatch.auto_register))}`,
              ]),
          ...(plan.settingsPatch.site_title === undefined
            ? []
            : [
                `  ${theme.warn("~")} site_title ${theme.muted("->")} ${theme.bold(JSON.stringify(plan.settingsPatch.site_title))}`,
              ]),
          ...(plan.settingsPatch.site_links === undefined
            ? []
            : [
                `  ${theme.warn("~")} site_links ${theme.muted("->")} ${theme.bold(`${plan.settingsPatch.site_links.length} link(s)`)}`,
              ]),
        ]
      : [],
  );

  pushSection("Nodes", [
    ...plan.nodePatches.map((item) =>
      row(
        theme.warn("~"),
        theme.bold(item.id),
        theme.muted(item.changes.join(", ")),
      ),
    ),
    ...orderRow(plan.nodeOrder),
    ...plan.missingNodes.map((id) =>
      row(
        theme.warn("!"),
        theme.bold(id),
        theme.muted("not registered on hub (skipped)"),
      ),
    ),
    ...plan.managedNodeConflicts.map((c) =>
      row(
        theme.error("!"),
        theme.bold(c.id),
        theme.error(
          `is_public is managed by agent (current=${c.current}, declared=${c.declared})`,
        ),
      ),
    ),
  ]);

  pushSection("Monitors", [
    ...plan.monitorsCreate.map((m) =>
      row(
        theme.success("+"),
        theme.bold(m.id),
        `${m.name} ${theme.muted(`(${m.method} ${m.url})`)}`,
      ),
    ),
    ...plan.monitorsUpdate.flatMap(({ monitor, changes }) => [
      row(theme.warn("~"), theme.bold(monitor.id), monitor.name),
      ...changes.map((c) => `      ${theme.muted(c)}`),
    ]),
    ...plan.monitorPatches.map((item) =>
      row(
        theme.warn("~"),
        theme.bold(item.id),
        theme.muted(item.changes.join(", ")),
      ),
    ),
    ...plan.monitorsDelete.map((m) =>
      row(theme.error("-"), theme.bold(m.id), theme.muted(m.name)),
    ),
    ...orderRow(plan.monitorOrder),
    ...plan.missingMonitors.map((id) =>
      row(
        theme.warn("!"),
        theme.bold(id),
        theme.muted("not reported by agent yet (skipped)"),
      ),
    ),
    ...plan.unmanagedMonitors.map((m) =>
      row(
        theme.muted("?"),
        theme.muted(m.id),
        theme.muted(`${m.name} (unmanaged; pass --prune to remove)`),
      ),
    ),
    ...plan.managedMonitorConflicts.map((c) =>
      row(theme.error("!"), theme.bold(c.id), theme.error(c.reason)),
    ),
  ]);

  pushSection("Maintenances", [
    ...plan.maintenancesCreate.map((m) =>
      row(theme.success("+"), theme.bold(m.id), m.title),
    ),
    ...plan.maintenancesUpdate.flatMap(({ maintenance: m, changes }) => [
      row(theme.warn("~"), theme.bold(m.id), m.title),
      ...changes.map((c) => `      ${theme.muted(c)}`),
    ]),
    ...plan.maintenancesDelete.map((m) =>
      row(theme.error("-"), theme.bold(m.id), theme.muted(m.title)),
    ),
    ...plan.unmanagedMaintenances.map((m) =>
      row(
        theme.muted("?"),
        theme.muted(m.id),
        theme.muted(`${m.title} (unmanaged; pass --prune to remove)`),
      ),
    ),
  ]);

  if (!plan.hasChanges && !plan.hasConflicts) {
    lines.push(
      `\n  ${theme.success("✓")} ${theme.bold("In sync")} ${theme.muted("(0 changes)")}`,
    );
  } else if (options.dryRun) {
    const createCount =
      plan.monitorsCreate.length + plan.maintenancesCreate.length;
    const updateCount =
      plan.monitorsUpdate.length +
      plan.monitorPatches.length +
      plan.nodePatches.length +
      plan.maintenancesUpdate.length +
      (plan.settingsPatch ? 1 : 0);
    const deleteCount =
      plan.monitorsDelete.length + plan.maintenancesDelete.length;
    const parts = [
      createCount > 0 && `+${createCount} create`,
      updateCount > 0 && `~${updateCount} update`,
      deleteCount > 0 && `-${deleteCount} delete`,
      (plan.nodeOrder !== null || plan.monitorOrder !== null) && "reorder",
    ].filter(Boolean);
    lines.push(
      `\n  ${theme.warn("Dry run:")} ${parts.join(", ")} ${theme.muted("(no changes applied)")}`,
    );
  }

  return lines.join("\n");
}

export async function applySyncPlan(
  request: AdminRequestFn,
  plan: SyncPlan,
): Promise<void> {
  if (plan.hasConflicts) {
    const reasons = [
      ...plan.managedNodeConflicts.map(
        (c) => `node "${c.id}" is_public is managed by its agent`,
      ),
      ...plan.managedMonitorConflicts.map(
        (c) => `monitor "${c.id}" ${c.reason}`,
      ),
    ];

    throw new Error(
      `Sync refused due to agent-managed conflicts: ${reasons.join("; ")}`,
    );
  }

  if (plan.settingsPatch) {
    await request("PATCH", "/api/v1/admin/settings", plan.settingsPatch);
  }
  for (const item of plan.nodePatches) {
    await request(
      "PATCH",
      `/api/v1/admin/nodes/${encodeURIComponent(item.id)}`,
      item.patch,
    );
  }
  if (plan.nodeOrder) {
    await request("PUT", "/api/v1/admin/nodes/order", { ids: plan.nodeOrder });
  }
  for (const mon of [
    ...plan.monitorsCreate,
    ...plan.monitorsUpdate.map((u) => u.monitor),
  ]) {
    await request("POST", "/api/v1/admin/monitors", mon);
  }
  for (const item of plan.monitorPatches) {
    await request(
      "PATCH",
      `/api/v1/admin/monitors/${encodeURIComponent(item.id)}`,
      item.patch,
    );
  }
  for (const mon of plan.monitorsDelete) {
    await request(
      "DELETE",
      `/api/v1/admin/monitors/${encodeURIComponent(mon.id)}`,
    );
  }
  if (plan.monitorOrder) {
    await request("PUT", "/api/v1/admin/monitors/order", {
      ids: plan.monitorOrder,
    });
  }
  for (const maint of [
    ...plan.maintenancesCreate,
    ...plan.maintenancesUpdate.map((u) => u.maintenance),
  ]) {
    await request("POST", "/api/v1/admin/maintenances", maint);
  }
  for (const maint of plan.maintenancesDelete) {
    await request(
      "DELETE",
      `/api/v1/admin/maintenances/${encodeURIComponent(maint.id)}`,
    );
  }
}
