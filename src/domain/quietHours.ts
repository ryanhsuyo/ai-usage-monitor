// Quiet-hours + minimum-interval decisions (spec §9). Pure.

export type QuietHours = {
  /** "HH:MM" local time. */
  start?: string;
  end?: string;
};

/**
 * Normalize loose time entry into canonical "HH:MM" so users can type `2300`, `23`, or `9`.
 * With a separator each side is read literally (`23:5` → 23:05); without one, the last two
 * digits are the minutes (`930` → 09:30). Returns "" for cleared input and undefined when the
 * text cannot be read as a time, so callers can keep it on screen and flag it instead of
 * silently rewriting what the user typed.
 */
export function normalizeHhMm(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return "";

  let hours: number;
  let minutes: number;
  const separated = /^(\d{1,2})\s*[:：.．]\s*(\d{1,2})?$/.exec(text);
  if (separated) {
    hours = Number(separated[1]);
    minutes = separated[2] ? Number(separated[2]) : 0;
  } else if (/^\d{1,4}$/.test(text)) {
    if (text.length <= 2) {
      hours = Number(text);
      minutes = 0;
    } else {
      hours = Number(text.slice(0, -2));
      minutes = Number(text.slice(-2));
    }
  } else {
    return undefined;
  }

  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseHM(hm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return undefined;
  return h * 60 + min;
}

/**
 * Is `atLocalMinutes` (minutes since local midnight) within the quiet window?
 * Handles windows that wrap past midnight (e.g. 22:00 → 07:00).
 */
export function isInQuietHours(quiet: QuietHours, atLocalMinutes: number): boolean {
  if (!quiet.start || !quiet.end) return false;
  const start = parseHM(quiet.start);
  const end = parseHM(quiet.end);
  if (start === undefined || end === undefined) return false;
  if (start === end) return false; // zero-length window
  if (start < end) {
    return atLocalMinutes >= start && atLocalMinutes < end;
  }
  // wraps midnight
  return atLocalMinutes >= start || atLocalMinutes < end;
}

/** Convenience: derive local-minutes from a Date and test quiet hours. */
export function isQuietAt(quiet: QuietHours, date: Date): boolean {
  return isInQuietHours(quiet, date.getHours() * 60 + date.getMinutes());
}

/**
 * Minimum-interval gate: true when enough time has passed since the last delivery on this channel.
 * `lastSentIso` undefined ⇒ allowed.
 */
export function passesMinInterval(
  lastSentIso: string | undefined,
  minIntervalMinutes: number | undefined,
  nowIso: string
): boolean {
  if (!minIntervalMinutes || minIntervalMinutes <= 0) return true;
  if (!lastSentIso) return true;
  const elapsedMin = (Date.parse(nowIso) - Date.parse(lastSentIso)) / 60000;
  return elapsedMin >= minIntervalMinutes;
}
