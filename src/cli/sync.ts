import type { Theme } from "clerc";

import type { DashboardSnapshot, MonitorSummary } from "../shared/index.ts";
import { parseMonitorInput } from "../validation.ts";
import { renderSection } from "./format.ts";

export interface SyncNodeSpec {
  id: string;
  is_public?: boolean;
}

export type NormalizedSyncMonitor = ReturnType<typeof parseMonitorInput>;

export interface SyncSpec {
  hub_url?: string;
  auto_register?: boolean;
  nodes?: SyncNodeSpec[];
  monitors?: NormalizedSyncMonitor[];
}

export interface NodeVisibilityPatch {
  id: string;
  from: boolean;
  to: boolean;
}

export interface ManagedNodeConflict {
  id: string;
  declared: boolean;
  current: boolean;
}

export interface MonitorUpdate {
  monitor: NormalizedSyncMonitor;
  changes: string[];
}

export interface MonitorRef {
  id: string;
  name: string;
}

export interface ManagedMonitorConflict {
  id: string;
  nodeId: string;
}

export interface SyncPlan {
  settingsPatch: { auto_register: boolean } | null;
  nodePatches: NodeVisibilityPatch[];
  missingNodes: string[];
  managedNodeConflicts: ManagedNodeConflict[];
  nodeOrder: string[] | null;
  monitorsCreate: NormalizedSyncMonitor[];
  monitorsUpdate: MonitorUpdate[];
  monitorsDelete: MonitorRef[];
  unmanagedMonitors: MonitorRef[];
  managedMonitorConflicts: ManagedMonitorConflict[];
  monitorOrder: string[] | null;
  hasChanges: boolean;
  hasConflicts: boolean;
}

export type AdminRequestFn = <T>(
  method: string,
  apiPath: string,
  body?: unknown,
) => Promise<T>;

const MONITOR_COMPARE_FIELDS = [
  "name",
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

function asRecord(val: unknown, label: string): Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    throw new Error(`${label} must be an object`);
  }

  return val as Record<string, unknown>;
}

export function parseSyncSpec(raw: unknown): SyncSpec {
  const obj = asRecord(raw, "sync config");
  const spec: SyncSpec = {};

  if (typeof obj.hub_url === "string" && obj.hub_url.trim()) {
    spec.hub_url = obj.hub_url.trim().replace(/\/+$/, "");
  }

  if (obj.auto_register !== undefined && obj.auto_register !== null) {
    if (typeof obj.auto_register !== "boolean") {
      throw new TypeError("auto_register must be a boolean");
    }
    spec.auto_register = obj.auto_register;
  }

  if (obj.nodes !== undefined && obj.nodes !== null) {
    if (!Array.isArray(obj.nodes)) {
      throw new TypeError("nodes must be an array");
    }
    const seen = new Set<string>();
    spec.nodes = obj.nodes.map((entry, idx) => {
      const node = asRecord(entry, `nodes[${idx}]`);
      if (typeof node.id !== "string" || !node.id.trim()) {
        throw new Error(`nodes[${idx}].id must be a non-empty string`);
      }
      const id = node.id.trim();
      if (seen.has(id)) {
        throw new Error(`nodes[${idx}].id duplicate "${id}"`);
      }
      seen.add(id);
      if (
        node.is_public !== undefined &&
        node.is_public !== null &&
        typeof node.is_public !== "boolean"
      ) {
        throw new Error(`nodes[${idx}].is_public must be a boolean`);
      }

      return {
        id,
        ...(node.is_public === undefined || node.is_public === null
          ? {}
          : { is_public: node.is_public }),
      };
    });
  }

  if (obj.monitors !== undefined && obj.monitors !== null) {
    if (!Array.isArray(obj.monitors)) {
      throw new TypeError("monitors must be an array");
    }
    const seen = new Set<string>();
    spec.monitors = obj.monitors.map((entry, idx) => {
      const mon = asRecord(entry, `monitors[${idx}]`);
      if (typeof mon.id !== "string" || !mon.id.trim()) {
        throw new Error(`monitors[${idx}].id is required for declarative sync`);
      }
      const normalized = parseMonitorInput(mon);
      if (seen.has(normalized.id)) {
        throw new Error(`monitors[${idx}].id duplicate "${normalized.id}"`);
      }
      seen.add(normalized.id);

      return normalized;
    });
  }

  return spec;
}

function diffMonitor(
  current: MonitorSummary,
  desired: NormalizedSyncMonitor,
): string[] {
  const changes: string[] = [];
  for (const field of MONITOR_COMPARE_FIELDS) {
    if (current[field] !== desired[field]) {
      changes.push(
        `${field}: ${JSON.stringify(current[field])} -> ${JSON.stringify(desired[field])}`,
      );
    }
  }

  return changes;
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, idx) => item === b[idx]);

