export type HealthStatus = "ok" | "warn" | "fail";

export type TargetType = "node" | "monitor" | "job";

export type SeriesUnit =
  "ms" | "%" | "bytes" | "bps" | "celsius" | "count" | "days";

export type MonitorKind = "http" | "tcp" | "exec";

export interface MonitorResult {
  ok: boolean;
  latency_ms?: number | null;
  http_status?: number | null;
  error?: string | null;
}

export type MonitorProbe =
  | {
      from: "hub";
      type: "http";
      url: string;
      method: string;
      expected_status_min: number;
      expected_status_max: number;
      expected_body: string | null;
      timeout_ms: number;
    }
  | {
      from: "agent";
      type: MonitorKind;
      target: string | null;
      grace_secs: number;
    };

export interface SystemSnapshot {
  uptime_secs: number;
  cpu_pct?: number;
  load_1m?: number;
  mem_used_bytes?: number;
  mem_total_bytes?: number;
  swap_used_bytes?: number;
  swap_total_bytes?: number;
  rx_bytes?: number;
  tx_bytes?: number;
}

export interface MountSnapshot {
  path: string;
  label?: string;
  used_bytes: number;
  total_bytes: number;
  status: HealthStatus;
  summary?: string;
}

export interface CheckSnapshot {
  key: string;
  label: string;
  group?: string;
  status: HealthStatus;
  summary?: string;
  detail?: string;
}

export interface SeriesSnapshot {
  key: string;
  label: string;
  group?: string;
  unit: SeriesUnit;
  value: number;
  loss_pct?: number;
  status?: HealthStatus;
  summary?: string;
}

export interface InfoSnapshot {
  key: string;
  label: string;
  group?: string;
  value: string;
}

export type NodeMonitorSpec =
  | (Omit<MonitorInput, "id" | "group"> & { key: string; from: "hub" })
  | {
      key: string;
      name: string;
      from: "agent";
      type: MonitorKind;
      target?: string | null;
      public_url?: string | null;
      interval_secs?: number;
      grace_secs?: number;
      enabled?: boolean;
      is_public?: boolean;
      result?: MonitorResult | null;
    };

export type JobRunStatus = "pending" | "running" | "ok" | "fail" | "overdue";

export type JobOverallStatus = JobRunStatus;

export interface NodeJobSnapshot {
  key: string;
  label?: string;
  schedule?: string | null;
  status: JobRunStatus;
  last_run_at?: number | null;
  next_run_at?: number | null;
  duration_ms?: number | null;
  summary?: string | null;
  detail?: string | null;
}

export interface NodeReportPayload {
  node_id: string;
  label?: string;
  agent_version?: string;
  interval_secs?: number;
  grace_secs?: number;
  is_public?: boolean;
  system?: SystemSnapshot;
  mounts?: MountSnapshot[];
  checks?: CheckSnapshot[];
  series?: SeriesSnapshot[];
  info?: InfoSnapshot[];
  monitors?: NodeMonitorSpec[];
  jobs?: NodeJobSnapshot[];
}

export interface JobInput {
  key?: string;
  label: string;
  schedule?: string | null;
  interval_secs?: number | null;
  grace_secs?: number;
}

export interface MonitorInput {
  id?: string;
  name: string;
  group?: string | null;
  url: string;
  public_url?: string | null;
  method?: string;
  expected_status_min?: number;
  expected_status_max?: number;
  expected_body?: string | null;
  timeout_ms?: number;
  interval_secs?: number;
  enabled?: boolean;
  is_public?: boolean;
}

export interface SeriesPoint {
  ts: number;
  value: number;
  aux?: number | null;
}

export interface MonitorSample {
  ts: number;
  ok: boolean;
  latency_ms: number | null;
}

export interface MonitorRollupBucket {
  ts: number;
  ok: number;
  total: number;
  avg_ms: number | null;
}

export interface MonitorRollups {
  m30: MonitorRollupBucket[];
  h6: MonitorRollupBucket[];
  d1: MonitorRollupBucket[];
}

export interface NodeHistoryResponse {
  node_id: string;
  window_secs: number;
  history: Record<string, SeriesPoint[]>;
}

export interface NodeSummary {
  id: string;
  label: string;
  group: string | null;
  overall_status: "ok" | "warn" | "fail" | "offline" | "pending";
  is_public: boolean;
  public_managed: boolean;
  primary_mount: string | null;
  interval_secs: number;
  grace_secs: number;
  muted_until: number;
  created_at: number;
  last_seen_at: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
  month_rx_bytes?: number | null;
  month_tx_bytes?: number | null;
  traffic_reset_day?: number;
  agent_version: string | null;
  system: SystemSnapshot | null;
  mounts: MountSnapshot[];
  checks: CheckSnapshot[];
  series: SeriesSnapshot[];
  info: InfoSnapshot[];
  history: Record<string, SeriesPoint[]>;
}

