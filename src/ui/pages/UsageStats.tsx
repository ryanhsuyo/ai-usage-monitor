// ccusage-style cost statistics: full local Claude Code transcript history aggregated into
// daily / weekly / monthly periods with per-model token counts and API-equivalent USD.

import { useEffect, useMemo, useState } from "react";
import { aggregateClaudeUsage, summarizeUsagePeriods, type DailyModelUsage, type PeriodGranularity } from "@/domain/usageStats";
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

export function UsageStatsPage() {
  const [rows, setRows] = useState<DailyModelUsage[] | null>(null);
  const [error, setError] = useState<string>();
  const [granularity, setGranularity] = useState<PeriodGranularity>("daily");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<DailyModelUsage[]>("read_claude_usage_daily", {
          utcOffsetMinutes: -new Date().getTimezoneOffset(),
        });
        if (!cancelled) setRows(result);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const periods = useMemo(() => (rows ? aggregateClaudeUsage(rows, granularity) : []), [rows, granularity]);
  const summary = useMemo(() => summarizeUsagePeriods(periods), [periods]);

  if (error) {
    return (
      <EmptyState
        icon="◌"
        title="讀不到本機對話紀錄"
        body={`此頁從 ~/.claude/projects 的 Claude Code 對話紀錄計算成本，需在桌面 App 中使用。（${error}）`}
      />
    );
  }

  return (
    <>
      <header>
        <div>
          <h1>成本統計</h1>
          <p>本機 Claude Code 全部歷史的 API 等值成本（非訂閱實際扣款）</p>
        </div>
        <div className="row" role="tablist" aria-label="統計區間">
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

      {rows === null ? (
        <div className="section"><p>讀取本機對話紀錄中…</p></div>
      ) : periods.length === 0 ? (
        <EmptyState icon="◌" title="沒有可統計的用量" body="~/.claude/projects 中還沒有含 token 用量的對話紀錄。" />
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
                  <>
                    <tr key={period.period} className="stats-period-row">
                      <td><strong>{periodLabel(period.period, granularity)}</strong></td>
                      <td>{period.models.length > 1 ? `${period.models.length} 個模型` : modelLabel(period.models[0]!.model)}</td>
                      <td>{tokens(period.inputTokens)}</td>
                      <td>{tokens(period.outputTokens)}</td>
                      <td>{tokens(period.cacheCreationTokens)}</td>
                      <td>{tokens(period.cacheReadTokens)}</td>
                      <td>{exactFormat.format(period.messageCount)}</td>
                      <td><strong>{cost(period.cost, period.hasUnpricedModels)}</strong></td>
                    </tr>
                    {period.models.length > 1 && period.models.map((model) => (
                      <tr key={`${period.period}:${model.model}`} className="stats-model-row">
                        <td></td>
                        <td>└ {modelLabel(model.model)}</td>
                        <td>{tokens(model.inputTokens)}</td>
                        <td>{tokens(model.outputTokens)}</td>
                        <td>{tokens(model.cacheCreationTokens)}</td>
                        <td>{tokens(model.cacheReadTokens)}</td>
                        <td>{exactFormat.format(model.messageCount)}</td>
                        <td>{cost(model.cost)}</td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            ※ 依官方 API 牌價估算（cache 寫入 1.25×、讀取 0.1× input 價），為 API 等值成本，不是訂閱實際扣款。
          </p>
        </>
      )}
    </>
  );
}
