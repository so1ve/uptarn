import {
  generateRandomToken,
  sha256Hex,
  timingSafeEqualText,
} from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { httpError } from "../http.ts";
import type { NodeMonitorSpec, NodeReportPayload } from "../shared/index.ts";
import { formatBytes, formatSeriesValue, unixNow } from "../shared/index.ts";
import type { AlertObservation, AlertStateRow } from "./alerts.ts";
import { ALERT_STATE_COLUMNS, buildAlertStatements } from "./alerts.ts";
import type { SettingRow } from "./settings.ts";
import { SELECT_SETTINGS_SQL, parseRuntimeSettings } from "./settings.ts";

interface NodeIngestRow {
  id: string;
  label: string;
  token_hash: string;
  interval_secs: number;
  grace_secs: number;
  muted_until: number;
  prev_rx_bytes: number | null;
  prev_tx_bytes: number | null;
  prev_net_at: number | null;
  is_public: number;
  rx_bps: number | null;
  tx_bps: number | null;
}

interface ManagedMonitorRow {
  id: string;
  name: string;
  url: string;
  public_url: string | null;
  method: string;
  expected_status_min: number;
  expected_status_max: number;
  expected_body: string | null;
  timeout_ms: number;
  interval_secs: number;
  enabled: number;
  is_public: number;
}

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

export async function reorderNodes(
  db: SqlDatabase,
  ids: readonly string[],
): Promise<void> {
  await db.batch(
    ids.map((id, index) => ({
      sql: "UPDATE nodes SET sort_order = ?1 WHERE id = ?2",
      params: [index, id],
    })),
  );
}

export async function setNodePublic(
  db: SqlDatabase,
  nodeId: string,
  isPublic: boolean,
): Promise<boolean> {
  const existing = await db.first<{ public_managed: number }>(
    "SELECT public_managed FROM nodes WHERE id = ?1",
    [nodeId],
  );
  if (!existing) {
    return false;
  }
  if (existing.public_managed === 1) {
    throw httpError(409, `Node "${nodeId}" visibility is managed by its agent`);
  }
  const res = await db.run("UPDATE nodes SET is_public = ?1 WHERE id = ?2", [
    isPublic ? 1 : 0,
    nodeId,
  ]);

  return res.changes > 0;
}

function buildManagedMonitorStatements(
  nodeId: string,
  specs: readonly NodeMonitorSpec[],
  existing: readonly ManagedMonitorRow[],
  now: number,
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const nextIds = new Set<string>();

  for (const spec of specs) {
    const id = `${nodeId}:${spec.key}`.slice(0, 64);
    nextIds.add(id);
    const enabled = (spec.enabled ?? true) ? 1 : 0;
    const isPublic = (spec.is_public ?? true) ? 1 : 0;
    const method = spec.method ?? "GET";
    const minStatus = spec.expected_status_min ?? 200;
    const maxStatus = spec.expected_status_max ?? Math.max(299, minStatus);
    const publicUrl = spec.public_url ?? null;
    const body = spec.expected_body ?? null;
    const timeoutMs = spec.timeout_ms ?? 8000;
    const intervalSecs = spec.interval_secs ?? 60;

    const prev = existingById.get(id);
    const unchanged =
      prev?.name === spec.name &&
      prev.url === spec.url &&
      prev.public_url === publicUrl &&
      prev.method === method &&
      prev.expected_status_min === minStatus &&
      prev.expected_status_max === maxStatus &&
      prev.expected_body === body &&
      prev.timeout_ms === timeoutMs &&
      prev.interval_secs === intervalSecs &&
      prev.enabled === enabled &&
      prev.is_public === isPublic;

    if (unchanged) {
      continue;
    }

    statements.push({
      sql: `INSERT INTO monitors
            (id, name, url, public_url, method, expected_status_min, expected_status_max, expected_body, timeout_ms, interval_secs, enabled, is_public, managed_by_node_id, sort_order, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, COALESCE((SELECT MAX(sort_order) + 1 FROM monitors), 0), ?14)
            ON CONFLICT(id) DO UPDATE SET
              last_checked_at = CASE
                WHEN monitors.url != excluded.url
                  OR monitors.method != excluded.method
                  OR monitors.expected_status_min != excluded.expected_status_min
                  OR monitors.expected_status_max != excluded.expected_status_max
                  OR monitors.expected_body IS NOT excluded.expected_body
                THEN NULL
                ELSE monitors.last_checked_at
              END,
              name = excluded.name,
              url = excluded.url,
              public_url = excluded.public_url,
              method = excluded.method,
              expected_status_min = excluded.expected_status_min,
              expected_status_max = excluded.expected_status_max,
              expected_body = excluded.expected_body,
              timeout_ms = excluded.timeout_ms,
              interval_secs = excluded.interval_secs,
              enabled = excluded.enabled,
              is_public = excluded.is_public,
              managed_by_node_id = excluded.managed_by_node_id`,
      params: [
        id,
        spec.name,
        spec.url,
        publicUrl,
        method,
        minStatus,
        maxStatus,
        body,
        timeoutMs,
        intervalSecs,
        enabled,
        isPublic,
        nodeId,
        now,
      ],
    });
    if (enabled === 0) {
      statements.push({
        sql: "DELETE FROM alert_states WHERE target_type = 'monitor' AND target_id = ?1",
        params: [id],
      });
    }
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
      ManagedMonitorRow[]?,
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
              is_public = CASE
                WHEN excluded.public_managed = 1 THEN excluded.is_public
                ELSE nodes.is_public
              END,
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

  const sampleBucketTs = Math.floor(now / 60) * 60;
  const sampleValues: Record<string, number | [number, number]> = {};
  if (payload.system?.cpu_pct !== undefined) {
    sampleValues._cpu = Math.round(payload.system.cpu_pct * 10) / 10;
  }
  if (
    payload.system?.mem_used_bytes !== undefined &&
    payload.system.mem_total_bytes !== undefined &&
    payload.system.mem_total_bytes > 0
  ) {
    sampleValues._mem =
      Math.round(
        (payload.system.mem_used_bytes / payload.system.mem_total_bytes) * 1000,
      ) / 10;
  }
  if (rxBps !== null) {
    sampleValues._rx_bps = Math.round(rxBps * 10) / 10;
  }
  if (txBps !== null) {
    sampleValues._tx_bps = Math.round(txBps * 10) / 10;
  }
  for (const item of series) {
    sampleValues[item.key] =
      item.loss_pct === undefined ? item.value : [item.value, item.loss_pct];
  }
  if (Object.keys(sampleValues).length > 0) {
    statements.push({
      sql: `INSERT OR REPLACE INTO node_samples (node_id, ts, values_json)
            VALUES (?1, ?2, ?3)`,
      params: [nodeId, sampleBucketTs, JSON.stringify(sampleValues)],
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
    ...mounts.map((m) => {
      const pct =
        m.total_bytes > 0
          ? `${((m.used_bytes / m.total_bytes) * 100).toFixed(1)}%`
          : "0%";

      return nodeObs(
        `mount:${m.path}`,
        m.label ?? m.path,
        m.status === "fail",
        m.summary ??
          `${formatBytes(m.used_bytes)} / ${formatBytes(m.total_bytes)} (${pct})`,
      );
    }),
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
      .map((s) => {
        const lossNote =
          s.loss_pct === undefined ? "" : `, ${s.loss_pct.toFixed(0)}% loss`;

        return nodeObs(
          `series:${s.key}`,
          s.label,
          s.status === "fail",
          s.summary ?? `${formatSeriesValue(s.value, s.unit)}${lossNote}`,
        );
      }),
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
