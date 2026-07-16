// Data Sources (spec §16.6): manual/import/demo are live; automation adapters shown honestly as
// Coming Later — they return `unsupported` and never fabricate data.

import { ALL_PROVIDER_ADAPTERS } from "@/adapters/providers";
import { Badge } from "../components/atoms";
import { formatDateTime } from "../components/format";
import { useAppStore } from "../state/store";

export function DataSourcesPage() {
  const store = useAppStore();
  const lastRun = store.latestRun;

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
      status: "coming" as const,
      reliability: "—",
      polling: a.supportsAutomaticPolling,
      note: "尚未實作：不會回傳假資料，呼叫時回覆 unsupported。",
    })),
  ];

  return (
    <>
      <header>
        <div>
          <h1>Data Sources</h1>
          <p>資料來源與背景排程狀態</p>
        </div>
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
          <strong style={{ fontSize: 18 }}>每小時</strong>
          <small>App 啟動時也會立即檢查一次</small>
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
              <th>說明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
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
                <td className="faint">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="faint" style={{ marginTop: 14 }}>
        自動化資料來源（Browser Automation、Claude Code Local、Codex Local）在 Roadmap Phase 2–3。
        未完成的整合不會假裝成功，也不會產生假的用量資料。
      </p>
    </>
  );
}
