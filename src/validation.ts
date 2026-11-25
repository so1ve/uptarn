import { generateRandomToken } from "./auth/index.ts";
import { httpError } from "./http.ts";
import type {
  HealthStatus,
  JobReportPayload,
  MaintenanceInput,
  MaintenanceTarget,
  MonitorInput,
  MonitorKind,
  MonitorResult,
  NodeMonitorSpec,
  NodeReportPayload,
  SeriesUnit,
  SiteLink,
  SystemSnapshot,
  TargetType,
} from "./shared/index.ts";

const SLUG_RE = /^[a-z0-9][\w.:-]{0,63}$/i;
const STATUSES = [
  "ok",
  "warn",
  "fail",
] as const satisfies readonly HealthStatus[];
const UNITS = [
  "ms",
  "%",
  "bytes",
  "bps",
  "celsius",
  "count",
  "days",
] as const satisfies readonly SeriesUnit[];
const METHODS = ["GET", "HEAD", "POST"] as const;
const MONITOR_KINDS = [
  "http",
  "tcp",
  "exec",
] as const satisfies readonly MonitorKind[];
const MONITOR_SOURCES = ["hub", "agent"] as const;
const TARGETS = [
  "node",
  "monitor",
  "job",
] as const satisfies readonly TargetType[];

function bad(msg: string): never {
  throw httpError(400, msg);
}

function asObj(val: unknown, field: string): Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    bad(`${field} must be an object`);
  }

  return val as Record<string, unknown>;
}

function str(val: unknown, field: string, max: number): string | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== "string") {
    bad(`${field} must be a string`);
  }

  return val.trim().slice(0, max) || undefined;
}

const reqStr = (val: unknown, field: string, max: number): string =>
  str(val, field, max) ?? bad(`${field} is required`);

function slug(val: unknown, field: string): string {
  const s = reqStr(val, field, 64);
  if (!SLUG_RE.test(s)) {
    bad(`${field} must match ${SLUG_RE.source}`);
  }

  return s;
}

function num(
  val: unknown,
  field: string,
  min?: number,
  max?: number,
): number | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== "number" || !Number.isFinite(val)) {
    bad(`${field} must be a finite number`);
  }
  if ((min !== undefined && val < min) || (max !== undefined && val > max)) {
    bad(`${field} out of range`);
  }

  return val;
}

const reqNum = (
  val: unknown,
  field: string,
  min?: number,
  max?: number,
): number => num(val, field, min, max) ?? bad(`${field} is required`);

function int(
  val: unknown,
  field: string,
  min?: number,
  max?: number,
): number | undefined {
  const n = num(val, field, min, max);

  return n === undefined ? undefined : Math.floor(n);
}

const reqInt = (
  val: unknown,
  field: string,
  min?: number,
  max?: number,
): number => int(val, field, min, max) ?? bad(`${field} is required`);

function bool(val: unknown, field: string): boolean | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== "boolean") {
    bad(`${field} must be a boolean`);
  }

  return val;
}

function oneOf<T extends string>(
  val: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== "string" || !allowed.includes(val as T)) {
    bad(`${field} must be one of ${allowed.join(", ")}`);
  }

  return val as T;
}

const reqOneOf = <T extends string>(
  val: unknown,
  field: string,
  allowed: readonly T[],
): T => oneOf(val, field, allowed) ?? bad(`${field} is required`);

