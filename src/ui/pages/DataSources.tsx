// Data Sources (spec §16.6): manual/import/demo are live; automation adapters shown honestly as
// Coming Later — they return `unsupported` and never fabricate data.

import { ALL_PROVIDER_ADAPTERS } from "@/adapters/providers";
import { Badge, toast } from "../components/atoms";
import { formatDateTime } from "../components/format";
import { useAppStore } from "../state/store";
import { getAppServices } from "../appServices";
import { useState } from "react";

function relativeAge(iso: string | undefined): string {
  if (!iso) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return minutes < 1 ? "剛剛" : minutes < 60 ? `${minutes} 分鐘前` : `${Math.round(minutes / 60)} 小時前`;
}

function nextSyncAt(lastRunAt: string | undefined): string {
  if (!lastRunAt) return "App 啟動時";
  const next = Math.max(Date.now(), Date.parse(lastRunAt) + 5 * 60_000);
  return formatDateTime(new Date(next).toISOString());
}

export function DataSourcesPage() {
  const store = useAppStore();
  const lastRun = store.latestRun;
  const [syncing, setSyncing] = useState(false);

  const rows: Array<{
    id: string;
    name: string;
    status: "available" | "coming";
    reliability: string;
    polling: boolean;
    note: string;
  }> = [
    {
      id: "manual",
      name: "手動輸入",
      status: "available",
      reliability: "依輸入品質",
      polling: false,
      note: "在 Dashboard 隨時新增快照；活動紀錄提供任務級消耗。",
    },
    {
      id: "json-import",
      name: "JSON 匯入",
      status: "available",
      reliability: "依來源",
      polling: false,
      note: "從 Settings 匯入先前匯出的資料檔。",
    },
    {
      id: "demo",
      name: "Demo Provider",
      status: "available",
      reliability: "示範資料",
      polling: false,
      note: "一鍵載入範例資料集，明確標示 Demo Mode。",
    },
    ...ALL_PROVIDER_ADAPTERS.filter((a) => a.id !== "manual").map((a) => ({
      id: a.id,
      name: a.displayName,
      status: (["codex-local", "claude-code-local"].includes(a.id) ? "available" : "coming") as "available" | "coming",
      reliability: ["codex-local", "claude-code-local"].includes(a.id) ? "官方本機資料" : "—",
      polling: a.supportsAutomaticPolling,
      note: a.id === "codex-local" ? "自動讀取 ~/.codex/sessions 的額度與重置時間。" : a.id === "claude-code-local" ? "讀取 ~/.claude.json 中 Claude Code 官方 /usage 快取；一般使用或執行 /usage 後更新。" : "尚未實作：不會回傳假資料，呼叫時回覆 unsupported。",
    })),
  ];

  return (
    <>
      <header>
        <div>
          <h1>Data Sources</h1>
          <p>資料來源與背景排程狀態</p>
        </div>
        <button className="btn primary" type="button" disabled={syncing} onClick={() => void (async () => {
          setSyncing(true);
          try {
            const services = await getAppServices();
            const { inserted: count } = await services.collectLocalUsage();
            await store.refresh();
            toast.success(count ? `已同步 ${count} 筆新用量` : "資料已是最新狀態");
          } catch (error) {
            toast.error(`同步失敗：${error instanceof Error ? error.message : String(error)}`);
          } finally { setSyncing(false); }
        })()}>{syncing ? "同步中…" : "立即同步"}</button>
      </header>

      <div className="stats">
        <article>
          <label>最近一次排程</label>
          <strong style={{ fontSize: 18 }}>{lastRun ? formatDateTime(lastRun.startedAt) : "—"}</strong>
          <small>
            {lastRun
              ? lastRun.status === "success"
                ? `成功 · ${lastRun.detail ?? ""}`
                : lastRun.status === "running"
                  ? "執行中"
                  : `失敗 · ${lastRun.detail ?? ""}`
              : "尚未執行"}
          </small>
        </article>
        <article>
          <label>排程頻率</label>
          <strong style={{ fontSize: 18 }}>每 5 分鐘</strong>
          <small>App 啟動與開啟小工具時也會立即檢查</small>
        </article>
        <article>
          <label>Secret 儲存</label>
          <strong style={{ fontSize: 18 }}>
            {store.settings["app.secretBackend"] === "keychain"
              ? "系統 Keychain"
              : store.settings["app.secretBackend"] === "file"
                ? "加密檔案"
                : "記憶體（預覽）"}
          </strong>
          <small>Webhook / Token 不會存進資料庫</small>
        </article>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>資料來源</th>
              <th>狀態</th>
              <th>自動輪詢</th>
              <th>可靠度</th>
              <th>最近嘗試／成功</th>
              <th>下次同步</th>
              <th>說明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const health = store.dataSources.find((source) => source.adapterId === r.id);
              return (
              <tr key={r.id}>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td>
                  {r.status === "available" ? (
                    <Badge tone="ok">可用</Badge>
                  ) : (
                    <Badge tone="neutral">Coming Later</Badge>
                  )}
                </td>
                <td>{r.polling ? "支援" : "—"}</td>
                <td>{r.reliability}</td>
                <td className="faint">{health?.lastRunAt ? formatDateTime(health.lastRunAt) : "—"}<br /><span>{health?.lastSuccessAt ? `成功 ${relativeAge(health.lastSuccessAt)}` : "尚未成功"}</span></td>
                <td className="faint">{r.polling && r.status === "available" ? nextSyncAt(health?.lastRunAt) : "—"}</td>
                <td className="faint">{r.note}{health?.lastError && <><br /><span className="error-text">最近錯誤：{health.lastError}</span></>}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="faint" style={{ marginTop: 14 }}>
        Claude Code 與 Codex Local 已可用；Browser Automation 仍在 Roadmap Phase 3。
        未完成的整合不會假裝成功，也不會產生假的用量資料。
      </p>
    </>
  );
}