export interface MonitorSummary {
  id: string;
  name: string;
  group: string | null;
  probe: MonitorProbe;
  public_url: string | null;
  interval_secs: number;
  enabled: boolean;
  is_public: boolean;
  public_managed: boolean;
  managed_by_node_id: string | null;
  muted_until: number;
  last_checked_at: number | null;
  last_status: "ok" | "fail" | "pending";
  last_http_status: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
  samples: MonitorSample[];
  rollups: MonitorRollups;
}

export interface JobSummary {
  key: string;
  node_id: string | null;
  managed_by_node_id: string | null;
  label: string;
  schedule: string | null;
  interval_secs: number | null;
  grace_secs: number;
  muted_until: number;
  created_at: number;
  started_at: number | null;
  last_run_at: number | null;
  next_run_at: number | null;
  overall_status: JobOverallStatus;
  last_status: JobRunStatus;
  last_duration_ms: number | null;
  last_summary: string | null;
  last_detail: string | null;
  next_due_at: number | null;
}

export interface IncidentSummary {
  incident_key: string;
  target_type: TargetType;
  target_id: string;
  label: string;
  state: "failing" | "open";
  consecutive_failures: number;
  opened_at: number | null;
  acknowledged_at: number | null;
  last_changed_at: number;
  last_summary: string;
}

export interface AlertEventSummary {
  id: number;
  incident_key: string;
  target_type: TargetType;
  target_id: string;
  label: string;
  kind: "firing" | "resolved";
  summary: string;
  created_at: number;
  delivery: Record<string, string>;
}

export interface PasskeySummary {
  id: string;
  name: string;
  device_type: string;
  backed_up: boolean;
  created_at: number;
  last_used_at: number | null;
}

export interface AuthMethodsSummary {
  password_enabled: boolean;
  cf_access_enabled: boolean;
  passkey_count: number;
  turnstile_site_key?: string | null;
}

export interface SiteLink {
  label: string;
  url: string;
}

export interface AdminSettingsSummary {
  auto_register: boolean;
  enrollment_token: string | null;
  global_muted_until: number;
  site_title: string | null;
  site_links: SiteLink[];
  channels: {
    telegram: boolean;
    matrix: boolean;
    webhook?: boolean;
  };
  auth: AuthMethodsSummary;
}

export interface MaintenanceTarget {
  type: "node" | "monitor";
  id: string;
}

export interface MaintenanceInput {
  id?: string;
  title: string;
  body?: string;
  starts_at: number;
  ends_at: number;
  targets?: MaintenanceTarget[];
}

export interface MaintenanceSummary {
  id: string;
  title: string;
  body: string;
  starts_at: number;
  ends_at: number;
  targets: MaintenanceTarget[];
  state: "upcoming" | "active" | "completed";
  created_at: number;
}

export interface PublicMaintenanceSummary {
  key: string;
  title: string;
  body: string;
  starts_at: number;
  ends_at: number;
  state: "upcoming" | "active";
  targets: string[];
}

export interface DashboardSnapshot {
  now: number;
  version: string;
  public_base_url: string;
  settings: AdminSettingsSummary;
  incidents: IncidentSummary[];
  maintenances: MaintenanceSummary[];
  nodes: NodeSummary[];
  monitors: MonitorSummary[];
  jobs: JobSummary[];
  events: AlertEventSummary[];
  passkeys: PasskeySummary[];
}

export interface PublicMonitorSummary {
  key: string;
  name: string;
  group: string | null;
  has_latency: boolean;
  public_url: string | null;
  enabled: boolean;
  last_checked_at: number | null;
  last_status: "ok" | "fail" | "pending";
  last_latency_ms: number | null;
  status_detail: string | null;
  samples: MonitorSample[];
  rollups: MonitorRollups;
}

export interface PublicNodeSummary {
  key: string;
  label: string;
  group: string | null;
  overall_status: "ok" | "warn" | "fail" | "offline" | "pending";
  uptime_secs: number | null;
  cpu_pct: number | null;
  mem_pct: number | null;
  storage_pct: number | null;
  cpu_history: SeriesPoint[];
  mem_history: SeriesPoint[];
}

export interface PublicIncidentSummary {
  key: string;
  target_key: string;
  target_type: "monitor" | "node";
  name: string;
  state: "open" | "resolved";
  started_at: number;
  resolved_at: number | null;
  reason: string;
}

export interface PublicStatusSnapshot {
  now: number;
  version: string;
  public_base_url: string;
  site_title: string | null;
  site_links: SiteLink[];
  auth: AuthMethodsSummary;
  monitors: PublicMonitorSummary[];
  nodes: PublicNodeSummary[];
  incidents: PublicIncidentSummary[];
  maintenances: PublicMaintenanceSummary[];
}

export type BootPayload =
  | { mode: "admin"; snapshot: DashboardSnapshot }
  | { mode: "public"; status: PublicStatusSnapshot };
