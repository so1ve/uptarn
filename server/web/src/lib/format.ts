import { formatBytes, formatDuration } from "../../../src/shared/index.ts";

export {
  formatAge,
  formatBps,
  formatBytes,
  formatDuration,
  formatRemaining,
  formatSeriesValue,
} from "../../../src/shared/index.ts";

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const percent = (used: number, total: number): number | null =>
  total > 0 ? (used / total) * 100 : null;

export function formatUsage(used: number, total: number): string {
  const u = formatBytes(used);
  const t = formatBytes(total);
  const [uVal, uUnit] = u.split(" ");

  return uUnit === t.split(" ")[1] ? `${uVal} / ${t}` : `${u} / ${t}`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const secs = ms / 1000;

  return secs < 60 ? `${secs.toFixed(1)} s` : formatDuration(secs);
}

export const formatClock = (ts: number): string =>
  new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

export function formatTimestamp(ts: number, showDate = false): string {
  if (!showDate) {
    return formatClock(ts);
  }
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");

  return `${mm}/${dd} ${formatClock(ts)}`;
}
