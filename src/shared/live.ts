import { memPercent, round1 } from "./format.ts";

export const MAX_LIVE_POINTS = 100;
export const MIN_LIVE_INTERVAL_SECS = 1;
export const STALE_LIVE_NODE_SECS = 600;
export const MAX_LIVE_FRAME_BYTES = 4096;

export interface LiveIngestFrame {
  uptime_secs: number;
  cpu_pct?: number;
  load_1m?: number;
  mem_used_bytes?: number;
  mem_total_bytes?: number;
  rx_bytes?: number;
  tx_bytes?: number;
}

export interface LiveNodeSample {
  node_id: string;
  ts: number;
  uptime_secs: number;
  cpu_pct?: number;
  load_1m?: number;
  mem_used_bytes?: number;
  mem_total_bytes?: number;
  rx_bps: number | null;
  tx_bps: number | null;
}

export interface PublicLiveNodeSample {
  key: string;
  ts: number;
  uptime_secs: number;
  cpu_pct: number | null;
  mem_pct: number | null;
}

export type AdminLiveMessage =
  | { type: "init"; nodes: Record<string, LiveNodeSample[]> }
  | { type: "tick"; sample: LiveNodeSample };

export type PublicLiveMessage =
  | { type: "init"; nodes: Record<string, PublicLiveNodeSample[]> }
  | { type: "tick"; sample: PublicLiveNodeSample };

function finiteNum(value: unknown, min = 0, max?: number): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < min || (max !== undefined && value > max)) {
    return undefined;
  }

  return value;
}

