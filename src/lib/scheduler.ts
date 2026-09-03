

/** Local date string (yyyy-mm-dd) in a given IANA timezone. */
export function localDay(tz: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

export function localParts(tz: string, at = new Date()): { hour: number; weekday: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(at);
  const hour = Number(f.find((p) => p.type === 'hour')?.value ?? '0');
  const wd = f.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { hour, weekday };
}

export type Window = { days: number[]; startHour: number; endHour: number; timezone: string };

export function inSendingWindow(w: Window, at = new Date()): boolean {
  const { hour, weekday } = localParts(w.timezone, at);
  if (!w.days.includes(weekday)) return false;
  return hour >= w.startHour && hour < w.endHour;
}

/** Next moment the window opens, so the worker can sleep instead of spinning. */
export function nextWindowOpen(w: Window, at = new Date()): Date {
  const probe = new Date(at.getTime());
  for (let i = 0; i < 24 * 14; i++) {
    probe.setTime(probe.getTime() + 60 * 60 * 1000);
    probe.setMinutes(0, 0, 0);
    if (inSendingWindow(w, probe)) return probe;
  }
  return new Date(at.getTime() + 60 * 60 * 1000);
}

export type Governor = {
  dailyLimit: number;
  warmupEnabled?: boolean;
  warmupStart?: number;
  warmupStep?: number;
  activatedAt?: Date;
  sentToday: number;
  sentTodayDate: string | null;
  minGapSeconds: number;
  jitterSeconds: number;
  lastSentAt: Date | null;
};

/** Warmup ramp: day 1 sends `warmupStart`, +`warmupStep`/day, capped at dailyLimit. */
export function effectiveDailyLimit(g: Governor, at = new Date()): number {
  if (!g.warmupEnabled || !g.activatedAt) return g.dailyLimit;
  const days = Math.max(0, Math.floor((at.getTime() - g.activatedAt.getTime()) / 86_400_000));
  const ramped = (g.warmupStart ?? 10) + days * (g.warmupStep ?? 5);
  return Math.max(1, Math.min(g.dailyLimit, ramped));
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'daily_cap'; retryAt: Date }
  | { ok: false; reason: 'throttled'; retryAt: Date };

/** May this channel send right now? Caps + throttle + jitter, all in one place. */
export function canSend(g: Governor, tz: string, at = new Date()): Verdict {
  const today = localDay(tz, at);
  const used = g.sentTodayDate === today ? g.sentToday : 0;

  if (used >= effectiveDailyLimit(g, at)) {
    const midnight = new Date(at.getTime());
    midnight.setUTCHours(midnight.getUTCHours() + 1);
    return { ok: false, reason: 'daily_cap', retryAt: nextLocalMidnight(tz, at) };
  }

  if (g.lastSentAt) {
    const jitter = Math.floor(Math.random() * (g.jitterSeconds || 0));
    const gapMs = (g.minGapSeconds + jitter) * 1000;
    const readyAt = new Date(g.lastSentAt.getTime() + gapMs);
    if (readyAt > at) return { ok: false, reason: 'throttled', retryAt: readyAt };
  }

  return { ok: true };
}

export function nextLocalMidnight(tz: string, at = new Date()): Date {
  const probe = new Date(at.getTime());
  const day = localDay(tz, at);
  for (let i = 0; i < 48; i++) {
    probe.setTime(probe.getTime() + 30 * 60 * 1000);
    if (localDay(tz, probe) !== day) return probe;
  }
  return new Date(at.getTime() + 6 * 60 * 60 * 1000);
}


