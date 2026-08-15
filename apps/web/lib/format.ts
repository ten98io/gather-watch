/** Display formatters shared across pages and (later) room panes. */

/** 3_723_000 → "1:02:03"; 372_000 → "6:12". Negative/NaN → "0:00". */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** 1_536 → "1.5 KB"; 10 GB → "10 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fixed = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  const rounded = fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
  return `${rounded} ${units[unit] ?? 'B'}`;
}

/** Chat-style timestamp: "14:05" today, "Mon 14:05" within a week, else date. */
export function formatTimestamp(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (ts >= startOfToday.getTime()) return time;
  const dayMs = 86_400_000;
  if (ts >= startOfToday.getTime() - 6 * dayMs) {
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Ari Kim" → "AK"; "zed" → "Z". Avatar fallback initials. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (first === undefined) return '?';
  const second = words.length > 1 ? words[words.length - 1] : undefined;
  const a = first.charAt(0);
  const b = second !== undefined ? second.charAt(0) : '';
  return (a + b).toUpperCase();
}

/** 1 → "1 new message", 4 → "4 new messages". */
export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${plural ?? `${singular}s`}`;
}
