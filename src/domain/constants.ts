// Central home for every tuning constant. No magic numbers in UI or elsewhere (spec §11, §12).

export const TIME = {
  /** Two snapshots closer than this are treated as the same reading for burn-rate purposes. */
  MIN_INTERVAL_MINUTES: 10,
  HOUR_MS: 60 * 60 * 1000,
} as const;

export const BURN_RATE = {
  WINDOW_6H_HOURS: 6,
  WINDOW_24H_HOURS: 24,
  /** Points beyond this many IQRs from the quartiles are flagged/excluded as outliers. */
  OUTLIER_IQR_FACTOR: 1.5,
  /** Sample counts at/above this are considered "healthy" for confidence purposes. */
  HEALTHY_SAMPLE_COUNT: 6,
} as const;

export const RESET_DETECTION = {
  /** A confirmed reset requires the previous reading to be at least this used… */
  PREV_USED_MIN: 20,
  /** …and the current reading to be at most this used… */
  CURR_USED_MAX: 5,
  /** …with a drop of at least this many percentage points. */
  MIN_DROP: 20,
} as const;

export const REMAINING_TASKS = {
  /** Minimum valid same-type activities before a formal range is produced. */
  MIN_SAMPLES: 3,
  OUTLIER_IQR_FACTOR: 1.5,
} as const;

export const RUNWAY = {
  /** At or below this share of the safe pace, usage has a comfortable buffer. */
  COMFORTABLE_PACE_RATIO: 0.85,
  /** Above the safe pace, the current allowance may run out before reset. */
  SLOW_DOWN_PACE_RATIO: 1,
} as const;

export const PLAN_RECOMMENDATION = {
  MIN_CYCLES: 4,
  MIN_DAYS: 28,
  UPGRADE_MIN_EARLY_EXHAUSTED_CYCLES: 3,
  UPGRADE_MIN_AVG_UTILIZATION: 90,
  UPGRADE_MIN_AVG_EARLY_HOURS: 12,
  KEEP_MIN_UTILIZATION: 50,
  KEEP_MAX_UTILIZATION: 90,
  DOWNGRADE_MAX_AVG_UTILIZATION: 45,
} as const;

export const CONFIDENCE = {
  LOW_MAX: 0.39,
  MEDIUM_MAX: 0.69,
  /** Data older than this many hours starts to sharply erode confidence. */
  STALE_AFTER_HOURS: 8,
  FRESH_WITHIN_HOURS: 1,
} as const;

export const THRESHOLDS = {
  /** Default "about to run out" warning trigger, in remaining %. Overridable in Settings. */
  USAGE_WARNING_REMAINING_PERCENT: 15,
  /** Data considered stale after this many hours without a successful update. */
  DATA_STALE_HOURS: 8,
  /** Warn if exhaustion is forecast to occur within this many hours before reset. */
  EXHAUSTION_WARNING_LEAD_HOURS: 6,
  /** Warn about unused allowance shortly before the provider resets it. */
  QUOTA_EXPIRY_MIN_REMAINING_PERCENT: 20,
  QUOTA_EXPIRY_WINDOW_RATIO: 0.2,
  QUOTA_EXPIRY_MIN_LEAD_HOURS: 1,
  QUOTA_EXPIRY_MAX_LEAD_HOURS: 24,
} as const;

export const NOTIFICATION = {
  MAX_ATTEMPTS: 3,
  /** Fixed backoff base (ms); attempt N waits BASE * 2^(N-1) with a cap. */
  BACKOFF_BASE_MS: 30_000,
  BACKOFF_MAX_MS: 15 * 60_000,
  DEFAULT_MIN_INTERVAL_MINUTES: 0,
} as const;

export const SCHEDULER = {
  DEFAULT_INTERVAL_HOURS: 1,
} as const;

/** Default provider plan templates. Prices/capacity are EDITABLE by the user — never treated
 *  as permanent official numbers (spec §8 flow 2). Values are illustrative defaults only. */
export const CLAUDE_DEFAULT_PLANS: ReadonlyArray<{
  name: string;
  monthlyPrice: number;
  currency: string;
  relativeCapacity: number;
}> = [
  { name: "Pro", monthlyPrice: 20, currency: "USD", relativeCapacity: 1 },
  { name: "Max 5x", monthlyPrice: 100, currency: "USD", relativeCapacity: 5 },
  { name: "Max 20x", monthlyPrice: 200, currency: "USD", relativeCapacity: 20 },
  { name: "Custom", monthlyPrice: 0, currency: "USD", relativeCapacity: 1 },
];

export const SCHEMA_VERSION = 1;
export const EXPORT_SCHEMA_VERSION = 1;
