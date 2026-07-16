// Small pure helpers shared across the calculation modules.

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Strict ISO 8601 validity check. Rejects NaN dates and obviously malformed strings. */
export function isValidIso(value: string | undefined | null): value is string {
  if (!value || typeof value !== "string") return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

export function toMs(iso: string): number {
  return Date.parse(iso);
}

/** Signed hours from `a` to `b` (b - a). Positive when b is later than a. */
export function hoursBetween(aIso: string, bIso: string): number {
  return (toMs(bIso) - toMs(aIso)) / (1000 * 60 * 60);
}

export function median(sorted: number[]): number | undefined {
  const n = sorted.length;
  if (n === 0) return undefined;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Linear-interpolation quantile over a copy-sorted array. q in [0,1]. */
export function quantile(values: number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lo = sorted[base] as number;
  const hi = sorted[base + 1];
  return hi === undefined ? lo : lo + rest * (hi - lo);
}

export type Quartiles = { q1: number; q2: number; q3: number; iqr: number };

export function quartiles(values: number[]): Quartiles | undefined {
  if (values.length === 0) return undefined;
  const q1 = quantile(values, 0.25) as number;
  const q2 = quantile(values, 0.5) as number;
  const q3 = quantile(values, 0.75) as number;
  return { q1, q2, q3, iqr: q3 - q1 };
}

/** Return the values with IQR-based outliers removed. If fewer than 4 points, returns input as-is
 *  (too small to define outliers reliably) but never returns an empty array. */
export function withoutOutliers(values: number[], iqrFactor: number): number[] {
  if (values.length < 4) return [...values];
  const q = quartiles(values);
  if (!q) return [...values];
  // NOTE: iqr === 0 (many identical values) is handled by the filter itself — identical values
  // all fall inside [q1, q3] and survive, while genuinely extreme points are removed.
  const lo = q.q1 - iqrFactor * q.iqr;
  const hi = q.q3 + iqrFactor * q.iqr;
  const filtered = values.filter((v) => v >= lo && v <= hi);
  return filtered.length === 0 ? [...values] : filtered;
}

/** Count of IQR-based outliers present in the data (for confidence/warnings). */
export function outlierCount(values: number[], iqrFactor: number): number {
  return values.length - withoutOutliers(values, iqrFactor).length;
}