function httpUrl(val: unknown, field: string): string | null {
  const raw = str(val, field, 512);
  if (!raw) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    bad(`${field} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    bad(`${field} protocol must be http: or https:`);
  }

  return parsed.toString();
}

function list<T>(
  raw: unknown,
  field: string,
  max: number,
  itemFn: (item: Record<string, unknown>, prefix: string) => T,
): T[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > max) {
    bad(`${field} must be an array of at most ${max} items`);
  }

  return raw.map((el, i) =>
    itemFn(asObj(el, `${field}[${i}]`), `${field}[${i}]`),
  );
}

export function parseNodeReportPayload(raw: unknown): NodeReportPayload {
  const obj = asObj(raw, "report body");
  let system: SystemSnapshot | undefined;
  if (obj.system !== undefined && obj.system !== null) {
    const sys = asObj(obj.system, "system");
    system = {
      uptime_secs: reqInt(sys.uptime_secs, "system.uptime_secs", 0),
      cpu_pct: num(sys.cpu_pct, "system.cpu_pct", 0, 100),
      load_1m: num(sys.load_1m, "system.load_1m", 0),
      mem_used_bytes: num(sys.mem_used_bytes, "system.mem_used_bytes", 0),
      mem_total_bytes: num(sys.mem_total_bytes, "system.mem_total_bytes", 0),
      swap_used_bytes: num(sys.swap_used_bytes, "system.swap_used_bytes", 0),
      swap_total_bytes: num(sys.swap_total_bytes, "system.swap_total_bytes", 0),
      rx_bytes: num(sys.rx_bytes, "system.rx_bytes", 0),
      tx_bytes: num(sys.tx_bytes, "system.tx_bytes", 0),
    };
  }

  let monitors: NodeMonitorSpec[] | undefined;
  if (obj.monitors !== undefined && obj.monitors !== null) {
    const seenKeys = new Set<string>();
    monitors = list(obj.monitors, "monitors", 32, (m, p) => {
      const key = slug(m.key, `${p}.key`);
      if (seenKeys.has(key)) {
        bad(`${p}.key duplicate "${key}"`);
      }
      seenKeys.add(key);

      return parseNodeMonitorSpec(m, p, key);
    });
  }

  return {
    node_id: slug(obj.node_id, "node_id"),
    label: str(obj.label, "label", 80),
    agent_version: str(obj.agent_version, "agent_version", 40),
    interval_secs: int(obj.interval_secs, "interval_secs", 10, 86_400),
    grace_secs: int(obj.grace_secs, "grace_secs", 10, 604_800),
    is_public: bool(obj.is_public, "is_public"),
    system,
    mounts: list(obj.mounts, "mounts", 64, (m, p) => ({
      path: reqStr(m.path, `${p}.path`, 128),
      label: str(m.label, `${p}.label`, 64),
      used_bytes: reqInt(m.used_bytes, `${p}.used_bytes`, 0),
      total_bytes: reqInt(m.total_bytes, `${p}.total_bytes`, 0),
      status: reqOneOf(m.status, `${p}.status`, STATUSES),
      summary: str(m.summary, `${p}.summary`, 200),
    })),
    checks: list(obj.checks, "checks", 128, (c, p) => ({
      key: slug(c.key, `${p}.key`),
      label: reqStr(c.label, `${p}.label`, 80),
      group: str(c.group, `${p}.group`, 40),
      status: reqOneOf(c.status, `${p}.status`, STATUSES),
      summary: str(c.summary, `${p}.summary`, 240),
      detail: str(c.detail, `${p}.detail`, 2048),
    })),
    series: list(obj.series, "series", 128, (s, p) => ({
      key: slug(s.key, `${p}.key`),
      label: reqStr(s.label, `${p}.label`, 80),
      group: str(s.group, `${p}.group`, 40),
      unit: reqOneOf(s.unit, `${p}.unit`, UNITS),
      value: reqNum(s.value, `${p}.value`),
      loss_pct: num(s.loss_pct, `${p}.loss_pct`, 0, 100),
      status: oneOf(s.status, `${p}.status`, STATUSES),
      summary: str(s.summary, `${p}.summary`, 200),
    })),
    info: list(obj.info, "info", 128, (inf, p) => ({
      key: slug(inf.key, `${p}.key`),
      label: reqStr(inf.label, `${p}.label`, 80),
      group: str(inf.group, `${p}.group`, 40),
      value: reqStr(inf.value, `${p}.value`, 512),
    })),
    monitors,
  };
}

export function parseJobReportPayload(raw: unknown): JobReportPayload {
  const obj = asObj(raw, "job payload");

  return {
    job_key: slug(obj.job_key, "job_key"),
    node_id:
      obj.node_id === undefined || obj.node_id === null
        ? undefined
        : slug(obj.node_id, "node_id"),
    label: str(obj.label, "label", 80),
    interval_secs: reqInt(obj.interval_secs, "interval_secs", 30, 2_592_000),
    grace_secs: int(obj.grace_secs, "grace_secs", 30, 604_800),
    status: reqOneOf(obj.status, "status", ["ok", "fail"] as const),
    duration_ms: int(obj.duration_ms, "duration_ms", 0),
    summary: str(obj.summary, "summary", 240),
    detail: str(obj.detail, "detail", 4096),
  };
}

function generateSlugId(fallbackPrefix: string, name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = generateRandomToken("x", 4).slice(2);

  return base ? `${base}-${suffix}` : `${fallbackPrefix}-${suffix}`;
}

function parseMonitorResult(
  raw: unknown,
  prefix: string,
): MonitorResult | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const obj = asObj(raw, prefix);
  const ok = bool(obj.ok, `${prefix}.ok`);
  if (ok === undefined) {
    bad(`${prefix}.ok is required`);
  }

  return {
    ok,
    latency_ms: num(obj.latency_ms, `${prefix}.latency_ms`, 0, 300_000) ?? null,
    http_status:
      int(obj.http_status, `${prefix}.http_status`, 100, 599) ?? null,
    error: str(obj.error, `${prefix}.error`, 256) ?? null,
  };
}

function parseNodeMonitorSpec(
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
): NodeMonitorSpec {
  const from = reqOneOf(obj.from, `${prefix}.from`, MONITOR_SOURCES);
  const isPublic = bool(obj.is_public, `${prefix}.is_public`);
  const publicUrl = Object.hasOwn(obj, "public_url")
    ? httpUrl(obj.public_url, `${prefix}.public_url`)
    : undefined;

  if (from === "hub") {
    if (obj.type !== undefined && obj.type !== "http") {
      bad(`${prefix}: hub-probed monitors only support type "http"`);
    }
    const {
      id: _id,
      group: _group,
      is_public: _pub,
      public_url: _pubUrl,
      ...spec
    } = parseMonitorInput({ ...obj, id: key });

    return {
      key,
      from: "hub",
      ...spec,
      ...(isPublic === undefined ? {} : { is_public: isPublic }),
      ...(publicUrl === undefined ? {} : { public_url: publicUrl }),
    };
  }

  const type = reqOneOf(obj.type, `${prefix}.type`, MONITOR_KINDS);
  const target =
    type === "http"
      ? (httpUrl(obj.target, `${prefix}.target`) ??
        bad(`${prefix}.target is required`))
      : type === "tcp"
        ? reqStr(obj.target, `${prefix}.target`, 256)
        : (str(obj.target, `${prefix}.target`, 256) ?? null);

  return {
    key,
    name: reqStr(obj.name, `${prefix}.name`, 80),
    from: "agent",
    type,
    target,
    ...(publicUrl === undefined ? {} : { public_url: publicUrl }),
    interval_secs: int(
      obj.interval_secs,
      `${prefix}.interval_secs`,
      10,
      86_400,
    ),
    grace_secs: int(obj.grace_secs, `${prefix}.grace_secs`, 10, 604_800),
    enabled: obj.enabled === undefined ? true : Boolean(obj.enabled),
    ...(isPublic === undefined ? {} : { is_public: isPublic }),
    result: parseMonitorResult(obj.result, `${prefix}.result`),
  };
}

export const normalizeGroup = (val: unknown, field = "group"): string | null =>
  str(val, field, 40) ?? null;

export function parseMonitorInput(raw: MonitorInput | unknown) {
  const obj = asObj(raw, "monitor input");
  const name = reqStr(obj.name, "name", 80);
  const rawId = str(obj.id, "id", 64);
  const id = rawId ? slug(rawId, "id") : generateSlugId("mon", name);
  const url = httpUrl(obj.url, "url") ?? bad("url is required");
  const publicUrl = httpUrl(obj.public_url, "public_url");
  const expectedStatusMin =
    int(obj.expected_status_min, "expected_status_min", 100, 599) ?? 200;
  const expectedStatusMax =
    int(
      obj.expected_status_max,
      "expected_status_max",
      expectedStatusMin,
      599,
    ) ?? Math.max(299, expectedStatusMin);

  return {
    id,
    name,
    group: normalizeGroup(obj.group),
    url,
    public_url: publicUrl,
    method: reqOneOf(
      (str(obj.method, "method", 10) ?? "GET").toUpperCase(),
      "method",
      METHODS,
    ),
    expected_status_min: expectedStatusMin,
    expected_status_max: expectedStatusMax,
    expected_body: str(obj.expected_body, "expected_body", 256) ?? null,
    timeout_ms: int(obj.timeout_ms, "timeout_ms", 500, 30_000) ?? 8000,
    interval_secs: int(obj.interval_secs, "interval_secs", 30, 86_400) ?? 60,
    enabled: obj.enabled === undefined ? true : Boolean(obj.enabled),
    is_public: bool(obj.is_public, "is_public") ?? true,
  };
}
export function parseCreateNodeInput(raw: unknown) {
  const obj = asObj(raw, "node input");

  return {
    id: slug(obj.id, "id"),
    label: str(obj.label, "label", 80),
    group: normalizeGroup(obj.group),
    interval_secs: int(obj.interval_secs, "interval_secs", 10, 86_400),
    grace_secs: int(obj.grace_secs, "grace_secs", 10, 604_800),
    is_public: bool(obj.is_public, "is_public") ?? false,
  };
}

export function parseOrderInput(raw: unknown): string[] {
  const { ids } = asObj(raw, "order input");
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
    bad("ids must be a non-empty array of at most 500 items");
  }
  const seen = new Set<string>();

  return ids.map((id, i) => {
    const clean = slug(id, `ids[${i}]`);
    if (seen.has(clean)) {
      bad(`duplicate id "${clean}"`);
    }
    seen.add(clean);

    return clean;
  });
}

export function normalizePrimaryMount(
  val: unknown,
  field = "primary_mount",
): string | null {
  if (val === null) {
    return null;
  }
  const cleaned = str(val, field, 128);

  return !cleaned || cleaned === "sum" ? null : cleaned;
}

export function parseMonitorPatch(raw: unknown): {
  is_public?: boolean;
  public_url?: string | null;
  group?: string | null;
} {
  const obj = asObj(raw, "monitor patch");
  const isPublic = bool(obj.is_public, "is_public");
  const publicUrl = Object.hasOwn(obj, "public_url")
    ? httpUrl(obj.public_url, "public_url")
    : undefined;
  const group = Object.hasOwn(obj, "group")
    ? normalizeGroup(obj.group)
    : undefined;
  if (
    isPublic === undefined &&
    publicUrl === undefined &&
    group === undefined
  ) {
    bad("At least one of is_public, public_url, or group is required");
  }

  return {
    ...(isPublic === undefined ? {} : { is_public: isPublic }),
    ...(publicUrl === undefined ? {} : { public_url: publicUrl }),
    ...(group === undefined ? {} : { group }),
  };
}

export function parseNodePatch(raw: unknown): {
  is_public?: boolean;
  primary_mount?: string | null;
  group?: string | null;
} {
  const obj = asObj(raw, "node patch");
  const isPublic = bool(obj.is_public, "is_public");
  const primaryMount = Object.hasOwn(obj, "primary_mount")
    ? normalizePrimaryMount(obj.primary_mount)
    : undefined;
  const group = Object.hasOwn(obj, "group")
    ? normalizeGroup(obj.group)
    : undefined;
  if (
    isPublic === undefined &&
    primaryMount === undefined &&
    group === undefined
  ) {
    bad("At least one of is_public, primary_mount, or group is required");
  }

  return {
    ...(isPublic === undefined ? {} : { is_public: isPublic }),
    ...(primaryMount === undefined ? {} : { primary_mount: primaryMount }),
    ...(group === undefined ? {} : { group }),
  };
}

export function parseMuteInput(raw: unknown) {
  const obj = asObj(raw, "mute input");

  return {
    target_type: reqOneOf(obj.target_type, "target_type", TARGETS),
    target_id: reqStr(obj.target_id, "target_id", 128),
    duration_secs: int(obj.duration_secs, "duration_secs", 0),
    muted_until: int(obj.muted_until, "muted_until", 0),
  };
}

export const normalizeSiteTitle = (
  val: unknown,
  field = "site_title",
): string | null => str(val, field, 60) ?? null;

export const normalizeSiteLinks = (
  raw: unknown,
  field = "site_links",
): SiteLink[] =>
  list(raw, field, 6, (item, p) => ({
    label: reqStr(item.label, `${p}.label`, 32),
    url: httpUrl(item.url, `${p}.url`) ?? bad(`${p}.url is required`),
  }));

const MAINTENANCE_TARGET_TYPES = ["node", "monitor"] as const;

export function parseTimestampSecs(val: unknown, field: string): number {
  if (typeof val === "number") {
    return reqInt(val, field, 1);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      return reqInt(Number(trimmed), field, 1);
    }
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms) && ms > 0) {
      return Math.floor(ms / 1000);
    }
  }
  bad(`${field} must be a Unix timestamp (seconds) or ISO-8601 date string`);
}

export function parseMaintenanceInput(raw: MaintenanceInput | unknown) {
  const obj = asObj(raw, "maintenance input");
  const title = reqStr(obj.title, "title", 100);
  const rawId = str(obj.id, "id", 64);
  const id = rawId ? slug(rawId, "id") : generateSlugId("maint", title);
  const body = str(obj.body, "body", 1000) ?? "";
  const startsAt = parseTimestampSecs(obj.starts_at, "starts_at");
  const endsAt = parseTimestampSecs(obj.ends_at, "ends_at");
  if (endsAt < startsAt + 60) {
    bad("ends_at must be at least 60 seconds after starts_at");
  }
  const seen = new Set<string>();
  const targets: MaintenanceTarget[] = [];
  for (const item of list(obj.targets, "targets", 100, (t, p) => ({
    type: reqOneOf(t.type, `${p}.type`, MAINTENANCE_TARGET_TYPES),
    id: slug(t.id, `${p}.id`),
  }))) {
    const key = `${item.type}:${item.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(item);
    }
  }

  return {
    id,
    title,
    body,
    starts_at: startsAt,
    ends_at: endsAt,
    targets,
  };
}

export function parseSettingsPatch(raw: unknown) {
  const obj = asObj(raw, "settings patch");

  return {
    auto_register: bool(obj.auto_register, "auto_register"),
    rotate_enrollment_token: bool(
      obj.rotate_enrollment_token,
      "rotate_enrollment_token",
    ),
    global_muted_until: int(obj.global_muted_until, "global_muted_until", 0),
    global_mute_secs: int(obj.global_mute_secs, "global_mute_secs", 0),
    site_title: Object.hasOwn(obj, "site_title")
      ? normalizeSiteTitle(obj.site_title)
      : undefined,
    site_links: Object.hasOwn(obj, "site_links")
      ? normalizeSiteLinks(obj.site_links)
      : undefined,
  };
}
