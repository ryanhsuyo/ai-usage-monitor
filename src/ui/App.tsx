// App shell: sidebar navigation, demo banner, page routing, bootstrap (scheduler + tray wiring).
// Replaces the earlier localStorage prototype with the SQLite-backed app; the prototype's visual
// language (provider marks, stats row, card grid) lives on in the pages.

import { useEffect, useState } from "react";
import { getAppServices } from "./appServices";
import { toast, ToastRegion } from "./components/atoms";
import { useAppStore, type PageId } from "./state/store";
import { DashboardPage } from "./pages/Dashboard";
import { HistoryPage } from "./pages/History";
import { ActivityPage } from "./pages/Activity";
import { PlansPage } from "./pages/Plans";
import { DataSourcesPage } from "./pages/DataSources";
import { NotificationsPage } from "./pages/Notifications";
import { SettingsPage } from "./pages/Settings";
import { OnboardingPage } from "./pages/Onboarding";
import { latestValid } from "./derive";
import { SETTINGS_KEYS, settingBool } from "@/services/settingsKeys";

const NAV: Array<{ id: PageId; icon: string; label: string }> = [
  { id: "dashboard", icon: "▦", label: "總覽" },
  { id: "history", icon: "↗", label: "用量趨勢" },
  { id: "activity", icon: "▷", label: "活動紀錄" },
  { id: "plans", icon: "◈", label: "方案與額度" },
  { id: "dataSources", icon: "◎", label: "資料來源" },
  { id: "notifications", icon: "♧", label: "通知設定" },
  { id: "settings", icon: "⚙", label: "設定" },
];

/** One-time app bootstrap: initial load, scheduler start, tray events, background mode. */
function useBootstrap() {
  const refresh = useAppStore((s) => s.refresh);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const services = await getAppServices();
      await refresh();

      // apply the persisted background-mode preference to the native layer
      const bg = settingBool(
        await services.settingsRepo.get(SETTINGS_KEYS.backgroundEnabled),
        true
      );
      if (bg) await services.backgroundRuntime.start().catch(() => undefined);
      else await services.backgroundRuntime.stop().catch(() => undefined);

      // hourly scheduler + immediate launch check (single-flight guarded inside)
      services.scheduler.start();

      // compact status line on the tray icon after every refresh
      async function updateTray() {
        if (!services.isTauri) return;
        try {
          const state = useAppStore.getState();
          const limit = state.limits.find((l) => l.id === state.selectedLimitId);
          const latest = limit ? latestValid(state.snapshotsByLimit[limit.id] ?? []) : undefined;
          const text = latest
            ? `${limit?.name ?? ""}：剩餘 ${Math.round(latest.remainingPercent)}%`
            : "AI Usage Monitor";
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("update_tray_tooltip", { tooltip: text });
        } catch {
          /* tray is non-critical */
        }
      }
      await updateTray();

      // tray menu events forwarded from Rust (no business logic lives in the tray handler)
      if (services.isTauri) {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("tray://action", (event) => {
          void (async () => {
            const action = event.payload;
            if (action === "check_now") {
              await services.monitor.runOnce("manual").catch(() => undefined);
              await refresh();
              toast.success("已完成一次立即檢查");
            } else if (action === "pause") {
              await services.settingsRepo.set(SETTINGS_KEYS.monitoringPaused, "true");
              await refresh();
              toast.info("已暫停監控");
            } else if (action === "resume") {
              await services.settingsRepo.set(SETTINGS_KEYS.monitoringPaused, "false");
              await refresh();
              toast.success("已恢復監控");
            } else if (action === "toggle_notifications") {
              const cur = settingBool(
                await services.settingsRepo.get(SETTINGS_KEYS.notificationsEnabled),
                true
              );
              await services.settingsRepo.set(SETTINGS_KEYS.notificationsEnabled, String(!cur));
              await refresh();
              toast.info(!cur ? "已開啟通知" : "已關閉通知");
            }
            await updateTray();
          })();
        });
      }

      if (!disposed) setReady(true);
    })().catch((err) => {
      toast.error(`初始化失敗：${err instanceof Error ? err.message : String(err)}`);
      setReady(true);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ready;
}

export function App() {
  const ready = useBootstrap();
  const store = useAppStore();

  if (!ready || !store.loaded) {
    return (
      <div className="loading" role="status">
        <span className="spinner" aria-hidden />
        載入中…
      </div>
    );
  }

  if (!store.onboardingCompleted) {
    return (
      <main style={{ minHeight: "100vh", display: "block", padding: "38px 44px 60px" }}>
        <OnboardingPage />
        <ToastRegion />
      </main>
    );
  }

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            A
          </span>
          <div>
            Usage Monitor
            <small>LOCAL · PRIVATE</small>
          </div>
        </div>
        <nav aria-label="主選單">
          {NAV.filter((n) => n.id !== "settings").map((item) => (
            <button
              key={item.id}
              type="button"
              className={store.page === item.id ? "active" : ""}
              aria-current={store.page === item.id ? "page" : undefined}
              onClick={() => store.navigate(item.id)}
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <button
            type="button"
            className={store.page === "settings" ? "active" : ""}
            aria-current={store.page === "settings" ? "page" : undefined}
            onClick={() => store.navigate("settings")}
          >
            <span aria-hidden>⚙</span>設定
          </button>
          <div className="privacy">
            <i aria-hidden />
            所有資料僅儲存在此裝置
          </div>
        </div>
      </aside>

      <main>
        {store.demoMode && (
          <div className="banner demo" role="status">
            <strong>Demo Mode</strong>
            目前顯示的是示範資料，僅供體驗功能。
            <span className="banner-action">
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  void (async () => {
                    const services = await getAppServices();
                    await services.demo.clear();
                    await store.refresh();
                    toast.success("已清除 Demo 資料");
                  })()
                }
              >
                清除 Demo 資料
              </button>
            </span>
          </div>
        )}
        {store.page === "dashboard" && <DashboardPage />}
        {store.page === "history" && <HistoryPage />}
        {store.page === "activity" && <ActivityPage />}
        {store.page === "plans" && <PlansPage />}
        {store.page === "dataSources" && <DataSourcesPage />}
        {store.page === "notifications" && <NotificationsPage />}
        {store.page === "settings" && <SettingsPage />}
      </main>
      <ToastRegion />
    </div>
  );
}
