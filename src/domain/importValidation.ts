// JSON import validation (spec §15). Pure. A malformed import must NEVER corrupt existing data —
// this validator only inspects and reports; it never mutates anything.

import { EXPORT_SCHEMA_VERSION } from "./constants";

export type ExportBundle = {
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  providerAccounts: unknown[];
  plans: unknown[];
  limits: unknown[];
  snapshots: unknown[];
  activities: unknown[];
  resetEvents: unknown[];
  notificationChannels: unknown[];
  settings: Record<string, unknown>;
};

export type CollectionReport = {
  name: string;
  total: number;
  valid: number;
  invalid: number;
  invalidReasons: string[];
};

export type ImportValidationResult = {
  ok: boolean;
  schemaVersion?: number;
  errors: string[];
  warnings: string[];
  collections: CollectionReport[];
  /** Keys that look like secrets and were found in the file (they will be ignored, never imported). */
  strippedSecretKeys: string[];
};

const SECRET_KEY_PATTERN = /(secret(?!ref)|token|webhook.*url|password|cookie|apikey|api_key|bot_?token)/i;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function findSecretKeys(value: unknown, acc: Set<string>, depth = 0): void {
  if (depth > 6 || !isObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(k) && k.toLowerCase() !== "secretref") {
      // Only flag when it actually carries a non-empty value.
      if (v !== undefined && v !== null && v !== "") acc.add(k);
    }
    if (isObject(v)) findSecretKeys(v, acc, depth + 1);
    if (Array.isArray(v)) v.forEach((item) => findSecretKeys(item, acc, depth + 1));
  }
}

type FieldSpec = { key: string; check: (v: unknown) => boolean; required: boolean };

function validateCollection(name: string, arr: unknown, specs: FieldSpec[]): CollectionReport {
  const report: CollectionReport = { name, total: 0, valid: 0, invalid: 0, invalidReasons: [] };
  if (!Array.isArray(arr)) {
    report.invalidReasons.push(`${name} 不是陣列`);
    return report;
  }
  report.total = arr.length;
  for (const item of arr) {
    if (!isObject(item)) {
      report.invalid++;
      continue;
    }
    let ok = true;
    for (const spec of specs) {
      const present = item[spec.key] !== undefined && item[spec.key] !== null;
      if (spec.required && !present) {
        ok = false;
        report.invalidReasons.push(`${name}: 缺少 ${spec.key}`);
        break;
      }
      if (present && !spec.check(item[spec.key])) {
        ok = false;
        report.invalidReasons.push(`${name}: ${spec.key} 型別錯誤`);
        break;
      }
    }
    if (ok) report.valid++;
    else report.invalid++;
  }
  // dedupe reasons
  report.invalidReasons = [...new Set(report.invalidReasons)].slice(0, 5);
  return report;
}

export function validateImport(raw: unknown): ImportValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(raw)) {
    return {
      ok: false,
      errors: ["匯入內容不是有效的 JSON 物件"],
      warnings: [],
      collections: [],
      strippedSecretKeys: [],
    };
  }

  const schemaVersion = raw["schemaVersion"];
  if (!isNumber(schemaVersion)) {
    errors.push("缺少或無效的 schemaVersion");
  } else if (schemaVersion > EXPORT_SCHEMA_VERSION) {
    errors.push(
      `匯入檔的 schemaVersion (${schemaVersion}) 高於本 App 支援的版本 (${EXPORT_SCHEMA_VERSION})`
    );
  } else if (schemaVersion < EXPORT_SCHEMA_VERSION) {
    warnings.push(`匯入檔為較舊的 schemaVersion (${schemaVersion})，將嘗試相容處理`);
  }

  const secretKeys = new Set<string>();
  findSecretKeys(raw, secretKeys);
  if (secretKeys.size > 0) {
    warnings.push("匯入檔含有疑似機密欄位，將被忽略且不會匯入");
  }

  const collections: CollectionReport[] = [
    validateCollection("providerAccounts", raw["providerAccounts"], [
      { key: "id", check: isString, required: true },
      { key: "providerId", check: isString, required: true },
      { key: "displayName", check: isString, required: true },
    ]),
    validateCollection("plans", raw["plans"], [
      { key: "id", check: isString, required: true },
      { key: "accountId", check: isString, required: true },
      { key: "name", check: isString, required: true },
      { key: "monthlyPrice", check: isNumber, required: true },
    ]),
    validateCollection("limits", raw["limits"], [
      { key: "id", check: isString, required: true },
      { key: "planId", check: isString, required: true },
      { key: "type", check: isString, required: true },
    ]),
    validateCollection("snapshots", raw["snapshots"], [
      { key: "id", check: isString, required: true },
      { key: "limitId", check: isString, required: true },
      { key: "usedPercent", check: isNumber, required: true },
      { key: "capturedAt", check: isString, required: true },
    ]),
    validateCollection("activities", raw["activities"], [
      { key: "id", check: isString, required: true },
      { key: "limitId", check: isString, required: true },
      { key: "taskType", check: isString, required: true },
      { key: "startedAt", check: isString, required: true },
    ]),
    validateCollection("resetEvents", raw["resetEvents"], [
      { key: "id", check: isString, required: true },
      { key: "limitId", check: isString, required: true },
      { key: "detectedAt", check: isString, required: true },
    ]),
  ];

  const ok = errors.length === 0 && collections.every((c) => c.total === 0 || c.valid > 0);

  return {
    ok,
    schemaVersion: isNumber(schemaVersion) ? schemaVersion : undefined,
    errors,
    warnings,
    collections,
    strippedSecretKeys: [...secretKeys],
  };
}
