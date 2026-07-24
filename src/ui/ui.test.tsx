// UI tests (spec §20). Rendered against the in-memory service stack (no Tauri runtime in jsdom —
// appServices automatically falls back to FakeSqlDatabase + InMemory adapters).

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { getAppServices } from "./appServices";
import { useAppStore } from "./state/store";
import { SETTINGS_KEYS } from "@/services/settingsKeys";
import { newId, nowIso } from "@/services/ids";
import { Modal } from "./components/atoms";

async function resetAll() {
  const services = await getAppServices();
  // wipe fake DB between tests
  for (const sn of await services.snapshotRepo.listAll()) await services.snapshotRepo.deleteById(sn.id);
  for (const a of await services.activityRepo.listAll()) await services.activityRepo.deleteById(a.id);
  for (const l of await services.providerRepo.listLimits()) await services.providerRepo.deleteLimit(l.id);
  for (const p of await services.providerRepo.listPlans()) await services.providerRepo.deletePlan(p.id);
  for (const acc of await services.providerRepo.listAccounts())
    await services.providerRepo.deleteAccount(acc.id);
  for (const c of await services.notificationRepo.listChannels())
    await services.notificationRepo.deleteChannel(c.id);
  await services.settingsRepo.set(SETTINGS_KEYS.onboardingCompleted, "true");
  await services.settingsRepo.set(SETTINGS_KEYS.demoMode, "false");
  await services.settingsRepo.set(SETTINGS_KEYS.notificationsEnabled, "true");
  await services.settingsRepo.set(SETTINGS_KEYS.skillsInsightsEnabled, "false");
  useAppStore.setState({ page: "dashboard", selectedLimitId: undefined, loaded: false });
}

