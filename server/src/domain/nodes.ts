import {
  generateRandomToken,
  sha256Hex,
  timingSafeEqualText,
} from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { httpError } from "../http.ts";
import type { NodeReportPayload } from "../shared/index.ts";
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
  rx_bps: number | null;
  tx_bps: number | null;
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
    `INSERT OR IGNORE INTO nodes (id, label, token_hash, interval_secs, grace_secs, is_public, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
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

export async function setNodePublic(
  db: SqlDatabase,
  nodeId: string,
  isPublic: boolean,
): Promise<boolean> {
  const res = await db.run("UPDATE nodes SET is_public = ?1 WHERE id = ?2", [
    isPublic ? 1 : 0,
    nodeId,
  ]);

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
  const [incomingHash, [settingRows, nodeRows, existingAlertStates]] =
    await Promise.all([
      sha256Hex(bearerToken),
      db.allBatch([
        { sql: SELECT_SETTINGS_SQL },
        {
          sql: `SELECT id, label, token_hash, interval_secs, grace_secs, muted_until,
                       prev_rx_bytes, prev_tx_bytes, prev_net_at, rx_bps, tx_bps
                FROM nodes WHERE id = ?1`,
          params: [payload.node_id],
        },
        {
          sql: `SELECT ${ALERT_STATE_COLUMNS} FROM alert_states WHERE target_type = 'node' AND target_id = ?1`,
          params: [payload.node_id],
        },
      ]) as Promise<[SettingRow[], NodeIngestRow[], AlertStateRow[]]>,
    ]);

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

  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO nodes (
              id, label, token_hash, interval_secs, grace_secs, created_at,
              last_seen_at, prev_rx_bytes, prev_tx_bytes, prev_net_at,
              rx_bps, tx_bps, system_json, mounts_json, checks_json, series_json, info_json, agent_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
            ON CONFLICT(id) DO UPDATE SET
              label = excluded.label,
              interval_secs = excluded.interval_secs,
              grace_secs = excluded.grace_secs,
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

  const sampleBucketTs = Math.floor(now / 60) * 60;
  function pushSample(key: string, value: number, aux: number | null = null) {
    statements.push({
      sql: `INSERT OR REPLACE INTO series_samples (node_id, series_key, ts, value, aux_value)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      params: [nodeId, key, sampleBucketTs, value, aux],
    });
  }

  if (payload.system?.cpu_pct !== undefined) {
    pushSample("_cpu", payload.system.cpu_pct);
  }
  if (
    payload.system?.mem_used_bytes !== undefined &&
    payload.system.mem_total_bytes !== undefined &&
    payload.system.mem_total_bytes > 0
  ) {
    pushSample(
      "_mem",
      (payload.system.mem_used_bytes / payload.system.mem_total_bytes) * 100,
    );
  }
  for (const item of series) {
    pushSample(item.key, item.value, item.loss_pct ?? null);
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