export function computeSyncPlan(
  current: DashboardSnapshot,
  spec: SyncSpec,
  options: { prune?: boolean } = {},
): SyncPlan {
  const prune = options.prune ?? false;

  const settingsPatch =
    spec.auto_register !== undefined &&
    spec.auto_register !== current.settings.auto_register
      ? { auto_register: spec.auto_register }
      : null;

  const nodePatches: NodeVisibilityPatch[] = [];
  const missingNodes: string[] = [];
  const managedNodeConflicts: ManagedNodeConflict[] = [];
  let nodeOrder: string[] | null = null;

  if (spec.nodes !== undefined) {
    const currentNodesById = new Map(current.nodes.map((n) => [n.id, n]));
    const declaredExistingNodeIds: string[] = [];
    const declaredSet = new Set<string>();

    for (const declared of spec.nodes) {
      const existing = currentNodesById.get(declared.id);
      if (!existing) {
        missingNodes.push(declared.id);

        continue;
      }
      declaredExistingNodeIds.push(declared.id);
      declaredSet.add(declared.id);
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
          nodePatches.push({
            id: declared.id,
            from: existing.is_public,
            to: declared.is_public,
          });
        }
      }
    }

    const currentNodeIds = current.nodes.map((n) => n.id);
    const desiredNodeOrder = [
      ...declaredExistingNodeIds,
      ...currentNodeIds.filter((id) => !declaredSet.has(id)),
    ];
    if (
      desiredNodeOrder.length > 0 &&
      !sameOrder(currentNodeIds, desiredNodeOrder)
    ) {
      nodeOrder = desiredNodeOrder;
    }
  }

  const monitorsCreate: NormalizedSyncMonitor[] = [];
  const monitorsUpdate: MonitorUpdate[] = [];
  const monitorsDelete: MonitorRef[] = [];
  const unmanagedMonitors: MonitorRef[] = [];
  const managedMonitorConflicts: ManagedMonitorConflict[] = [];
  let monitorOrder: string[] | null = null;

  if (spec.monitors !== undefined) {
    const currentMonitorsById = new Map(current.monitors.map((m) => [m.id, m]));
    const declaredSet = new Set<string>();
    const declaredOrderIds: string[] = [];

    for (const desired of spec.monitors) {
      declaredSet.add(desired.id);
      const existing = currentMonitorsById.get(desired.id);
      if (!existing) {
        monitorsCreate.push(desired);
        declaredOrderIds.push(desired.id);

        continue;
      }
      if (existing.managed_by_node_id) {
        managedMonitorConflicts.push({
          id: desired.id,
          nodeId: existing.managed_by_node_id,
        });

        continue;
      }
      declaredOrderIds.push(desired.id);
      const changes = diffMonitor(existing, desired);
      if (changes.length > 0) {
        monitorsUpdate.push({ monitor: desired, changes });
      }
    }

    const deletedSet = new Set<string>();
    for (const existing of current.monitors) {
      if (declaredSet.has(existing.id) || existing.managed_by_node_id) {
        continue;
      }
      if (prune) {
        monitorsDelete.push({ id: existing.id, name: existing.name });
        deletedSet.add(existing.id);
      } else {
        unmanagedMonitors.push({ id: existing.id, name: existing.name });
      }
    }

    const survivingExistingIds = current.monitors
      .map((m) => m.id)
      .filter((id) => !deletedSet.has(id));
    const orderWithoutReorder = [
      ...survivingExistingIds,
      ...monitorsCreate.map((m) => m.id),
    ];
    const desiredMonitorOrder = [
      ...declaredOrderIds,
      ...survivingExistingIds.filter((id) => !declaredSet.has(id)),
    ];
    if (
      desiredMonitorOrder.length > 0 &&
      !sameOrder(orderWithoutReorder, desiredMonitorOrder)
    ) {
      monitorOrder = desiredMonitorOrder;
    }
  }

  const hasChanges =
    settingsPatch !== null ||
    nodePatches.length > 0 ||
    nodeOrder !== null ||
    monitorsCreate.length > 0 ||
    monitorsUpdate.length > 0 ||
    monitorsDelete.length > 0 ||
    monitorOrder !== null;

  const hasConflicts =
    managedNodeConflicts.length > 0 || managedMonitorConflicts.length > 0;

  return {
    settingsPatch,
    nodePatches,
    missingNodes,
    managedNodeConflicts,
    nodeOrder,
    monitorsCreate,
    monitorsUpdate,
    monitorsDelete,
    unmanagedMonitors,
    managedMonitorConflicts,
    monitorOrder,
    hasChanges,
    hasConflicts,
  };
}

