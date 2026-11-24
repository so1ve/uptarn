import {
  generateRandomToken,
  sha256Hex,
  timingSafeEqualText,
} from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { httpError } from "../http.ts";
import type { NodeMonitorSpec, NodeReportPayload } from "../shared/index.ts";
import {
  formatBytes,
  formatSeriesValue,
  memPercent,
  round1,
  unixNow,
} from "../shared/index.ts";
import type { AlertObservation, AlertStateRow } from "./alerts.ts";
import { ALERT_STATE_COLUMNS, buildAlertStatements } from "./alerts.ts";
import type { MonitorConfigFields } from "./monitors.ts";
import { buildMonitorUpsertStatements } from "./monitors.ts";
import type { SettingRow } from "./settings.ts";
import { SELECT_SETTINGS_SQL, parseRuntimeSettings } from "./settings.ts";

interface NodeIngestRow {
  id: string;
  label: string;
  token_hash: string;
  interval_secs: number;
  grace_secs: number;
  muted_until: number;
  is_public: number;
  prev_rx_bytes: number | null;
  prev_tx_bytes: number | null;
  prev_net_at: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
}

const MONITOR_DIFF_KEYS = [
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
] as const satisfies readonly (keyof MonitorConfigFields)[];

async function issueNodeToken() {
  const token = generateRandomToken("uptn_node");

  return { token, hash: await sha256Hex(token) };
}

export async function createNode(
  db: SqlDatabase,
  input: {
    id: string;
    label?: string;
    interval_secs?: number;
    grace_secs?: number;
    is_public?: boolean;
  },
): Promise<{ id: string; label: string; token: string }> {
  const { token, hash } = await issueNodeToken();
  const label = input.label?.trim() || input.id;
  const res = await db.run(
    `INSERT OR IGNORE INTO nodes (id, label, token_hash, interval_secs, grace_secs, is_public, sort_order, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE((SELECT MAX(sort_order) + 1 FROM nodes), 0), ?7)`,
    [
      input.id,
      label,
      hash,
      input.interval_secs ?? 60,
      input.grace_secs ?? 120,
      input.is_public ? 1 : 0,
      unixNow(),
    ],
  );
  if (res.changes === 0) {
    throw httpError(409, `Node "${input.id}" already exists`);
  }

  return { id: input.id, label, token };
}

export async function updateNode(
  db: SqlDatabase,
  nodeId: string,
  patch: { is_public?: boolean; primary_mount?: string | null },
): Promise<boolean> {
  const existing = await db.first<{ public_managed: number }>(
    "SELECT public_managed FROM nodes WHERE id = ?1",
    [nodeId],
  );
  if (!existing) {
    return false;
  }
  if (patch.is_public !== undefined && existing.public_managed === 1) {
    throw httpError(409, `Node "${nodeId}" visibility is managed by its agent`);
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.is_public !== undefined) {
    params.push(patch.is_public ? 1 : 0);
    sets.push(`is_public = ?${params.length}`);
  }
  if (patch.primary_mount !== undefined) {
    params.push(patch.primary_mount);
    sets.push(`primary_mount = ?${params.length}`);
  }
  params.push(nodeId);
  const res = await db.run(
    `UPDATE nodes SET ${sets.join(", ")} WHERE id = ?${params.length}`,
    params,
  );

  return res.changes > 0;
}

export async function rotateNodeToken(
  db: SqlDatabase,
  nodeId: string,
): Promise<{ id: string; token: string }> {
  const { token, hash } = await issueNodeToken();
  const res = await db.run("UPDATE nodes SET token_hash = ?1 WHERE id = ?2", [
    hash,
    nodeId,
  ]);
  if (res.changes === 0) {
    throw httpError(404, `Node "${nodeId}" not found`);
  }

  return { id: nodeId, token };
}

function buildManagedMonitorStatements(
  nodeId: string,
  specs: readonly NodeMonitorSpec[],
  existing: readonly MonitorConfigFields[],
  now: number,
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const nextIds = new Set<string>();

  for (const spec of specs) {
    const minStatus = spec.expected_status_min ?? 200;
    const next: MonitorConfigFields = {
      id: `${nodeId}:${spec.key}`.slice(0, 64),
      name: spec.name,
      url: spec.url,
      public_url: spec.public_url ?? null,
      method: spec.method ?? "GET",
      expected_status_min: minStatus,
      expected_status_max: spec.expected_status_max ?? Math.max(299, minStatus),
      expected_body: spec.expected_body ?? null,
      timeout_ms: spec.timeout_ms ?? 8000,
      interval_secs: spec.interval_secs ?? 60,
      enabled: (spec.enabled ?? true) ? 1 : 0,
      is_public: (spec.is_public ?? true) ? 1 : 0,
    };
    nextIds.add(next.id);
    const prev = existingById.get(next.id);
    if (prev && MONITOR_DIFF_KEYS.every((k) => prev[k] === next[k])) {
      continue;
    }
    statements.push(...buildMonitorUpsertStatements(next, now, nodeId));
  }

  for (const prev of existing) {
    if (!nextIds.has(prev.id)) {
      statements.push(
        {
          sql: "DELETE FROM alert_states WHERE target_type = 'monitor' AND target_id = ?1",
          params: [prev.id],
        },
        {
          sql: "DELETE FROM monitors WHERE id = ?1 AND managed_by_node_id = ?2",
          params: [prev.id, nodeId],
        },
      );
    }
  }

  return statements;
}

