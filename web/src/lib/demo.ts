import manifest from "../../../package.json" with { type: "json" };
import type {
  AlertEventSummary,
  BootPayload,
  DashboardSnapshot,
  JobSummary,
  MaintenanceInput,
  MaintenanceSummary,
  MonitorInput,
  MonitorRollupBucket,
  MonitorRollups,
  MonitorSample,
  MonitorSummary,
  NodeHistoryResponse,
  NodeSummary,
  PublicIncidentSummary,
  PublicMaintenanceSummary,
  PublicMonitorSummary,
  PublicNodeSummary,
  PublicStatusSnapshot,
  SeriesPoint,
  SiteLink,
} from "../../../src/shared/index.ts";
import {
  memPercent,
  round1,
  summarizeDisk,
  unixNow,
} from "../../../src/shared/index.ts";
import { ApiError } from "./api.ts";

function wave(seed: number, i: number, base: number, amp: number): number {
  const v =
    Math.sin(seed * 1.7 + i * 0.42) * 0.55 +
    Math.cos(seed * 0.9 + i * 0.21) * 0.45;

  return Math.max(0.5, round1(base + v * amp));
}

function buildNodeHistory(
  node: NodeSummary,
  now: number,
  windowSecs: number,
  points: number,
): Record<string, SeriesPoint[]> {
  const step = Math.max(60, Math.floor(windowSecs / points));
  const seed = [...node.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const hist: Record<string, SeriesPoint[]> = {};
  const cpuBase = node.system?.cpu_pct ?? null;
  const memBase = memPercent(node.system);

  for (let i = points - 1; i >= 0; i--) {
    const ts = Math.floor((now - i * step) / 60) * 60;
    if (cpuBase !== null) {
      (hist._cpu ??= []).push({
        ts,
        value: Math.min(
          99,
          wave(seed, i, cpuBase, Math.min(10, cpuBase * 0.4)),
        ),
        aux: null,
      });
    }
    if (memBase !== null) {
      (hist._mem ??= []).push({
        ts,
        value: Math.min(98, wave(seed + 11, i, memBase, 3.5)),
        aux: null,
      });
    }
    if (node.rx_bps !== null) {
      (hist._rx_bps ??= []).push({
        ts,
        value: Math.round(wave(seed + 23, i, node.rx_bps, node.rx_bps * 0.4)),
        aux: null,
      });
    }
    if (node.tx_bps !== null) {
      (hist._tx_bps ??= []).push({
        ts,
        value: Math.round(wave(seed + 31, i, node.tx_bps, node.tx_bps * 0.35)),
        aux: null,
      });
    }
    for (const s of node.series) {
      const val = wave(
        seed + 41 + s.key.length,
        i,
        s.value,
        Math.max(1.5, s.value * 0.14),
      );
      (hist[s.key] ??= []).push({
        ts,
        value: val,
        aux: s.loss_pct === undefined ? null : i === 18 ? 5 : 0,
      });
    }
  }

  return hist;
}

function buildMonitorHistory(
  now: number,
  seed: number,
  baseMs: number | null,
  failIndices: readonly number[],
): { samples: MonitorSample[]; rollups: MonitorRollups } {
  const failSet = new Set(failIndices);
  const samples: MonitorSample[] = [];
  for (let i = 47; i >= 0; i--) {
    const ts = Math.floor((now - i * 60) / 30) * 30;
    const ok = !failSet.has(i);
    samples.push({
      ts,
      ok,
      latency_ms:
        baseMs === null || !ok
          ? null
          : Math.round(wave(seed, i, baseMs, Math.max(3, baseMs * 0.22))),
    });
  }

  function makeBuckets(
    count: number,
    step: number,
    perBucket: number,
    failCount: number,
    offset: number,
  ): MonitorRollupBucket[] {
    const out: MonitorRollupBucket[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const ts = Math.floor((now - i * step) / step) * step;
      const fails = failSet.has(i) ? failCount : 0;
      out.push({
        ts,
        ok: perBucket - fails,
        total: perBucket,
        avg_ms:
          baseMs === null
            ? null
            : Math.round(
                wave(seed + offset, i, baseMs, Math.max(2, baseMs * 0.14)),
              ),
      });
    }

    return out;
  }

  return {
    samples,
    rollups: {
      m30: makeBuckets(48, 1800, 30, 3, 3),
      h6: makeBuckets(28, 21_600, 360, 4, 7),
      d1: makeBuckets(30, 86_400, 1440, 8, 11),
    },
  };
}

interface DemoState {
  signedIn: boolean;
  bootedAt: number;
  snapshot: DashboardSnapshot;
}

function createInitialState(): DemoState {
  const now = unixNow();

  const rawNodes: Omit<NodeSummary, "history">[] = [
    {
      id: "edge-sg-01",
      label: "SG Edge",
      group: "Cloud",
      overall_status: "ok",
      is_public: true,
      public_managed: false,
      primary_mount: null,
      interval_secs: 60,
      grace_secs: 120,
      muted_until: 0,
      created_at: now - 54 * 86_400,
      last_seen_at: now - 14,
      rx_bps: 680_000,
      tx_bps: 1_940_000,
      agent_version: manifest.version,
      system: {
        uptime_secs: 54 * 86_400 + 14_200,
        cpu_pct: 16.4,
        load_1m: 1.02,
        mem_used_bytes: Math.round(0.43 * 4 * 1024 ** 3),
        mem_total_bytes: 4 * 1024 ** 3,
      },
      mounts: [
        {
          path: "/",
          label: "Root",
          used_bytes: Math.round(19.4 * 1024 ** 3),
          total_bytes: 60 * 1024 ** 3,
          status: "ok",
        },
      ],
      checks: [
        {
          key: "systemd",
          label: "systemd",
          group: "system",
          status: "ok",
          summary: "0 failed units",
        },
        {
          key: "tls.edge",
          label: "*.example.com TLS",
          group: "tls",
          status: "ok",
          summary: "Valid for 64d",
        },
      ],
      series: [
        {
          key: "tcp.tokyo",
          label: "Tokyo Origin",
          group: "network",
          unit: "ms",
          value: 68.4,
          loss_pct: 0,
          status: "ok",
        },
      ],
      info: [
        {
          key: "os",
          label: "OS",
          group: "system",
          value: "NixOS 26.05 (Linux 6.12)",
        },
        {
          key: "cpu",
          label: "CPU",
          group: "system",
          value: "AMD EPYC (2 vCPU)",
        },
        { key: "ipv4", label: "IPv4", group: "network", value: "203.0.113.10" },
      ],
    },
    {
      id: "edge-us-01",
      label: "US West",
      group: "Cloud",
      overall_status: "ok",
      is_public: true,
      public_managed: false,
      primary_mount: null,
      interval_secs: 60,
      grace_secs: 120,
      muted_until: 0,
      created_at: now - 89 * 86_400,
      last_seen_at: now - 19,
      rx_bps: 290_000,
      tx_bps: 510_000,
      agent_version: manifest.version,
      system: {
        uptime_secs: 89 * 86_400 + 7800,
        cpu_pct: 9.2,
        load_1m: 0.57,
        mem_used_bytes: Math.round(0.35 * 2 * 1024 ** 3),
        mem_total_bytes: 2 * 1024 ** 3,
      },
      mounts: [
        {
          path: "/",
          label: "Root",
          used_bytes: Math.round(11.6 * 1024 ** 3),
          total_bytes: 40 * 1024 ** 3,
          status: "ok",
        },
      ],
      checks: [
        {
          key: "systemd",
          label: "systemd",
          group: "system",
          status: "ok",
          summary: "0 failed units",
        },
      ],
      series: [],
      info: [
        {
          key: "os",
          label: "OS",
          group: "system",
          value: "NixOS 26.05 (Linux 6.12)",
        },
        { key: "ipv4", label: "IPv4", group: "network", value: "203.0.113.24" },
      ],
    },
    {
      id: "relay-eu-01",
      label: "EU Relay",
      group: "Cloud",
      overall_status: "ok",
      is_public: false,
      public_managed: false,
      primary_mount: null,
      interval_secs: 60,
      grace_secs: 120,
      muted_until: 0,
      created_at: now - 23 * 86_400,
      last_seen_at: now - 11,
      rx_bps: 2_840_000,
      tx_bps: 2_910_000,
      agent_version: manifest.version,
      system: {
        uptime_secs: 23 * 86_400 + 19_400,
        cpu_pct: 21.8,
        load_1m: 1.36,
        mem_used_bytes: Math.round(0.52 * 4 * 1024 ** 3),
        mem_total_bytes: 4 * 1024 ** 3,
      },
      mounts: [
        {
          path: "/",
          label: "Root",
          used_bytes: Math.round(24.6 * 1024 ** 3),
          total_bytes: 60 * 1024 ** 3,
          status: "ok",
        },
      ],
      checks: [
        {
          key: "systemd",
          label: "systemd",
          group: "system",
          status: "ok",
          summary: "0 failed units",
        },
      ],
      series: [],
      info: [
        {
          key: "os",
          label: "OS",
          group: "system",
          value: "Debian 13 (Linux 6.12)",
        },
        {
          key: "ipv4",
          label: "IPv4",
          group: "network",
          value: "198.51.100.42",
        },
      ],
    },
    {
      id: "lab-01",
      label: "Lab Server",
      group: "Homelab",
      overall_status: "ok",
      is_public: true,
      public_managed: false,
      primary_mount: null,
      interval_secs: 60,
      grace_secs: 120,
      muted_until: 0,
      created_at: now - 37 * 86_400,
      last_seen_at: now - 9,
      rx_bps: 1_850_000,
      tx_bps: 940_000,
      agent_version: manifest.version,
      system: {
        uptime_secs: 37 * 86_400 + 18_600,
        cpu_pct: 28.6,
        load_1m: 1.79,
        mem_used_bytes: Math.round(0.62 * 32 * 1024 ** 3),
        mem_total_bytes: 32 * 1024 ** 3,
        swap_used_bytes: Math.round(0.06 * 32 * 1024 ** 3),
        swap_total_bytes: Math.round(0.25 * 32 * 1024 ** 3),
      },
      mounts: [
        {
          path: "/",
          label: "System",
          used_bytes: 118 * 1024 ** 3,
          total_bytes: 500 * 1024 ** 3,
          status: "ok",
        },
        {
          path: "/data",
          label: "Data Pool",
          used_bytes: 2140 * 1024 ** 3,
          total_bytes: 4000 * 1024 ** 3,
          status: "ok",
        },
      ],
      checks: [
        {
          key: "systemd",
          label: "systemd",
          group: "system",
          status: "ok",
          summary: "0 failed units",
        },
        {
          key: "containers",
          label: "Containers",
          group: "services",
          status: "ok",
          summary: "9 active",
        },
        {
          key: "tailscale",
          label: "Tailscale",
          group: "network",
          status: "ok",
          summary: "Connected (100.64.0.12)",
        },
        {
          key: "tls.lab",
          label: "*.internal TLS",
          group: "tls",
          status: "ok",
          summary: "Valid for 52d",
        },
      ],
      series: [
        {
          key: "tcp.edge",
          label: "SG Edge Relay",
          group: "network",
          unit: "ms",
          value: 46.2,
          loss_pct: 0,
          status: "ok",
        },
        {
          key: "tcp.dns",
          label: "Upstream DNS",
          group: "network",
          unit: "ms",
          value: 14.8,
          loss_pct: 0,
          status: "ok",
        },
        {
          key: "temp.cpu",
          label: "CPU Temp",
          group: "hardware",
          unit: "celsius",
          value: 48.5,
          status: "ok",
        },
      ],
      info: [
        {
          key: "os",
          label: "OS",
          group: "system",
          value: "NixOS 26.05 (Linux 6.12)",
        },
        {
          key: "cpu",
          label: "CPU",
          group: "system",
          value: "AMD Ryzen 7 7840HS (16 threads)",
        },
        {
          key: "ipv4",
          label: "LAN IPv4",
          group: "network",
          value: "192.0.2.15",
        },
        {
          key: "gen",
          label: "Generation",
          group: "system",
          value: "#142 (2026-11-24)",
        },
      ],
    },
    {
      id: "nas-01",
      label: "Home NAS",
      group: "Homelab",
      overall_status: "warn",
      is_public: false,
      public_managed: false,
      primary_mount: null,
      interval_secs: 60,
      grace_secs: 120,
      muted_until: 0,
      created_at: now - 118 * 86_400,
      last_seen_at: now - 23,
      rx_bps: 720_000,
      tx_bps: 3_480_000,
      agent_version: manifest.version,
      system: {
        uptime_secs: 118 * 86_400 + 5100,
        cpu_pct: 11.4,
        load_1m: 0.71,
        mem_used_bytes: Math.round(0.48 * 16 * 1024 ** 3),
        mem_total_bytes: 16 * 1024 ** 3,
      },
      mounts: [
        {
          path: "/volume1",
          label: "Volume 1 (RAID)",
          used_bytes: 13_920 * 1024 ** 3,
          total_bytes: 16_000 * 1024 ** 3,
          status: "warn",
        },
        {
          path: "/volume2",
          label: "NVMe Cache",
          used_bytes: 380 * 1024 ** 3,
          total_bytes: 1000 * 1024 ** 3,
          status: "ok",
        },
      ],
      checks: [
        {
          key: "raid",
          label: "RAID Health",
          group: "storage",
          status: "ok",
          summary: "4/4 drives healthy",
        },
      ],
      series: [],
      info: [
        { key: "os", label: "OS", group: "system", value: "NAS Linux 5.15" },
        {
          key: "ipv4",
          label: "LAN IPv4",
          group: "network",
          value: "192.0.2.20",
        },
      ],
    },
    {
      id: "router-01",
      label: "Core Router",
      group: "Homelab",
      overall_status: "ok",
      is_public: false,
      public_managed: false,
      primary_mount: null,
      interval_secs: 60,
      grace_secs: 120,
      muted_until: 0,
      created_at: now - 74 * 86_400,
      last_seen_at: now - 16,
      rx_bps: 6_250_000,
      tx_bps: 2_140_000,
      agent_version: manifest.version,
      system: {
        uptime_secs: 74 * 86_400 + 3200,
        cpu_pct: 5.8,
        load_1m: 0.36,
        mem_used_bytes: Math.round(0.28 * 1024 ** 3),
        mem_total_bytes: 1024 ** 3,
      },
      mounts: [
        {
          path: "/overlay",
          label: "Overlay",
          used_bytes: Math.round(0.21 * 1024 ** 3),
          total_bytes: 1024 ** 3,
          status: "ok",
        },
      ],
      checks: [
        {
          key: "wan",
          label: "WAN Uplink",
          group: "network",
          status: "ok",
          summary: "PPPoE active (1000 Mbps)",
        },
      ],
      series: [],
      info: [
        { key: "os", label: "OS", group: "system", value: "OpenWrt 24.10" },
        {
          key: "ipv4",
          label: "LAN IPv4",
          group: "network",
          value: "192.0.2.1",
        },
      ],
    },
  ];

  const nodes: NodeSummary[] = rawNodes.map((n) => {
    const full: NodeSummary = { ...n, history: {} };
    full.history = buildNodeHistory(full, now, 21_600, 48);

    return full;
  });

  const makeHubMonitor = (
    id: string,
    name: string,
    group: string,
    url: string,
    publicUrl: string | null,
    isPublic: boolean,
    baseMs: number,
    seed: number,
    fails: readonly number[] = [],
  ): MonitorSummary => ({
    id,
    name,
    group,
    probe: {
      from: "hub",
      type: "http",
      url,
      method: "GET",
      expected_status_min: 200,
      expected_status_max: 299,
      expected_body: null,
      timeout_ms: 8000,
    },
    public_url: publicUrl,
    interval_secs: 60,
    enabled: true,
    is_public: isPublic,
    public_managed: false,
    managed_by_node_id: null,
    muted_until: 0,
    last_checked_at: now - 14,
    last_status: "ok",
    last_http_status: 200,
    last_latency_ms: baseMs,
    last_error: null,
    ...buildMonitorHistory(now, seed, baseMs, fails),
  });

  const monitors: MonitorSummary[] = [
    makeHubMonitor(
      "site",
      "Marketing Site",
      "Web",
      "https://example.com/",
      "https://example.com/",
      true,
      38,
      1,
    ),
    makeHubMonitor(
      "docs",
      "Documentation",
      "Web",
      "https://docs.example.com/",
      "https://docs.example.com/",
      true,
      44,
      2,
    ),
    makeHubMonitor(
      "api",
      "Public API",
      "Web",
      "https://api.example.com/healthz",
      "https://api.example.com/",
      true,
      92,
      3,
    ),
    makeHubMonitor(
      "git",
      "Git Forge",
      "Services",
      "https://git.example.com/",
      "https://git.example.com/",
      true,
      145,
      4,
    ),
    makeHubMonitor(
      "sso",
      "SSO / OIDC",
      "Services",
      "https://id.example.com/healthz",
      "https://id.example.com/",
      true,
      112,
      5,
    ),
    makeHubMonitor(
      "chat",
      "Team Chat",
      "Services",
      "https://chat.example.com/",
      "https://chat.example.com/",
      true,
      168,
      6,
      [22],
    ),
    {
      id: "lab-01:media",
      name: "Media Server",
      group: "Internal",
      probe: {
        from: "agent",
        type: "http",
        target: "http://127.0.0.1:8096/health",
        grace_secs: 120,
      },
      public_url: null,
      interval_secs: 60,
      enabled: true,
      is_public: false,
      public_managed: false,
      managed_by_node_id: "lab-01",
      muted_until: 0,
      last_checked_at: now - 18,
      last_status: "ok",
      last_http_status: 200,
      last_latency_ms: 14,
      last_error: null,
      ...buildMonitorHistory(now, 20, 14, [15, 16]),
    },
    {
      id: "lab-01:postgres",
      name: "PostgreSQL",
      group: "Internal",
      probe: {
        from: "agent",
        type: "tcp",
        target: "127.0.0.1:5432",
        grace_secs: 120,
      },
      public_url: null,
      interval_secs: 60,
      enabled: true,
      is_public: false,
      public_managed: false,
      managed_by_node_id: "lab-01",
      muted_until: 0,
      last_checked_at: now - 18,
      last_status: "ok",
      last_http_status: null,
      last_latency_ms: 1.3,
      last_error: null,
      ...buildMonitorHistory(now, 21, 1.3, []),
    },
    {
      id: "lab-01:worker",
      name: "Queue Worker",
      group: "Internal",
      probe: {
        from: "agent",
        type: "exec",
        target: "worker-health",
        grace_secs: 120,
      },
      public_url: null,
      interval_secs: 60,
      enabled: true,
      is_public: true,
      public_managed: true,
      managed_by_node_id: "lab-01",
      muted_until: 0,
      last_checked_at: now - 18,
      last_status: "ok",
      last_http_status: null,
      last_latency_ms: null,
      last_error: null,
      ...buildMonitorHistory(now, 22, null, []),
    },
  ];

  const jobs: JobSummary[] = [
    {
      key: "cert-sync",
      node_id: "edge-us-01",
      label: "TLS Certificate Sync",
      interval_secs: 86_400,
      grace_secs: 3600,
      muted_until: 0,
      last_run_at: now - 11 * 3600,
      overall_status: "ok",
      last_status: "ok",
      last_duration_ms: 1420,
      last_summary: "3 certificates valid (>45 days remaining)",
      last_detail: null,
      next_due_at: now + 13 * 3600,
    },
    {
      key: "db-snapshot",
      node_id: "edge-sg-01",
      label: "PostgreSQL Snapshot",
      interval_secs: 21_600,
      grace_secs: 1800,
      muted_until: 0,
      last_run_at: now - 42 * 60,
      overall_status: "ok",
      last_status: "ok",
      last_duration_ms: 6840,
      last_summary: "Verified pg-20261126.sql.zst (142 MiB)",
      last_detail: null,
      next_due_at: now + 21_600 - 42 * 60,
    },
    {
      key: "nightly-backup",
      node_id: "lab-01",
      label: "Nightly Restic Backup",
      interval_secs: 86_400,
      grace_secs: 7200,
      muted_until: 0,
      last_run_at: now - 5 * 3600,
      overall_status: "ok",
      last_status: "ok",
      last_duration_ms: 42_300,
      last_summary: "Snapshot 9c4f12a8 saved (1.8 GiB uploaded, 0 errors)",
      last_detail: null,
      next_due_at: now + 19 * 3600,
    },
  ];

  const events: AlertEventSummary[] = [
    {
      id: 6,
      incident_key: "monitor:chat",
      target_type: "monitor",
      target_id: "chat",
      label: "Monitor: Team Chat",
      kind: "resolved",
      summary: "HTTP 200 in 164 ms",
      created_at: now - 3 * 3600,
      delivery: { telegram: "ok", matrix: "ok" },
    },
    {
      id: 5,
      incident_key: "monitor:chat",
      target_type: "monitor",
      target_id: "chat",
      label: "Monitor: Team Chat",
      kind: "firing",
      summary: "HTTP 502",
      created_at: now - 3 * 3600 - 240,
      delivery: { telegram: "ok", matrix: "ok" },
    },
    {
      id: 4,
      incident_key: "monitor:lab-01:media",
      target_type: "monitor",
      target_id: "lab-01:media",
      label: "Monitor: Media Server",
      kind: "resolved",
      summary: "HTTP 200 in 13 ms",
      created_at: now - 14 * 3600,
      delivery: { telegram: "ok", matrix: "ok" },
    },
    {
      id: 3,
      incident_key: "monitor:lab-01:media",
      target_type: "monitor",
      target_id: "lab-01:media",
      label: "Monitor: Media Server",
      kind: "firing",
      summary: "Connection refused",
      created_at: now - 14 * 3600 - 180,
      delivery: { telegram: "ok", matrix: "ok" },
    },
    {
      id: 2,
      incident_key: "node:relay-eu-01:offline",
      target_type: "node",
      target_id: "relay-eu-01",
      label: "EU Relay: Connectivity",
      kind: "resolved",
      summary: "Node online",
      created_at: now - 38 * 3600,
      delivery: { telegram: "ok", matrix: "ok" },
    },
    {
      id: 1,
      incident_key: "node:relay-eu-01:offline",
      target_type: "node",
      target_id: "relay-eu-01",
      label: "EU Relay: Connectivity",
      kind: "firing",
      summary: "No report since 3m ago (expected every 60s)",
      created_at: now - 38 * 3600 - 300,
      delivery: { telegram: "ok", matrix: "ok" },
    },
  ];

  const maintenances: MaintenanceSummary[] = [
    {
      id: "mnt-sg-kernel",
      title: "SG Edge kernel security upgrade",
      body: "Routine NixOS kernel update and reboot on SG Edge. Brief ~2 minute reconnect expected.",
      starts_at: now + 12 * 3600,
      ends_at: now + 12 * 3600 + 1800,
      targets: [{ type: "node", id: "edge-sg-01" }],
      state: "upcoming",
      created_at: now - 2 * 3600,
    },
  ];

  return {
    signedIn: true,
    bootedAt: now,
    snapshot: {
      now,
      version: manifest.version,
      public_base_url: "https://status.example.com",
      settings: {
        auto_register: false,
        enrollment_token: "uptn_enroll_demo_preview_token",
        global_muted_until: 0,
        site_title: null,
        site_links: [
          { label: "GitHub", url: "https://github.com/so1ve/uptarn" },
          { label: "Docs", url: "https://github.com/so1ve/uptarn#readme" },
        ],
        channels: { telegram: true, matrix: true },
        auth: {
          password_enabled: true,
          cf_access_enabled: false,
          passkey_count: 1,
        },
      },
      incidents: [],
      maintenances,
      nodes,
      monitors,
      jobs,
      events,
      passkeys: [
        {
          id: "demo-pk-1",
          name: "Demo Passkey",
          device_type: "multiDevice",
          backed_up: true,
          created_at: now - 30 * 86_400,
          last_used_at: now - 3600,
        },
      ],
    },
  };
}

let state: DemoState | null = null;

function getState(): DemoState {
  state ??= createInitialState();

  return state;
}

function tickClock(st: DemoState): number {
  const now = unixNow();
  const delta = Math.max(0, now - st.snapshot.now);
  st.snapshot.now = now;
  if (delta > 0) {
    for (const node of st.snapshot.nodes) {
      if (node.system) {
        node.system.uptime_secs += delta;
      }
      if (node.last_seen_at !== null && now - node.last_seen_at > 55) {
        node.last_seen_at = now - 5;
      }
    }
    for (const mon of st.snapshot.monitors) {
      if (
        mon.enabled &&
        mon.last_checked_at !== null &&
        now - mon.last_checked_at > 55
      ) {
        mon.last_checked_at = now - 4;
      }
    }
    for (const m of st.snapshot.maintenances) {
      m.state =
        now < m.starts_at
          ? "upcoming"
          : now <= m.ends_at
            ? "active"
            : "completed";
    }
  }

  return now;
}

function buildPublicStatus(st: DemoState): PublicStatusSnapshot {
  const snap = st.snapshot;
  const now = tickClock(st);
  const publicMonitors = snap.monitors.filter((m) => m.is_public);
  const publicNodes = snap.nodes.filter((n) => n.is_public);
  const monitorKeyById = new Map(
    publicMonitors.map((m, idx) => [m.id, `m${idx}`]),
  );
  const nodeKeyById = new Map(publicNodes.map((n, idx) => [n.id, `n${idx}`]));

  const monitors: PublicMonitorSummary[] = publicMonitors.map((m, idx) => ({
    key: `m${idx}`,
    name: m.name,
    group: m.group,
    has_latency: m.probe.type !== "exec",
    public_url: m.public_url,
    enabled: m.enabled,
    last_checked_at: m.last_checked_at,
    last_status: m.last_status,
    last_latency_ms: m.last_latency_ms,
    status_detail: m.last_status === "fail" ? (m.last_error ?? "Failed") : null,
    samples: m.samples.slice(-36),
    rollups: m.rollups,
  }));

  const nodes: PublicNodeSummary[] = publicNodes.map((n, idx) => {
    const disk = summarizeDisk(n.mounts, n.primary_mount);
    const rawMem = memPercent(n.system);

    return {
      key: `n${idx}`,
      label: n.label,
      group: n.group,
      overall_status: n.overall_status,
      uptime_secs:
        n.overall_status === "offline" ? null : (n.system?.uptime_secs ?? null),
      cpu_pct: n.system?.cpu_pct ?? null,
      mem_pct: rawMem === null ? null : round1(rawMem),
      storage_pct:
        disk?.pct === undefined || disk.pct === null ? null : round1(disk.pct),
      cpu_history: n.history._cpu ?? [],
      mem_history: n.history._mem ?? [],
    };
  });

  const incidents: PublicIncidentSummary[] = [];
  const chatKey = monitorKeyById.get("chat");
  if (chatKey) {
    incidents.push({
      key: "pub-inc-chat",
      target_key: chatKey,
      target_type: "monitor",
      name: "Team Chat",
      state: "resolved",
      started_at: st.bootedAt - 3 * 3600 - 240,
      resolved_at: st.bootedAt - 3 * 3600,
      reason: "HTTP 502",
    });
  }

  const maintenances: PublicMaintenanceSummary[] = snap.maintenances
    .filter((m) => m.state !== "completed")
    .flatMap((m, idx) => {
      const targetNames = m.targets
        .map((t) =>
          t.type === "node"
            ? (publicNodes.find((n) => n.id === t.id)?.label ?? null)
            : (publicMonitors.find((mon) => mon.id === t.id)?.name ?? null),
        )
        .filter((x): x is string => x !== null);
      if (m.targets.length > 0 && targetNames.length === 0) {
        return [];
      }

      return [
        {
          key: `mt${idx}`,
          title: m.title,
          body: m.body,
          starts_at: m.starts_at,
          ends_at: m.ends_at,
          state: m.state as "upcoming" | "active",
          targets: targetNames,
        },
      ];
    });

  void nodeKeyById;

  return {
    now,
    version: snap.version,
    public_base_url: snap.public_base_url,
    site_title: snap.settings.site_title,
    site_links: snap.settings.site_links,
    auth: snap.settings.auth,
    monitors,
    nodes,
    incidents,
    maintenances,
  };
}

function reorderByIds<T extends { id: string }>(
  items: T[],
  ids: readonly string[],
): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]));

  return [...items].sort(
    (a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9),
  );
}

