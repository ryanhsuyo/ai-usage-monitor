// Snapshot input validation (spec §8 flow 4). A fetch error must NEVER be silently turned into 0%.

import { isValidIso } from "./util";

export type SnapshotInput = {
  usedPercent?: number;
  remainingPercent?: number;
  capturedAt?: string;
  resetAt?: string;
  errorCode?: string;
};

export type SnapshotValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Normalised values when valid (used/remaining reconciled). */
  normalized?: { usedPercent: number; remainingPercent: number };
};

const RECONCILE_TOLERANCE = 1.5; // percentage points

export function validateSnapshot(input: SnapshotInput): SnapshotValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // A reported fetch error must not be coerced into a usage value.
  if (input.errorCode) {
    errors.push(`data source reported an error (${input.errorCode}); not stored as usage`);
  }

  const hasUsed = typeof input.usedPercent === "number" && Number.isFinite(input.usedPercent);
  const hasRemaining =
    typeof input.remainingPercent === "number" && Number.isFinite(input.remainingPercent);

  if (!hasUsed && !hasRemaining) {
    errors.push("either usedPercent or remainingPercent is required");
  }

  let used = hasUsed ? (input.usedPercent as number) : undefined;
  let remaining = hasRemaining ? (input.remainingPercent as number) : undefined;

  if (used !== undefined && (used < 0 || used > 100)) {
    errors.push("usedPercent must be between 0 and 100");
  }
  if (remaining !== undefined && (remaining < 0 || remaining > 100)) {
    errors.push("remainingPercent must be between 0 and 100");
  }

  if (used !== undefined && remaining !== undefined) {
    const sum = used + remaining;
    if (Math.abs(sum - 100) > RECONCILE_TOLERANCE) {
      errors.push(
        `usedPercent (${used}) and remainingPercent (${remaining}) do not add up to ~100`
      );
    }
  } else if (used !== undefined && remaining === undefined) {
    remaining = 100 - used;
  } else if (remaining !== undefined && used === undefined) {
    used = 100 - remaining;
  }

  if (!isValidIso(input.capturedAt)) {
    errors.push("capturedAt must be a valid ISO 8601 timestamp");
  }
  if (input.resetAt !== undefined && !isValidIso(input.resetAt)) {
    errors.push("resetAt must be a valid ISO 8601 timestamp when provided");
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    warnings,
    normalized:
      valid && used !== undefined && remaining !== undefined
        ? { usedPercent: used, remainingPercent: remaining }
        : undefined,
  };
}
