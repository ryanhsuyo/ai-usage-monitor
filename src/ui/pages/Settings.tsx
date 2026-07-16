// Settings (spec §16.8): behaviour toggles, thresholds, data management, danger zone.

import { useRef, useState } from "react";
import { getAppServices } from "../appServices";
import { ConfirmDialog, Modal, Switch, toast } from "../components/atoms";
import { useAppStore } from "../state/store";
import { SETTINGS_KEYS, settingBool, settingNum } from "@/services/settingsKeys";
import type { ImportSummary } from "@/services/exportImport";

export function SettingsPage() {
  const store = useAppStore();
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [importSummary, setImportSummary] = useState<
    (ImportSummary & { raw: unknown; fileName: string }) | undefined
  >();
  const fileInput = useRef<HTMLInputElement>(null);

  const s = store.settings;
  const pollingEnabled = settingBool(s[SETTINGS_KEYS.pollingEnabled], true);
  const notificationsEnabled = settingBool(s[SETTINGS_KEYS.notificationsEnabled], true);
  const backgroundEnabled = settingBool(s[SETTINGS_KEYS.backgroundEnabled], true);
  const autostartEnabled = settingBool(s[SETTINGS_KEYS.autostartEnabled], false);
  const monitoringPaused = settingBool(s[SETTINGS_KEYS.monitoringPaused], false);
  const warnPercent = settingNum(s[SETTINGS_KEYS.usageWarningRemainingPercent], 15);
  const staleHours = settingNum(s[SETTINGS_KEYS.dataStaleHours], 8);

  async function setSetting(key: string, value: string) {
    const services = await getAppServices();
    await services.settingsRepo.set(key, value);
    await store.refresh();
  }

  async function setBackground(on: boolean) {
    const services = await getAppServices();
    if (on) await services.backgroundRuntime.start();
    else await services.backgroundRuntime.stop();
    await setSetting(SETTINGS_KEYS.backgroundEnabled, String(on));
  }

  async function setAutostart(on: boolean) {
    const services = await getAppServices();
    try {
      if (on) await services.autoStart.enable();
      else await services.autoStart.disable();
      await setSetting(SETTINGS_KEYS.autostartEnabled, String(on));
      toast.success(on ? "已開啟開機自動啟動" : "已關閉開機自動啟動");
    } catch (err) {
      toast.error(`設定失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function exportData() {
    const services = await getAppServices();
    const bundle = await services.exportImport.exportBundle();
    const json = JSON.stringify(bundle, null, 2);
    const fileName = `ai-usage-monitor-export-${new Date().toISOString().slice(0, 10)}.json`;

    if (services.isTauri) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: fileName, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      const fs = await import("@tauri-apps/plugin-fs");
      await fs.writeTextFile(path, json);
      toast.success("已匯出資料（不含任何 Secret）");
    } else {
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("已下載匯出檔");
    }
  }

  async function pickImportFile() {
    const services = await getAppServices();
    if (services.isTauri) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      const fs = await import("@tauri-apps/plugin-fs");
      const text = await fs.readTextFile(path);
      await previewImport(text, path.split("/").pop() ?? "import.json");
    } else {
      fileInput.current?.click();
    }
  }

  async function previewImport(text: string, fileName: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      toast.error("檔案不是有效的 JSON");
      return;
    }
    const services = await getAppServices();
    // dry-run validation only; nothing applied yet
    const { validateImport } = await import("@/domain/importValidation");
    const validation = validateImport(raw);
    setImportSummary({ validation, applied: false, counts: {}, raw, fileName });
    if (!validation.ok) {
      toast.error("匯入檔驗證未通過，請檢視摘要");
    }
    void services; // (services reserved for the apply step)
  }

  async function applyImport(mode: "merge" | "replace") {
    if (!importSummary) return;
    const services = await getAppServices();
    if (mode === "replace") {
      // extra safety: back up current data first
      await exportData().catch(() => undefined);
    }
    const result = await services.exportImport.importBundle(importSummary.raw, mode);
    if (result.applied) {
      await store.refresh();
      toast.success(
        `匯入完成：${Object.entries(result.counts)
          .map(([k, v]) => `${k} ${v} 筆`)
          .join("、") || "無新增資料"}`
      );
      setImportSummary(undefined);
    } else {
      toast.error("匯入未執行：驗證失敗");
    }
  }

  async function openDataDir() {
    const services = await getAppServices();
    if (!services.isTauri) {
      toast.info("瀏覽器預覽模式沒有本機資料目錄");
      return;
    }
    const { appDataDir } = await import("@tauri-apps/api/path");
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(await appDataDir());
  }

  async function clearAllData() {
    const services = await getAppServices();
    // wipe user data tables via repositories (keeps schema + settings keys)
    for (const sn of await services.snapshotRepo.listAll()) await services.snapshotRepo.deleteById(sn.id);
    for (const a of await services.activityRepo.listAll()) await services.activityRepo.deleteById(a.id);
    for (const l of await services.providerRepo.listLimits()) await services.providerRepo.deleteLimit(l.id);
    for (const p of await services.providerRepo.listPlans()) await services.providerRepo.deletePlan(p.id);
    for (const acc of await services.providerRepo.listAccounts())
      await services.providerRepo.deleteAccount(acc.id);
    for (const c of await services.notificationRepo.listChannels()) {
      if (c.secretRef) await services.secretStore.deleteSecret(c.secretRef).catch(() => undefined);
      await services.notificationRepo.deleteChannel(c.id);
    }
    await services.settingsRepo.set(SETTINGS_KEYS.demoMode, "false");
    await store.refresh();
    setConfirmClear(false);
    toast.success("已清除所有資料");
  }

  async function quitApp() {
    const services = await getAppServices();
    if (services.isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("quit_app");
    } else {
      toast.info("瀏覽器預覽模式無法退出 App");
      setConfirmQuit(false);
    }
  }

  async function loadDemo() {
    const services = await getAppServices();
    await services.demo.load();
    await store.refresh();
    toast.success("已載入 Demo 資料");
  }

  async function clearDemo() {
    const services = await getAppServices();
    await services.demo.clear();
    await store.refresh();
    toast.success("已清除 Demo 資料");
  }

  return (
    <>
      <header>
        <div>
          <h1>Settings</h1>
          <p>背景行為、通知門檻與資料管理</p>
        </div>
      </header>

      <div className="section">
        <div className="section-title">
          <h2>背景與監控</h2>
        </div>
        <div className="card">
          <Switch
            checked={pollingEnabled}
            onChange={(v) => void setSetting(SETTINGS_KEYS.pollingEnabled, String(v))}
            label="每小時背景檢查"
            description="定期重新計算預測、偵測重置並觸發通知。"
          />
          <Switch
            checked={monitoringPaused}
            onChange={(v) => void setSetting(SETTINGS_KEYS.monitoringPaused, String(v))}
            label="暫停監控"
            description="暫時停止排程檢查（不會清除任何資料）。"
          />
          <Switch
            checked={backgroundEnabled}
            onChange={(v) => void setBackground(v)}
            label="關閉視窗後在背景繼續執行"
            description="關閉主視窗時隱藏到選單列；由選單列可重新開啟或完全退出。"
          />
          <Switch
            checked={autostartEnabled}
            onChange={(v) => void setAutostart(v)}
            label="開機自動啟動"
            description="登入時自動啟動 AI Usage Monitor（預設關閉）。"
          />
          <Switch
            checked={notificationsEnabled}
            onChange={(v) => void setSetting(SETTINGS_KEYS.notificationsEnabled, String(v))}
            label="啟用所有通知"
            description="與 Notifications 頁的總開關相同。"
          />
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <h2>門檻</h2>
        </div>
        <div className="card">
          <div className="form-row">
            <label className="field">
              「即將用完」警告門檻（剩餘 %）
              <input
                type="number"
                min={1}
                max={50}
                defaultValue={warnPercent}
                onBlur={(e) =>
                  void setSetting(SETTINGS_KEYS.usageWarningRemainingPercent, e.target.value || "15")
                }
              />
              <span className="hint">剩餘額度低於此百分比時發出警告。</span>
            </label>
            <label className="field">
              資料過期門檻（小時）
              <input
                type="number"
                min={1}
                max={72}
                defaultValue={staleHours}
                onBlur={(e) => void setSetting(SETTINGS_KEYS.dataStaleHours, e.target.value || "8")}
              />
              <span className="hint">超過此時數沒有成功更新即視為過期。</span>
            </label>
          </div>
          <p className="faint">
            時區：{Intl.DateTimeFormat().resolvedOptions().timeZone}（日期時間依系統時區顯示；儲存一律使用 UTC）
          </p>
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <h2>資料</h2>
        </div>
        <div className="card">
          <div className="row" style={{ paddingBottom: 12 }}>
            <button type="button" className="btn" onClick={() => void exportData()}>
              匯出 JSON
            </button>
            <button type="button" className="btn" onClick={() => void pickImportFile()}>
              匯入 JSON
            </button>
            <button type="button" className="btn" onClick={() => void openDataDir()}>
              開啟資料目錄
            </button>
            <span className="faint">匯出檔不含 Webhook URL、Token 或任何 Secret。</span>
          </div>
          <div className="row" style={{ borderTop: "1px solid #edf0f2", paddingTop: 12 }}>
            {store.demoMode ? (
              <button type="button" className="btn" onClick={() => void clearDemo()}>
                清除 Demo 資料
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => void loadDemo()}>
                載入 Demo 資料
              </button>
            )}
            <span className="faint">Demo 資料會清楚標示，不會與真實資料混淆。</span>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <h2>危險區域</h2>
        </div>
        <div className="card">
          <div className="row">
            <button type="button" className="btn danger-btn" onClick={() => setConfirmClear(true)}>
              清除所有資料
            </button>
            <button type="button" className="btn" onClick={() => setConfirmQuit(true)}>
              完全退出 App
            </button>
          </div>
        </div>
      </div>

      {/* hidden file input for browser-preview import */}
      <input
        ref={fileInput}
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => void previewImport(String(reader.result), f.name);
          reader.readAsText(f);
          e.target.value = "";
        }}
      />

      {importSummary && (
        <Modal
          title="匯入摘要"
          subtitle={importSummary.fileName}
          onClose={() => setImportSummary(undefined)}
          wide
        >
          {importSummary.validation.errors.length > 0 && (
            <ul className="warn-list" role="alert">
              {importSummary.validation.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {importSummary.validation.warnings.map((w) => (
            <p key={w} className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
              ⚠ {w}
            </p>
          ))}
          <div className="table-wrap" style={{ margin: "12px 0" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>集合</th>
                  <th>總數</th>
                  <th>有效</th>
                  <th>無效</th>
                </tr>
              </thead>
              <tbody>
                {importSummary.validation.collections.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>{c.total}</td>
                    <td>{c.valid}</td>
                    <td>{c.invalid > 0 ? <strong style={{ color: "#b64c47" }}>{c.invalid}</strong> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ marginBottom: 10 }}>
            Merge：只新增不存在的資料，不覆蓋既有歷史。Replace：先自動匯出備份，再以匯入檔取代全部資料。
          </p>
          <div className="modal-actions">
            <span />
            <button type="button" onClick={() => setImportSummary(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="btn danger-btn"
              disabled={!importSummary.validation.ok}
              onClick={() => void applyImport("replace")}
            >
              Replace
            </button>
            <button
              type="button"
              className="primary"
              disabled={!importSummary.validation.ok}
              onClick={() => void applyImport("merge")}
            >
              Merge 匯入
            </button>
          </div>
        </Modal>
      )}

      {confirmClear && (
        <ConfirmDialog
          title="清除所有資料？"
          body="將刪除全部帳號、方案、額度、快照、活動與通知設定，並清除系統安全儲存中的 Secret。建議先匯出備份。此動作無法復原。"
          confirmLabel="全部清除"
          danger
          onConfirm={() => void clearAllData()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
      {confirmQuit && (
        <ConfirmDialog
          title="完全退出 App？"
          body="退出後背景監控與排程通知都會停止，直到下次啟動。"
          confirmLabel="退出"
          onConfirm={() => void quitApp()}
          onCancel={() => setConfirmQuit(false)}
        />
      )}
    </>
  );
}