const clone = <T>(val: T): T => structuredClone(val);

export async function demoApiFetch<T = Record<string, unknown>>(
  rawUrl: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const st = getState();
  const snap = st.snapshot;
  const now = tickClock(st);
  const parsedUrl = new URL(rawUrl, "https://status.example.com");
  const pathname = parsedUrl.pathname;
  const payload = (body ?? {}) as Record<string, unknown>;

  if (pathname === "/api/v1/boot" && method === "GET") {
    const res: BootPayload = st.signedIn
      ? { mode: "admin", snapshot: clone(snap) }
      : { mode: "public", status: clone(buildPublicStatus(st)) };

    return res as T;
  }

  if (pathname === "/api/v1/public/status" && method === "GET") {
    return clone(buildPublicStatus(st)) as T;
  }

  if (pathname === "/api/v1/auth/login" && method === "POST") {
    st.signedIn = true;

    return { ok: true } as T;
  }

  if (pathname === "/api/v1/auth/logout" && method === "POST") {
    st.signedIn = false;

    return { ok: true } as T;
  }

  if (pathname.includes("/passkey")) {
    throw new ApiError(400, "Passkeys are disabled in the interactive demo");
  }

  if (!st.signedIn && pathname.startsWith("/api/v1/admin/")) {
    throw new ApiError(401, "Unauthorized");
  }

  if (pathname === "/api/v1/admin/snapshot" && method === "GET") {
    return clone(snap) as T;
  }

  const historyMatch = /^\/api\/v1\/admin\/nodes\/([^/]+)\/history$/.exec(
    pathname,
  );
  if (historyMatch && method === "GET") {
    const nodeId = decodeURIComponent(historyMatch[1]);
    const node = snap.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new ApiError(404, "Not found");
    }
    const windowSecs = Number(parsedUrl.searchParams.get("window") ?? 21_600);
    const res: NodeHistoryResponse = {
      node_id: nodeId,
      window_secs: windowSecs,
      history: buildNodeHistory(node, now, windowSecs, 72),
    };

    return res as T;
  }

  if (pathname === "/api/v1/admin/nodes" && method === "POST") {
    const id = String(payload.id ?? "").trim();
    if (!id) {
      throw new ApiError(400, "id is required");
    }
    if (snap.nodes.some((n) => n.id === id)) {
      throw new ApiError(409, `Node "${id}" already exists`);
    }
    const label = String(payload.label ?? "").trim() || id;
    const group =
      typeof payload.group === "string" && payload.group.trim()
        ? payload.group.trim()
        : null;
    snap.nodes.push({
      id,
      label,
      group,
      overall_status: "pending",
      is_public: Boolean(payload.is_public),
      public_managed: false,
      primary_mount: null,
      interval_secs: Number(payload.interval_secs ?? 60),
      grace_secs: Number(payload.grace_secs ?? 120),
      muted_until: 0,
      created_at: now,
      last_seen_at: null,
      rx_bps: null,
      tx_bps: null,
      agent_version: null,
      system: null,
      mounts: [],
      checks: [],
      series: [],
      info: [],
      history: {},
    });

    return {
      ok: true,
      id,
      label,
      token: `uptn_node_demo_${id}`,
    } as T;
  }

  if (pathname === "/api/v1/admin/nodes/order" && method === "PUT") {
    snap.nodes = reorderByIds(snap.nodes, (payload.ids as string[]) ?? []);

    return { ok: true } as T;
  }

  const rotateMatch = /^\/api\/v1\/admin\/nodes\/([^/]+)\/rotate-token$/.exec(
    pathname,
  );
  if (rotateMatch && method === "POST") {
    const nodeId = decodeURIComponent(rotateMatch[1]);
    if (!snap.nodes.some((n) => n.id === nodeId)) {
      throw new ApiError(404, "Not found");
    }

    return {
      ok: true,
      id: nodeId,
      token: `uptn_node_demo_${Math.random().toString(36).slice(2, 10)}`,
    } as T;
  }

  const nodeMatch = /^\/api\/v1\/admin\/nodes\/([^/]+)$/.exec(pathname);
  if (nodeMatch) {
    const nodeId = decodeURIComponent(nodeMatch[1]);
    const idx = snap.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) {
      throw new ApiError(404, "Not found");
    }
    if (method === "PATCH") {
      const node = snap.nodes[idx];
      if (typeof payload.is_public === "boolean") {
        node.is_public = payload.is_public;
      }
      if (Object.hasOwn(payload, "primary_mount")) {
        node.primary_mount = (payload.primary_mount as string | null) ?? null;
      }
      if (Object.hasOwn(payload, "group")) {
        node.group =
          typeof payload.group === "string" && payload.group.trim()
            ? payload.group.trim()
            : null;
      }

      return { ok: true, ...payload } as T;
    }
    if (method === "DELETE") {
      snap.nodes.splice(idx, 1);

      return { ok: true } as T;
    }
  }

  if (pathname === "/api/v1/admin/monitors" && method === "POST") {
    const input = payload as unknown as MonitorInput;
    const name = String(input.name ?? "").trim();
    const url = String(input.url ?? "").trim();
    const id =
      input.id?.trim() ||
      `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
    const group =
      typeof input.group === "string" && input.group.trim()
        ? input.group.trim()
        : null;
    const existing = snap.monitors.find((m) => m.id === id);
    const probe = {
      from: "hub" as const,
      type: "http" as const,
      url,
      method: input.method ?? "GET",
      expected_status_min: input.expected_status_min ?? 200,
      expected_status_max: input.expected_status_max ?? 299,
      expected_body: input.expected_body ?? null,
      timeout_ms: input.timeout_ms ?? 8000,
    };
    if (existing) {
      existing.name = name;
      existing.group = group;
      existing.probe = probe;
      existing.public_url = input.public_url ?? null;
      existing.interval_secs = input.interval_secs ?? 60;
      existing.enabled = input.enabled ?? true;
      existing.is_public = input.is_public ?? true;
    } else {
      snap.monitors.push({
        id,
        name,
        group,
        probe,
        public_url: input.public_url ?? null,
        interval_secs: input.interval_secs ?? 60,
        enabled: input.enabled ?? true,
        is_public: input.is_public ?? true,
        public_managed: false,
        managed_by_node_id: null,
        muted_until: 0,
        last_checked_at: now - 2,
        last_status: "ok",
        last_http_status: 200,
        last_latency_ms: 42,
        last_error: null,
        ...buildMonitorHistory(now, id.length + 13, 42, []),
      });
    }

    return { ok: true, id } as T;
  }

  if (pathname === "/api/v1/admin/monitors/order" && method === "PUT") {
    snap.monitors = reorderByIds(
      snap.monitors,
      (payload.ids as string[]) ?? [],
    );

    return { ok: true } as T;
  }

  const monitorMatch = /^\/api\/v1\/admin\/monitors\/([^/]+)$/.exec(pathname);
  if (monitorMatch) {
    const monId = decodeURIComponent(monitorMatch[1]);
    const idx = snap.monitors.findIndex((m) => m.id === monId);
    if (idx === -1) {
      throw new ApiError(404, "Not found");
    }
    if (method === "PATCH") {
      const mon = snap.monitors[idx];
      if (typeof payload.is_public === "boolean") {
        if (mon.public_managed) {
          throw new ApiError(
            409,
            `Monitor "${monId}" visibility is managed by its node`,
          );
        }
        mon.is_public = payload.is_public;
      }
      if (Object.hasOwn(payload, "public_url")) {
        mon.public_url = (payload.public_url as string | null) ?? null;
      }
      if (Object.hasOwn(payload, "group")) {
        mon.group =
          typeof payload.group === "string" && payload.group.trim()
            ? payload.group.trim()
            : null;
      }

      return { ok: true, ...payload } as T;
    }
    if (method === "DELETE") {
      snap.monitors.splice(idx, 1);

      return { ok: true } as T;
    }
  }

  const jobMatch = /^\/api\/v1\/admin\/jobs\/([^/]+)$/.exec(pathname);
  if (jobMatch && method === "DELETE") {
    const key = decodeURIComponent(jobMatch[1]);
    const idx = snap.jobs.findIndex((j) => j.key === key);
    if (idx === -1) {
      throw new ApiError(404, "Not found");
    }
    snap.jobs.splice(idx, 1);

    return { ok: true } as T;
  }

  if (pathname === "/api/v1/admin/maintenances" && method === "POST") {
    const input = payload as unknown as MaintenanceInput;
    const id =
      input.id?.trim() || `mnt-${Math.random().toString(36).slice(2, 8)}`;
    const nextState: MaintenanceSummary["state"] =
      now < input.starts_at
        ? "upcoming"
        : now <= input.ends_at
          ? "active"
          : "completed";
    const entry: MaintenanceSummary = {
      id,
      title: input.title,
      body: input.body ?? "",
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      targets: input.targets ?? [],
      state: nextState,
      created_at: now,
    };
    const existingIdx = snap.maintenances.findIndex((m) => m.id === id);
    if (existingIdx === -1) {
      snap.maintenances.unshift(entry);
    } else {
      snap.maintenances[existingIdx] = entry;
    }

    return { ok: true, id } as T;
  }

  const maintMatch = /^\/api\/v1\/admin\/maintenances\/([^/]+)$/.exec(pathname);
  if (maintMatch && method === "DELETE") {
    const id = decodeURIComponent(maintMatch[1]);
    const idx = snap.maintenances.findIndex((m) => m.id === id);
    if (idx === -1) {
      throw new ApiError(404, "Not found");
    }
    snap.maintenances.splice(idx, 1);

    return { ok: true } as T;
  }

  if (pathname === "/api/v1/admin/mute" && method === "POST") {
    const targetType = payload.target_type as "node" | "monitor" | "job";
    const targetId = String(payload.target_id ?? "");
    const durationSecs = payload.duration_secs as number | undefined;
    const mutedUntil =
      (payload.muted_until as number | undefined) ??
      (durationSecs && durationSecs > 0 ? now + durationSecs : 0);
    if (targetType === "node") {
      const target = snap.nodes.find((n) => n.id === targetId);
      if (target) {
        target.muted_until = mutedUntil;
      }
    } else if (targetType === "monitor") {
      const target = snap.monitors.find((m) => m.id === targetId);
      if (target) {
        target.muted_until = mutedUntil;
      }
    } else {
      const target = snap.jobs.find((j) => j.key === targetId);
      if (target) {
        target.muted_until = mutedUntil;
      }
    }

    return { ok: true, muted_until: mutedUntil } as T;
  }

  if (pathname === "/api/v1/admin/settings" && method === "PATCH") {
    if (typeof payload.auto_register === "boolean") {
      snap.settings.auto_register = payload.auto_register;
    }
    if (payload.rotate_enrollment_token) {
      snap.settings.enrollment_token = `uptn_enroll_demo_${Math.random().toString(36).slice(2, 10)}`;
    }
    if (typeof payload.global_mute_secs === "number") {
      snap.settings.global_muted_until =
        payload.global_mute_secs > 0 ? now + payload.global_mute_secs : 0;
    }
    if (Object.hasOwn(payload, "site_title")) {
      snap.settings.site_title =
        typeof payload.site_title === "string" && payload.site_title.trim()
          ? payload.site_title.trim()
          : null;
    }
    if (Array.isArray(payload.site_links)) {
      snap.settings.site_links = payload.site_links as SiteLink[];
    }

    return { ok: true, ...snap.settings } as T;
  }

  if (pathname === "/api/v1/admin/tick" && method === "POST") {
    for (const m of snap.monitors) {
      if (m.enabled) {
        m.last_checked_at = now;
      }
    }

    return {
      ok: true,
      probed_monitors: snap.monitors.filter((m) => m.enabled).length,
      evaluated_nodes: snap.nodes.length,
      evaluated_jobs: snap.jobs.length,
      pruned: false,
    } as T;
  }

  if (pathname === "/api/v1/admin/notifications/test" && method === "POST") {
    return { ok: true, delivery: { telegram: "ok", matrix: "ok" } } as T;
  }

  throw new ApiError(404, `Demo endpoint not found: ${method} ${pathname}`);
}