export function parseLiveIngestFrame(raw: string): LiveIngestFrame | null {
  if (raw.length === 0 || raw.length > MAX_LIVE_FRAME_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const uptime = finiteNum(obj.uptime_secs, 0);
  if (uptime === undefined) {
    return null;
  }
  const cpuPct = finiteNum(obj.cpu_pct, 0, 100);
  const load1m = finiteNum(obj.load_1m, 0);
  const memUsed = finiteNum(obj.mem_used_bytes, 0);
  const memTotal = finiteNum(obj.mem_total_bytes, 0);
  const rxBytes = finiteNum(obj.rx_bytes, 0);
  const txBytes = finiteNum(obj.tx_bytes, 0);

  return {
    uptime_secs: Math.floor(uptime),
    ...(cpuPct === undefined ? {} : { cpu_pct: round1(cpuPct) }),
    ...(load1m === undefined
      ? {}
      : { load_1m: Math.round(load1m * 100) / 100 }),
    ...(memUsed === undefined ? {} : { mem_used_bytes: Math.floor(memUsed) }),
    ...(memTotal === undefined
      ? {}
      : { mem_total_bytes: Math.floor(memTotal) }),
    ...(rxBytes === undefined ? {} : { rx_bytes: Math.floor(rxBytes) }),
    ...(txBytes === undefined ? {} : { tx_bytes: Math.floor(txBytes) }),
  };
}

function toPublicLiveSample(
  publicKey: string,
  sample: LiveNodeSample,
): PublicLiveNodeSample {
  const rawMem = memPercent({
    uptime_secs: sample.uptime_secs,
    mem_used_bytes: sample.mem_used_bytes,
    mem_total_bytes: sample.mem_total_bytes,
  });

  return {
    key: publicKey,
    ts: sample.ts,
    uptime_secs: sample.uptime_secs,
    cpu_pct: sample.cpu_pct ?? null,
    mem_pct: rawMem === null ? null : round1(rawMem),
  };
}

interface NodeLiveEntry {
  publicKey: string;
  isPublic: boolean;
  lastTs: number;
  prevRxBytes: number | null;
  prevTxBytes: number | null;
  prevNetTs: number | null;
  rxBps: number | null;
  txBps: number | null;
  samples: LiveNodeSample[];
}

export class LiveStateBuffer {
  private readonly nodes = new Map<string, NodeLiveEntry>();

  public ingest(
    nodeId: string,
    publicKey: string,
    isPublic: boolean,
    frame: LiveIngestFrame,
    nowSecs: number,
  ): { admin: LiveNodeSample; pub: PublicLiveNodeSample | null } | null {
    const prev = this.nodes.get(nodeId);
    if (prev && nowSecs - prev.lastTs < MIN_LIVE_INTERVAL_SECS) {
      return null;
    }

    const rxBytes = frame.rx_bytes ?? null;
    const txBytes = frame.tx_bytes ?? null;
    let rxBps: number | null = prev?.rxBps ?? null;
    let txBps: number | null = prev?.txBps ?? null;

    if (rxBytes !== null && txBytes !== null) {
      if (prev) {
        const { prevRxBytes, prevTxBytes, prevNetTs } = prev;
        if (
          prevRxBytes !== null &&
          prevTxBytes !== null &&
          prevNetTs !== null &&
          nowSecs > prevNetTs &&
          rxBytes >= prevRxBytes &&
          txBytes >= prevTxBytes
        ) {
          const dt = nowSecs - prevNetTs;
          rxBps = round1((rxBytes - prevRxBytes) / dt);
          txBps = round1((txBytes - prevTxBytes) / dt);
        }
      }
    } else {
      rxBps = null;
      txBps = null;
    }

    const sample: LiveNodeSample = {
      node_id: nodeId,
      ts: nowSecs,
      uptime_secs: frame.uptime_secs,
      ...(frame.cpu_pct === undefined ? {} : { cpu_pct: frame.cpu_pct }),
      ...(frame.load_1m === undefined ? {} : { load_1m: frame.load_1m }),
      ...(frame.mem_used_bytes === undefined
        ? {}
        : { mem_used_bytes: frame.mem_used_bytes }),
      ...(frame.mem_total_bytes === undefined
        ? {}
        : { mem_total_bytes: frame.mem_total_bytes }),
      rx_bps: rxBps,
      tx_bps: txBps,
    };

    const samples = prev ? prev.samples : [];
    samples.push(sample);
    if (samples.length > MAX_LIVE_POINTS) {
      samples.splice(0, samples.length - MAX_LIVE_POINTS);
    }

    this.nodes.set(nodeId, {
      publicKey,
      isPublic,
      lastTs: nowSecs,
      prevRxBytes: rxBytes,
      prevTxBytes: txBytes,
      prevNetTs:
        rxBytes !== null && txBytes !== null
          ? nowSecs
          : (prev?.prevNetTs ?? null),
      rxBps,
      txBps,
      samples,
    });

    return {
      admin: sample,
      pub: isPublic ? toPublicLiveSample(publicKey, sample) : null,
    };
  }

  public setNodeVisibility(
    nodeId: string,
    publicKey: string,
    isPublic: boolean,
  ): void {
    const entry = this.nodes.get(nodeId);
    if (entry) {
      entry.publicKey = publicKey;
      entry.isPublic = isPublic;
    }
  }

  public removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
  }

  public prune(nowSecs: number): void {
    const cutoff = nowSecs - STALE_LIVE_NODE_SECS;
    for (const [nodeId, entry] of this.nodes) {
      if (entry.lastTs < cutoff) {
        this.nodes.delete(nodeId);
      }
    }
  }

  public adminInitPayload(
    nowSecs: number,
  ): Extract<AdminLiveMessage, { type: "init" }> {
    this.prune(nowSecs);
    const nodes: Record<string, LiveNodeSample[]> = {};
    for (const [nodeId, entry] of this.nodes) {
      nodes[nodeId] = entry.samples;
    }

    return { type: "init", nodes };
  }

  public publicInitPayload(
    nowSecs: number,
  ): Extract<PublicLiveMessage, { type: "init" }> {
    this.prune(nowSecs);
    const nodes: Record<string, PublicLiveNodeSample[]> = {};
    for (const entry of this.nodes.values()) {
      if (!entry.isPublic) {
        continue;
      }
      nodes[entry.publicKey] = entry.samples.map((s) =>
        toPublicLiveSample(entry.publicKey, s),
      );
    }

    return { type: "init", nodes };
  }
}
