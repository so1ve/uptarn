import type { SeriesUnit } from "./protocol.ts";

export const unixNow = (): number => Math.floor(Date.now() / 1000);

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return index === 0
    ? `${Math.round(value)} B`
    : `${value.toFixed(1)} ${units[index]}`;
}

export const formatBps = (bps: number): string =>
  !Number.isFinite(bps) || bps <= 0 ? "0 B/s" : `${formatBytes(bps)}/s`;

export function formatDuration(totalSecs: number): string {
  const secs = Math.max(0, Math.floor(totalSecs));
  if (secs < 60) {
    return `${secs}s`;
  }
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  return `${mins}m`;
}

export function formatAge(ts: number | null | undefined, now: number): string {
  if (ts === null || ts === undefined) {
    return "never";
  }
  const delta = Math.max(0, now - ts);

  return delta < 5 ? "just now" : `${formatDuration(delta)} ago`;
}

export function formatRemaining(untilTs: number, now: number): string {
  const rem = untilTs - now;

  return rem <= 0 ? "expired" : formatDuration(rem);
}

export function formatSeriesValue(value: number, unit: SeriesUnit): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  switch (unit) {
    case "ms": {
      return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`;
    }
    case "%": {
      return `${value.toFixed(1)}%`;
    }
    case "bytes": {
      return formatBytes(value);
    }
    case "bps": {
      return formatBps(value);
    }
    case "celsius": {
      return `${value.toFixed(1)} °C`;
    }
    case "days": {
      return `${Math.round(value)}d`;
    }
    case "count": {
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
    }
  }
}
