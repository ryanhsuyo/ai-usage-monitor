import { beforeEach, describe, expect, it } from "vitest";
import type { UsageSnapshot } from "@/domain/types";
import { FakeSqlDatabase } from "./fakeDb";
import {
  createActivityRepository,
  createNotificationRepository,
  createProviderRepository,
  createSchedulerRepository,
  createSettingsRepository,
  createSnapshotRepository,
} from "./repositories";

const NOW = "2026-07-13T10:00:00.000Z";

function snapshot(partial: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    id: `s-${Math.random().toString(36).slice(2)}`,
    providerId: "claude",
    accountId: "acc-1",
    limitId: "lim-1",
    usedPercent: 40,
    remainingPercent: 60,
    capturedAt: NOW,
    source: "manual",
    valid: true,
    confidence: 1,
    ...partial,
  };
}

describe("repository layer over SqlDatabase (spec §20 repository cases)", () => {
  let db: FakeSqlDatabase;

  beforeEach(() => {
    db = new FakeSqlDatabase();
  });

  it("inserts and reads back accounts/plans/limits with type round-trip", async () => {
    const repo = createProviderRepository(db);
    await repo.saveAccount({
      id: "acc-1",
      providerId: "claude",
      displayName: "Main",
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.savePlan({
      id: "plan-1",
      providerId: "claude",
      accountId: "acc-1",
      name: "Max 5x",
      monthlyPrice: 100,
      currency: "USD",
      relativeCapacity: 5,
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.saveLimit({
      id: "lim-1",
      planId: "plan-1",
      name: "Weekly",
      type: "weekly",
      timezone: "Asia/Taipei",
      active: true,
      monitoringEnabled: true,
      notifyEnabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const accounts = await repo.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.active).toBe(true);

    const plans = await repo.listPlans();
    expect(plans[0]!.monthlyPrice).toBe(100);
    expect(plans[0]!.relativeCapacity).toBe(5);

    const limits = await repo.listLimits();
    expect(limits[0]!.type).toBe("weekly");
    expect(limits[0]!.monitoringEnabled).toBe(true);
  });

  it("upserts on repeated save (same id) instead of duplicating", async () => {
    const repo = createProviderRepository(db);
    const base = {
      id: "acc-1",
      providerId: "claude" as const,
      displayName: "Old",
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repo.saveAccount(base);
    await repo.saveAccount({ ...base, displayName: "New" });
    const accounts = await repo.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.displayName).toBe("New");
  });

  it("insert snapshot + query latest valid; invalid ones are skipped", async () => {
    const repo = createSnapshotRepository(db);
    await repo.insert(snapshot({ id: "s1", usedPercent: 10, capturedAt: "2026-07-13T08:00:00Z" }));
    await repo.insert(
      snapshot({ id: "s2", usedPercent: 0, capturedAt: "2026-07-13T09:00:00Z", valid: false })
    );
    await repo.insert(snapshot({ id: "s3", usedPercent: 20, capturedAt: "2026-07-13T09:30:00Z" }));

    const latest = await repo.latestValidByLimit("lim-1");
    expect(latest?.id).toBe("s3");
    expect(latest?.usedPercent).toBe(20);

    const all = await repo.listByLimit("lim-1");
    expect(all).toHaveLength(3);
    // history is never silently overwritten: s2 (invalid) is preserved as a failure record
    expect(all.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("deletes a snapshot by id (bad-snapshot cleanup flow)", async () => {
    const repo = createSnapshotRepository(db);
    await repo.insert(snapshot({ id: "s1" }));
    await repo.deleteById("s1");
    expect(await repo.listAll()).toHaveLength(0);
  });

  it("activities: insert, update to completed with delta, list by limit", async () => {
    const repo = createActivityRepository(db);
    await repo.insert({
      id: "a1",
      providerId: "claude",
      accountId: "acc-1",
      limitId: "lim-1",
      taskType: "coding",
      startedAt: NOW,
      status: "in_progress",
      usageBefore: 40,
    });
    await repo.update({
      id: "a1",
      providerId: "claude",
      accountId: "acc-1",
      limitId: "lim-1",
      taskType: "coding",
      startedAt: NOW,
      endedAt: "2026-07-13T11:00:00.000Z",
      status: "completed",
      usageBefore: 40,
      usageAfter: 46,
      usageDelta: 6,
    });
    const list = await repo.listByLimit("lim-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("completed");
    expect(list[0]!.usageDelta).toBe(6);
  });

  it("notification dedup: unique (event_key, channel_id) is enforced at the storage level", async () => {
    const repo = createNotificationRepository(db);
    const delivery = {
      id: "d1",
      eventId: "e1",
      eventKey: "claude:weekly:reset_confirmed:2026-07-20T07:00:00.000Z",
      channelId: "ch-1",
      status: "sent" as const,
      attemptCount: 1,
      deliveredAt: NOW,
    };
    await repo.insertDelivery(delivery);
    await expect(repo.insertDelivery({ ...delivery, id: "d2" })).rejects.toThrow(/UNIQUE/);
    // same event on a DIFFERENT channel is fine
    await repo.insertDelivery({ ...delivery, id: "d3", channelId: "ch-2" });
    const all = await repo.listDeliveries({ eventKey: delivery.eventKey });
    expect(all).toHaveLength(2);
  });

  it("notification channels round-trip preferences and never store secret values", async () => {
    const repo = createNotificationRepository(db);
    await repo.saveChannel({
      id: "ch-1",
      type: "discord",
      displayName: "My Discord",
      enabled: true,
      secretRef: "notification-channel:discord:ch-1",
      eventPreferences: {
        reset_expected: false,
        reset_confirmed: true,
        usage_warning: true,
        exhaustion_forecast: true,
        polling_failed: false,
        data_stale: false,
      },
      quietHoursStart: "23:00",
      quietHoursEnd: "08:00",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const channels = await repo.listChannels();
    expect(channels[0]!.eventPreferences.reset_confirmed).toBe(true);
    expect(channels[0]!.eventPreferences.reset_expected).toBe(false);
    expect(channels[0]!.secretRef).toContain("notification-channel:");
    // the raw table must not contain anything but the ref
    const raw = db.tables.get("notification_channels")![0]!;
    expect(JSON.stringify(raw)).not.toContain("https://");
  });

  it("app settings: set, overwrite, read all", async () => {
    const repo = createSettingsRepository(db);
    await repo.set("polling.enabled", "true");
    await repo.set("polling.enabled", "false");
    await repo.set("timezone", "Asia/Taipei");
    expect(await repo.get("polling.enabled")).toBe("false");
    const all = await repo.getAll();
    expect(Object.keys(all)).toHaveLength(2);
  });

  it("scheduler runs: single-flight guard via hasRunningRun", async () => {
    const repo = createSchedulerRepository(db);
    expect(await repo.hasRunningRun()).toBe(false);
    await repo.insertRun({ id: "r1", startedAt: NOW, status: "running", trigger: "launch" });
    expect(await repo.hasRunningRun()).toBe(true);
    await repo.updateRun({
      id: "r1",
      startedAt: NOW,
      finishedAt: "2026-07-13T10:01:00.000Z",
      status: "success",
      trigger: "launch",
    });
    expect(await repo.hasRunningRun()).toBe(false);
    const latest = await repo.latestRun();
    expect(latest?.status).toBe("success");
  });
});