async function seedBasicLimit() {
  const services = await getAppServices();
  const now = nowIso();
  await services.providerRepo.saveAccount({
    id: "acc-ui",
    providerId: "claude",
    displayName: "UI 測試帳號",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await services.providerRepo.savePlan({
    id: "plan-ui",
    providerId: "claude",
    accountId: "acc-ui",
    name: "Max 5x",
    monthlyPrice: 100,
    currency: "USD",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await services.providerRepo.saveLimit({
    id: "lim-ui",
    planId: "plan-ui",
    name: "Weekly（全模型）",
    type: "weekly",
    timezone: "UTC",
    active: true,
    monitoringEnabled: true,
    notifyEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedSnapshot(usedPercent: number, hoursAgo = 0) {
  const services = await getAppServices();
  await services.snapshotRepo.insert({
    id: newId("snap"),
    providerId: "claude",
    accountId: "acc-ui",
    limitId: "lim-ui",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
    capturedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    source: "manual",
    valid: true,
    confidence: 1,
  });
}

beforeEach(async () => {
  localStorage.clear();
  await resetAll();
});

afterEach(() => {
  cleanup();
});

describe("Onboarding", () => {
  it("auto-detects supported local sources without asking for account or subscription price", async () => {
    const services = await getAppServices();
    await services.settingsRepo.set(SETTINGS_KEYS.onboardingCompleted, "false");

    render(<App />);

    expect(await screen.findByText("自動尋找用量來源")).toBeInTheDocument();
    expect(screen.getByText("OpenAI / Codex")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT 網頁聊天")).toBeInTheDocument();
    expect(screen.getByText("目前不支援")).toBeInTheDocument();
    expect(screen.queryByLabelText("帳號顯示名稱")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("月費")).not.toBeInTheDocument();
  });
});

describe("Shared accessibility", () => {
  it("moves focus into a modal and traps keyboard focus inside it", async () => {
    const user = userEvent.setup();
    render(
      <Modal title="鍵盤測試" onClose={() => undefined}>
        <button type="button">主要操作</button>
      </Modal>
    );

    const close = await screen.findByRole("button", { name: "關閉" });
    const action = screen.getByRole("button", { name: "主要操作" });
    await waitFor(() => expect(close).toHaveFocus());
    await user.tab({ shift: true });
    expect(action).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it("shows the custom minimize control only in borderless widget mode", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("還沒有任何監控目標");
    expect(screen.queryByRole("button", { name: "縮到 Dock 或工作列" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "小工具" }));
    expect(screen.getByRole("button", { name: "縮到 Dock 或工作列" })).toBeInTheDocument();
  });
});

describe("Skills Insights privacy", () => {
  it("requires explicit consent before local skill analysis and can be disabled", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Skills Insights" }));
    expect(await screen.findByText("啟用本機 Skills 分析？")).toBeInTheDocument();
    expect(screen.getByText("預設關閉")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新掃描" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "啟用 Skills Insights" }));
    expect(await screen.findByRole("button", { name: "停用" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "重新掃描" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "停用" }));
    expect(await screen.findByText("啟用本機 Skills 分析？")).toBeInTheDocument();
  });
});

describe("Dashboard", () => {
  it("empty state offers plan creation and demo data", async () => {
    render(<App />);
    expect(await screen.findByText("還沒有任何監控目標")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "建立方案與額度" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "載入 Demo 資料" })).toBeInTheDocument();
  });

  it("shows current usage and does NOT show fake task estimates without activities", async () => {
    await seedBasicLimit();
    await seedSnapshot(40, 2);
    await seedSnapshot(50, 1);
    render(<App />);
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByLabelText("使用節奏")).toBeInTheDocument();
    expect(screen.queryByLabelText("進階相似任務估算")).not.toBeInTheDocument();
  });

  it("plan recommendation shows insufficient data for a fresh setup", async () => {
    await seedBasicLimit();
    await seedSnapshot(30);
    render(<App />);
    const card = await screen.findByLabelText("方案建議");
    expect(within(card).getByText("資料不足")).toBeInTheDocument();
  });

  it("low-confidence forecast shows reasons", async () => {
    await seedBasicLimit();
    await seedSnapshot(40, 10); // stale, single sample
    render(<App />);
    const card = await screen.findByLabelText("用量續航");
    await waitFor(() => {
      expect(within(card).getByLabelText("可信度原因")).toBeInTheDocument();
    });
  });

  it("adds a manual snapshot through the modal", async () => {
    await seedBasicLimit();
    await seedSnapshot(40, 1);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("40%");
    await user.click(screen.getByRole("button", { name: "＋ 新增快照" }));
    await user.type(screen.getByLabelText("已使用百分比"), "55");
    await user.click(screen.getByRole("button", { name: "儲存快照" }));
    await waitFor(() => {
      expect(screen.getByText("55%")).toBeInTheDocument();
    });
  });

  it("rejects an invalid manual snapshot with an error message", async () => {
    await seedBasicLimit();
    await seedSnapshot(40, 1);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("40%");
    await user.click(screen.getByRole("button", { name: "＋ 新增快照" }));
    await user.type(screen.getByLabelText("已使用百分比"), "150");
    await user.click(screen.getByRole("button", { name: "儲存快照" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("0");
    // still on the modal; nothing saved
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Demo mode", () => {
  it("loads demo data with a visible banner and clears it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "載入 Demo 資料" }));
    expect(await screen.findByText("Demo Mode")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除 Demo 資料" }));
    await waitFor(() => {
      expect(screen.queryByText("Demo Mode")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("還沒有任何監控目標")).toBeInTheDocument();
  });
});

describe("Notifications page", () => {
  it("selects notification targets and explains Discord setup", async () => {
    await seedBasicLimit();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "通知設定" }));

    const target = await screen.findByRole("switch", { name: "通知 Weekly（全模型）" });
    expect(target).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByText("分開設定這個額度的通知事件"));
    const perLimitEvent = screen.getByRole("switch", { name: "Weekly（全模型） — 即將用完" });
    await user.click(perLimitEvent);
    await waitFor(async () => {
      const raw = await (await getAppServices()).settingsRepo.get(SETTINGS_KEYS.limitEventPreferences);
      expect(JSON.parse(raw ?? "{}")["lim-ui"].usage_warning).toBe(false);
    });
    await user.click(target);
    await waitFor(async () => {
      const limit = (await (await getAppServices()).providerRepo.listLimits()).find((item) => item.id === "lim-ui");
      expect(limit?.notifyEnabled).toBe(false);
    });

    const threshold = screen.getByRole("spinbutton", { name: "即將用完門檻（剩餘百分比）" });
    await user.clear(threshold);
    await user.type(threshold, "25");
    await user.tab();
    await waitFor(async () => {
      expect(await (await getAppServices()).settingsRepo.get(SETTINGS_KEYS.usageWarningRemainingPercent)).toBe("25");
    });
    expect(await screen.findByText("已設定：剩餘 25% 時通知")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "＋ 連接 Discord" }));
    expect(await screen.findByText("如何取得 Discord Webhook URL")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("https://discord.com/api/webhooks/…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "儲存並測試" })).toBeInTheDocument();
  });

  it("toggles channels and events; master switch disables everything", async () => {
    await seedBasicLimit();
    const services = await getAppServices();
    await services.notificationRepo.saveChannel({
      id: "ch-ui",
      type: "desktop",
      displayName: "桌面通知",
      enabled: true,
      eventPreferences: {
        quota_expiring: true, reset_expected: true,
        reset_confirmed: true,
        usage_warning: true, usage_exhausted: true,
        exhaustion_forecast: true,
        polling_failed: false,
        data_stale: false,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "通知設定" }));

    // per-event toggle
    const eventSwitch = await screen.findByRole("switch", { name: "桌面通知 — 額度已重置" });
    expect(eventSwitch).toHaveAttribute("aria-checked", "true");
    await user.click(eventSwitch);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "桌面通知 — 額度已重置" })).toHaveAttribute(
        "aria-checked",
        "false"
      )
    );

    // master off disables the channel/event switches
    await user.click(screen.getByRole("switch", { name: "啟用所有通知" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "啟用 桌面通知" })).toBeDisabled()
    );
  });

  it("test notification reports success and failure", async () => {
    const services = await getAppServices();
    await services.notificationRepo.saveChannel({
      id: "ch-test",
      type: "desktop",
      displayName: "桌面",
      enabled: true,
      eventPreferences: {
        quota_expiring: true, reset_expected: true,
        reset_confirmed: true,
        usage_warning: true, usage_exhausted: true,
        exhaustion_forecast: true,
        polling_failed: false,
        data_stale: false,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "通知設定" }));
    await user.click(await screen.findByRole("button", { name: "測試連線" }));
    expect(await screen.findByText(/已送出測試通知/)).toBeInTheDocument();

    // failing channel: discord without a secret
    await services.notificationRepo.saveChannel({
      id: "ch-fail",
      type: "discord",
      displayName: "Discord 失敗",
      enabled: true,
      eventPreferences: {
        quota_expiring: true, reset_expected: false,
        reset_confirmed: true,
        usage_warning: true, usage_exhausted: true,
        exhaustion_forecast: true,
        polling_failed: false,
        data_stale: false,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await useAppStore.getState().refresh();
    const rows = await screen.findAllByRole("button", { name: "測試連線" });
    await user.click(rows[rows.length - 1]!);
    expect(await screen.findByText(/測試失敗/)).toBeInTheDocument();
  });
});

describe("Settings", () => {
  it("toggles background monitoring and auto start", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "設定" }));

    const polling = await screen.findByRole("switch", { name: "每小時背景檢查" });
    expect(polling).toHaveAttribute("aria-checked", "true");
    await user.click(polling);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "每小時背景檢查" })).toHaveAttribute(
        "aria-checked",
        "false"
      )
    );

    const autostart = screen.getByRole("switch", { name: "開機自動啟動" });
    expect(autostart).toHaveAttribute("aria-checked", "false");
    await user.click(autostart);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "開機自動啟動" })).toHaveAttribute(
        "aria-checked",
        "true"
      )
    );
  });

  it("persists compact widget size and right-side information preferences", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "設定" }));

    await user.selectOptions(screen.getByLabelText("顯示尺寸"), "large");
    await user.selectOptions(screen.getByLabelText("右側資訊"), "cost");

    await waitFor(async () => {
      const services = await getAppServices();
      expect(await services.settingsRepo.get("widget.stripSize")).toBe("large");
      expect(await services.settingsRepo.get("widget.stripRightInfo")).toBe("cost");
    });
  });
});

