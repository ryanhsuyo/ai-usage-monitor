import { isTauriRuntime } from ".";

export type SkillPlatform = "codex" | "claude";

export type SkillInventoryItem = {
  key: string;
  name: string;
  platform: SkillPlatform;
  description: string;
  source: string;
  version?: string;
};

export type SkillUsageItem = {
  key: string;
  name: string;
  platform: SkillPlatform;
  confirmedAllTime: number;
  confirmed30d: number;
  probableAllTime: number;
  probable30d: number;
  lastUsedAt?: string;
};

export type SkillMonitorSnapshot = {
  capturedAt: string;
  inventory: SkillInventoryItem[];
  usage: SkillUsageItem[];
  warnings: string[];
};

let cachedSnapshot: SkillMonitorSnapshot | undefined;
let pendingScan: Promise<SkillMonitorSnapshot> | undefined;
let cacheGeneration = 0;

export function clearSkillMonitorCache() {
  cacheGeneration += 1;
  cachedSnapshot = undefined;
  pendingScan = undefined;
}

export async function readSkillMonitor(force = false): Promise<SkillMonitorSnapshot> {
  if (!force && cachedSnapshot) return cachedSnapshot;
  if (pendingScan) return pendingScan;

  if (!isTauriRuntime()) {
    return {
      capturedAt: new Date().toISOString(),
      inventory: [],
      usage: [],
      warnings: ["Skill 盤點只在桌面 App 中讀取本機資料。"],
    };
  }

  const generation = cacheGeneration;
  const request = import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<SkillMonitorSnapshot>("read_skill_monitor"))
    .then((snapshot) => {
      if (generation === cacheGeneration) cachedSnapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      if (pendingScan === request) pendingScan = undefined;
    });
  pendingScan = request;
  return request;
}