export function renderSyncPlan(
  theme: Theme,
  plan: SyncPlan,
  options: { dryRun?: boolean } = {},
): string {
  const lines: string[] = [];

  if (plan.settingsPatch) {
    lines.push(renderSection(theme, "Settings"));
    lines.push(
      `  ${theme.warn("~")} auto_register ${theme.muted("->")} ${theme.bold(String(plan.settingsPatch.auto_register))}`,
    );
  }

  if (
    plan.nodePatches.length > 0 ||
    plan.nodeOrder !== null ||
    plan.missingNodes.length > 0 ||
    plan.managedNodeConflicts.length > 0
  ) {
    lines.push(renderSection(theme, "Nodes"));
    for (const patch of plan.nodePatches) {
      lines.push(
        `  ${theme.warn("~")} ${theme.bold(patch.id)}  ${theme.muted(`is_public: ${patch.from} ->`)} ${patch.to ? theme.accent("true") : theme.muted("false")}`,
      );
    }
    if (plan.nodeOrder) {
      lines.push(
        `  ${theme.warn("~")} ${theme.bold("order")}  ${theme.muted(plan.nodeOrder.join(" -> "))}`,
      );
    }
    for (const id of plan.missingNodes) {
      lines.push(
        `  ${theme.warn("!")} ${theme.bold(id)}  ${theme.muted("not registered on hub (skipped)")}`,
      );
    }
    for (const conflict of plan.managedNodeConflicts) {
      lines.push(
        `  ${theme.error("!")} ${theme.bold(conflict.id)}  ${theme.error(`is_public is managed by agent (current=${conflict.current}, declared=${conflict.declared})`)}`,
      );
    }
  }

  if (
    plan.monitorsCreate.length > 0 ||
    plan.monitorsUpdate.length > 0 ||
    plan.monitorsDelete.length > 0 ||
    plan.monitorOrder !== null ||
    plan.unmanagedMonitors.length > 0 ||
    plan.managedMonitorConflicts.length > 0
  ) {
    lines.push(renderSection(theme, "Monitors"));
    for (const mon of plan.monitorsCreate) {
      lines.push(
        `  ${theme.success("+")} ${theme.bold(mon.id)}  ${mon.name} ${theme.muted(`(${mon.method} ${mon.url})`)}`,
      );
    }
    for (const { monitor, changes } of plan.monitorsUpdate) {
      lines.push(
        `  ${theme.warn("~")} ${theme.bold(monitor.id)}  ${monitor.name}`,
      );
      for (const change of changes) {
        lines.push(`      ${theme.muted(change)}`);
      }
    }
    for (const mon of plan.monitorsDelete) {
      lines.push(
        `  ${theme.error("-")} ${theme.bold(mon.id)}  ${theme.muted(mon.name)}`,
      );
    }
    if (plan.monitorOrder) {
      lines.push(
        `  ${theme.warn("~")} ${theme.bold("order")}  ${theme.muted(plan.monitorOrder.join(" -> "))}`,
      );
    }
    for (const mon of plan.unmanagedMonitors) {
      lines.push(
        `  ${theme.muted("?")} ${theme.muted(mon.id)}  ${theme.muted(`${mon.name} (unmanaged; pass --prune to remove)`)}`,
      );
    }
    for (const conflict of plan.managedMonitorConflicts) {
      lines.push(
        `  ${theme.error("!")} ${theme.bold(conflict.id)}  ${theme.error(`managed by node "${conflict.nodeId}"`)}`,
      );
    }
  }

  if (!plan.hasChanges && !plan.hasConflicts) {
    lines.push(
      `\n  ${theme.success("✓")} ${theme.bold("In sync")} ${theme.muted("(0 changes)")}`,
    );
  } else if (options.dryRun) {
    const parts = [
      plan.monitorsCreate.length > 0 && `+${plan.monitorsCreate.length} create`,
      plan.monitorsUpdate.length +
        plan.nodePatches.length +
        (plan.settingsPatch ? 1 : 0) >
        0 &&
        `~${plan.monitorsUpdate.length + plan.nodePatches.length + (plan.settingsPatch ? 1 : 0)} update`,
      plan.monitorsDelete.length > 0 && `-${plan.monitorsDelete.length} delete`,
      (plan.nodeOrder ? 1 : 0) + (plan.monitorOrder ? 1 : 0) > 0 && "reorder",
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
        (c) => `monitor "${c.id}" is managed by node "${c.nodeId}"`,
      ),
    ];

    throw new Error(
      `Sync blocked by agent-managed conflicts: ${reasons.join("; ")}`,
    );
  }

  if (plan.settingsPatch) {
    await request("PATCH", "/api/v1/admin/settings", plan.settingsPatch);
  }

  for (const patch of plan.nodePatches) {
    await request(
      "PATCH",
      `/api/v1/admin/nodes/${encodeURIComponent(patch.id)}`,
      {
        is_public: patch.to,
      },
    );
  }

  if (plan.nodeOrder) {
    await request("PUT", "/api/v1/admin/nodes/order", { ids: plan.nodeOrder });
  }

  for (const mon of plan.monitorsCreate) {
    await request("POST", "/api/v1/admin/monitors", mon);
  }

  for (const { monitor } of plan.monitorsUpdate) {
    await request("POST", "/api/v1/admin/monitors", monitor);
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
}