describe("History", () => {
  it("shows reset events and failed captures distinctly", async () => {
    await seedBasicLimit();
    const services = await getAppServices();
    await seedSnapshot(80, 30);
    await seedSnapshot(3, 20);
    await services.snapshotRepo.insert({
      id: "snap-fail",
      providerId: "claude",
      accountId: "acc-ui",
      limitId: "lim-ui",
      usedPercent: 0,
      remainingPercent: 0,
      capturedAt: new Date(Date.now() - 10 * 3600_000).toISOString(),
      source: "manual",
      valid: false,
      confidence: 0,
      errorCode: "fetch_failed",
    });
    await services.resetRepo.insert({
      id: "reset-ui",
      providerId: "claude",
      accountId: "acc-ui",
      limitId: "lim-ui",
      detectedAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
      detectionMethod: "confirmed_by_usage_drop",
      confidence: 0.9,
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "用量趨勢" }));
    expect(await screen.findByText(/失敗：fetch_failed/)).toBeInTheDocument();
    expect(screen.getAllByText("有效").length).toBeGreaterThan(0);
    // chart legend marks reset events
    expect(screen.getByLabelText("用量趨勢圖")).toBeInTheDocument();
  });
});

describe("Secrets never reach the UI store or DB", () => {
  it("secret values are not present in exported JSON or channel rows", async () => {
    const services = await getAppServices();
    const secretValue = "https://discord.com/api/webhooks/1/TOP-SECRET-TOKEN";
    await services.secretStore.setSecret("notification-channel:discord:x", secretValue);
    await services.notificationRepo.saveChannel({
      id: "x",
      type: "discord",
      displayName: "D",
      enabled: true,
      secretRef: "notification-channel:discord:x",
      eventPreferences: {
        quota_expiring: true, reset_expected: false,
        reset_confirmed: true,
        usage_warning: true, usage_exhausted: true,
        exhaustion_forecast: true,
        polling_failed: false,
        data_stale: false,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const bundle = await services.exportImport.exportBundle();
    expect(JSON.stringify(bundle)).not.toContain("TOP-SECRET-TOKEN");
    const channels = await services.notificationRepo.listChannels();
    expect(JSON.stringify(channels)).not.toContain("TOP-SECRET-TOKEN");
  });
});
