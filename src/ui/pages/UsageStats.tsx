// ccusage-style cost statistics: full local Claude Code transcript history aggregated into
// daily / weekly / monthly periods with per-model token counts and API-equivalent USD.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { aggregateUsage, summarizeUsagePeriods, type DailyModelUsage, type PeriodGranularity } from "@/domain/usageStats";
import { EmptyState } from "../components/atoms";

const GRANULARITY_OPTIONS: Array<{ id: PeriodGranularity; label: string }> = [
  { id: "daily", label: "每日" },
  { id: "weekly", label: "每週" },
  { id: "monthly", label: "每月" },
];

const tokenFormat = new Intl.NumberFormat("zh-TW", { notation: "compact", maximumFractionDigits: 1 });
const exactFormat = new Intl.NumberFormat("zh-TW");

function tokens(value: number) {
  return <span title={exactFormat.format(value)}>{tokenFormat.format(value)}</span>;
}

function cost(value: number | undefined, hasUnpriced = false) {
  if (value === undefined) return "未定價";
  return `${hasUnpriced ? "≥ " : ""}US$${value.toFixed(2)}`;
}

function periodLabel(period: string, granularity: PeriodGranularity) {
  if (granularity === "weekly") return `${period} 起`;
  return period;
}

function modelLabel(model: string) {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// Survives navigation away from the page. Parsing the full transcript history takes ~3s (the Codex
// log alone is >1GB), and the component unmounts on every page switch, so without this each visit
// re-parsed from scratch behind a spinner. Now a return visit shows the last result instantly and
// refreshes in the background. Module-level rather than store state because it is a pure cache of a
// derived read — nothing else depends on it.
let cachedRows: DailyModelUsage[] | null = null;
let cachedAt: Date | undefined;

export function UsageStatsPage() {
  const [rows, setRows] = useState<DailyModelUsage[] | null>(cachedRows);
  const [error, setError] = useState<string>();
  const [granularity, setGranularity] = useState<PeriodGranularity>("daily");
  const [loadedAt, setLoadedAt] = useState<Date | undefined>(cachedAt);
  const [loading, setLoading] = useState(false);
  const [sourceWarning, setSourceWarning] = useState<string>();
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const args = { utcOffsetMinutes: -new Date().getTimezoneOffset() };
      const results = await Promise.allSettled([
        invoke<DailyModelUsage[]>("read_claude_usage_daily", args),
        invoke<DailyModelUsage[]>("read_codex_usage_daily", args),
      ]);
      if (results.every((result) => result.status === "rejected")) {
        throw new Error(results.map((result) => result.status === "rejected" ? String(result.reason) : "").join("；"));
      }
      const merged = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const at = new Date();
      cachedRows = merged;
      cachedAt = at;
      setRows(merged);
      const missing = results.flatMap((result, index) => result.status === "rejected" ? [index === 0 ? "Claude" : "Codex"] : []);
      setSourceWarning(missing.length ? `${missing.join("、")} 本機紀錄目前無法讀取` : undefined);
      setLoadedAt(at);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onUsageUpdated = (event: Event) => {
      const providerId = (event as CustomEvent<{ providerId?: string }>).detail?.providerId;
      if (providerId === "claude" || providerId === "codex") void load();
    };
    window.addEventListener("local-usage-updated", onUsageUpdated);
    return () => window.removeEventListener("local-usage-updated", onUsageUpdated);
  }, [load]);

  const periods = useMemo(() => (rows ? aggregateUsage(rows, granularity) : []), [rows, granularity]);
  const summary = useMemo(() => summarizeUsagePeriods(periods), [periods]);

  if (error) {
    return (
      <EmptyState
        icon="◌"
        title="讀不到本機對話紀錄"
        body={`此頁從 Claude Code 與 Codex 的本機對話紀錄計算成本，需在桌面 App 中使用。（${error}）`}
      />
    );
  }

  return (
    <>
      <header>
        <div>
          <h1>成本統計</h1>
          <p>本機 Claude Code 與 Codex 全部歷史的 API 等值成本（非訂閱實際扣款）</p>
        </div>
        <div className="row" role="tablist" aria-label="統計區間">
          {loadedAt && <span className="hint">擷取 {loadedAt.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
          <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
            {loading ? "更新中…" : "重新整理"}
          </button>
          {GRANULARITY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={granularity === option.id}
              className={`btn ${granularity === option.id ? "primary" : ""}`}
              onClick={() => setGranularity(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>
      {sourceWarning && <p className="hint">⚠ {sourceWarning}，以下顯示其餘來源。</p>}

      {rows === null ? (
        <div className="section"><p>讀取本機對話紀錄中…</p></div>
      ) : periods.length === 0 ? (
        <EmptyState icon="◌" title="沒有可統計的用量" body="Claude Code 與 Codex 本機紀錄中還沒有 token 用量。" />
      ) : (
        <>
          <div className="section stats-summary">
            <div><small>期間總成本</small><strong>{cost(summary.cost, summary.hasUnpricedModels)}</strong></div>
            <div><small>Input</small><strong>{tokens(summary.inputTokens)}</strong></div>
            <div><small>Output</small><strong>{tokens(summary.outputTokens)}</strong></div>
            <div><small>Cache 寫入</small><strong>{tokens(summary.cacheCreationTokens)}</strong></div>
            <div><small>Cache 讀取</small><strong>{tokens(summary.cacheReadTokens)}</strong></div>
            <div><small>訊息數</small><strong>{exactFormat.format(summary.messageCount)}</strong></div>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{granularity === "monthly" ? "月份" : granularity === "weekly" ? "週（週一起算）" : "日期"}</th>
                  <th>來源</th>
                  <th>模型</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cache 寫入</th>
                  <th>Cache 讀取</th>
                  <th>訊息</th>
                  <th>API 等值</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <Fragment key={period.period}>
                    <tr className="stats-period-row">
                      <td><strong>{periodLabel(period.period, granularity)}</strong></td>
                      <td>{new Set(period.models.map((model) => model.providerId)).size > 1 ? "全部" : period.models[0]!.providerId === "claude" ? "Claude" : "Codex"}</td>
                      <td>{period.models.length > 1 ? `${period.models.length} 個模型` : modelLabel(period.models[0]!.model)}</td>
                      <td>{tokens(period.inputTokens)}</td>
                      <td>{tokens(period.outputTokens)}</td>
                      <td>{tokens(period.cacheCreationTokens)}</td>
                      <td>{tokens(period.cacheReadTokens)}</td>
                      <td>{exactFormat.format(period.messageCount)}</td>
                      <td><strong>{cost(period.cost, period.hasUnpricedModels)}</strong></td>
                    </tr>
                    {period.models.length > 1 && period.models.map((model) => (
                      <tr key={`${period.period}:${model.providerId}:${model.model}`} className="stats-model-row">
                        <td></td>
                        <td>{model.providerId === "claude" ? "Claude" : "Codex"}</td>
                        <td>└ {modelLabel(model.model)}</td>
                        <td>{tokens(model.inputTokens)}</td>
                        <td>{tokens(model.outputTokens)}</td>
                        <td>{tokens(model.cacheCreationTokens)}</td>
                        <td>{tokens(model.cacheReadTokens)}</td>
                        <td>{exactFormat.format(model.messageCount)}</td>
                        <td>{cost(model.cost)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            ※ 依各 Provider 官方 API 牌價估算；Claude cache 寫入依 TTL 計價，Codex cached input 依模型折扣價計算。這是 API 等值成本，不是訂閱實際扣款。
          </p>
        </>
      )}
    </>
  );
}