function computeNetworkRates(
  node: NodeIngestRow | null,
  rxBytes: number | null,
  txBytes: number | null,
  now: number,
): { rxBps: number | null; txBps: number | null } {
  if (rxBytes === null || txBytes === null || !node) {
    return { rxBps: null, txBps: null };
  }
  if (
    node.prev_rx_bytes !== null &&
    node.prev_tx_bytes !== null &&
    node.prev_net_at !== null &&
    now > node.prev_net_at &&
    rxBytes >= node.prev_rx_bytes &&
    txBytes >= node.prev_tx_bytes
  ) {
    const dt = now - node.prev_net_at;

    return {
      rxBps: (rxBytes - node.prev_rx_bytes) / dt,
      txBps: (txBytes - node.prev_tx_bytes) / dt,
    };
  }

  return { rxBps: node.rx_bps, txBps: node.tx_bps };
}

export async function ingestNodeReport(
  db: SqlDatabase,
  config: LoadedConfig,
  payload: NodeReportPayload,
  bearerToken: string,
  enrollHeader?: string,
): Promise<{ registered: boolean }> {
  const now = unixNow();
  const batchQueries: SqlStatement[] = [
    { sql: SELECT_SETTINGS_SQL },
    {
      sql: `SELECT id, label, token_hash, interval_secs, grace_secs, muted_until, is_public,
                   prev_rx_bytes, prev_tx_bytes, prev_net_at, rx_bps, tx_bps
            FROM nodes WHERE id = ?1`,
      params: [payload.node_id],
    },
    {
      sql: `SELECT ${ALERT_STATE_COLUMNS} FROM alert_states WHERE target_type = 'node' AND target_id = ?1`,
      params: [payload.node_id],
    },
  ];
  if (payload.monitors !== undefined) {
    batchQueries.push({
      sql: `SELECT id, name, url, public_url, method, expected_status_min, expected_status_max,
                   expected_body, timeout_ms, interval_secs, enabled, is_public
            FROM monitors WHERE managed_by_node_id = ?1`,
      params: [payload.node_id],
    });
  }

  const [incomingHash, batchResults] = await Promise.all([
    sha256Hex(bearerToken),
    db.allBatch(batchQueries),
  ]);
  const [settingRows, nodeRows, existingAlertStates, managedMonitorRows = []] =
    batchResults as [
      SettingRow[],
      NodeIngestRow[],
      AlertStateRow[],
      MonitorConfigFields[]?,
    ];

  const settings = parseRuntimeSettings(settingRows, config);
  const existing = nodeRows[0] ?? null;

  if (existing) {
    if (!(await timingSafeEqualText(incomingHash, existing.token_hash))) {
      throw httpError(401, "Invalid node token");
    }
  } else {
    if (!settings.autoRegister) {
      throw httpError(
        401,
        "Node is not registered and auto-registration is off",
      );
    }
    if (!settings.enrollmentToken) {
      throw httpError(
        401,
        "Enrollment token is not configured for auto-registration",
      );
    }
    const candidateEnroll = enrollHeader?.trim() || bearerToken;
    if (
      !(await timingSafeEqualText(candidateEnroll, settings.enrollmentToken))
    ) {
      throw httpError(401, "Invalid enrollment token for auto-registration");
    }
  }

  const nodeId = payload.node_id;
  const label = payload.label ?? existing?.label ?? nodeId;
  const intervalSecs = payload.interval_secs ?? existing?.interval_secs ?? 60;
  const graceSecs = payload.grace_secs ?? existing?.grace_secs ?? 120;
  const mutedUntil = existing?.muted_until ?? 0;
  const rxBytes = payload.system?.rx_bytes ?? null;
  const txBytes = payload.system?.tx_bytes ?? null;
  const { rxBps, txBps } = computeNetworkRates(existing, rxBytes, txBytes, now);

  const mounts = payload.mounts ?? [];
  const checks = payload.checks ?? [];
  const series = payload.series ?? [];
  const info = payload.info ?? [];
  const publicManaged = payload.is_public === undefined ? 0 : 1;
  const isPublic =
    payload.is_public === undefined
      ? (existing?.is_public ?? 0)
      : payload.is_public
        ? 1
        : 0;

  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO nodes (
              id, label, token_hash, interval_secs, grace_secs, is_public, public_managed, sort_order, created_at,
              last_seen_at, prev_rx_bytes, prev_tx_bytes, prev_net_at,
              rx_bps, tx_bps, system_json, mounts_json, checks_json, series_json, info_json, agent_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE((SELECT MAX(sort_order) + 1 FROM nodes), 0), ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
            ON CONFLICT(id) DO UPDATE SET
              label = excluded.label,
              interval_secs = excluded.interval_secs,
              grace_secs = excluded.grace_secs,
              is_public = CASE WHEN excluded.public_managed = 1 THEN excluded.is_public ELSE nodes.is_public END,
              public_managed = excluded.public_managed,
              last_seen_at = excluded.last_seen_at,
              prev_rx_bytes = excluded.prev_rx_bytes,
              prev_tx_bytes = excluded.prev_tx_bytes,
              prev_net_at = COALESCE(excluded.prev_net_at, nodes.prev_net_at),
              rx_bps = excluded.rx_bps,
              tx_bps = excluded.tx_bps,
              system_json = excluded.system_json,
              mounts_json = excluded.mounts_json,
              checks_json = excluded.checks_json,
              series_json = excluded.series_json,
              info_json = excluded.info_json,
              agent_version = COALESCE(excluded.agent_version, nodes.agent_version)`,
      params: [
        nodeId,
        label,
        incomingHash,
        intervalSecs,
        graceSecs,
        isPublic,
        publicManaged,
        now,
        now,
        rxBytes,
        txBytes,
        rxBytes === null ? null : now,
        rxBps,
        txBps,
        payload.system ? JSON.stringify(payload.system) : null,
        JSON.stringify(mounts),
        JSON.stringify(checks),
        JSON.stringify(series),
        JSON.stringify(info),
        payload.agent_version ?? null,
      ],
    },
  ];
  if (payload.monitors !== undefined) {
    statements.push(
      ...buildManagedMonitorStatements(
        nodeId,
        payload.monitors,
        managedMonitorRows,
        now,
      ),
    );
  }

  const sampleValues: Record<string, number | [number, number]> = {};
  if (payload.system?.cpu_pct !== undefined) {
    sampleValues._cpu = round1(payload.system.cpu_pct);
  }
  const memPct = memPercent(payload.system ?? null);
  if (memPct !== null) {
    sampleValues._mem = round1(memPct);
  }
  if (rxBps !== null) {
    sampleValues._rx_bps = round1(rxBps);
  }
  if (txBps !== null) {
    sampleValues._tx_bps = round1(txBps);
  }
  for (const item of series) {
    const val = round1(item.value);
    sampleValues[item.key] =
      item.loss_pct === undefined ? val : [val, round1(item.loss_pct)];
  }
  if (Object.keys(sampleValues).length > 0) {
    statements.push({
      sql: "INSERT OR REPLACE INTO node_samples (node_id, ts, values_json) VALUES (?1, ?2, ?3)",
      params: [nodeId, Math.floor(now / 60) * 60, JSON.stringify(sampleValues)],
    });
  }

  const nodeObs = (
    suffix: string,
    subLabel: string,
    failing: boolean,
    summary: string,
    threshold = config.failureThreshold,
  ): AlertObservation => ({
    incidentKey: `node:${nodeId}:${suffix}`,
    targetType: "node",
    targetId: nodeId,
    label: `${label}: ${subLabel}`,
    failing,
    summary,
    threshold,
    targetMutedUntil: mutedUntil,
  });

  const observations: AlertObservation[] = [
    nodeObs("offline", "Connectivity", false, "Node online", 1),
    ...mounts.map((m) =>
      nodeObs(
        `mount:${m.path}`,
        m.label ?? m.path,
        m.status === "fail",
        m.summary ??
          `${formatBytes(m.used_bytes)} / ${formatBytes(m.total_bytes)} (${m.total_bytes > 0 ? `${((m.used_bytes / m.total_bytes) * 100).toFixed(1)}%` : "0%"})`,
      ),
    ),
    ...checks.map((c) =>
      nodeObs(
        `check:${c.key}`,
        c.label,
        c.status === "fail",
        c.summary ?? c.status,
      ),
    ),
    ...series
      .filter((s) => s.status !== undefined)
      .map((s) =>
        nodeObs(
          `series:${s.key}`,
          s.label,
          s.status === "fail",
          s.summary ??
            `${formatSeriesValue(s.value, s.unit)}${s.loss_pct === undefined ? "" : `, ${s.loss_pct.toFixed(0)}% loss`}`,
        ),
      ),
  ];

  statements.push(
    ...(await buildAlertStatements(
      config,
      observations,
      existingAlertStates,
      settings.globalMutedUntil,
      now,
      true,
    )),
  );

  await db.batch(statements);

  return { registered: existing === null };
}
