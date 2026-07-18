// Dashboard (spec §16.2): the four core cards. First glance answers — how much is left, when does
// it reset, when might it run out, how many tasks remain, should I change plans.

import { useMemo, useState } from "react";
import { computeForecast } from "@/domain/forecast";
import { recommendPlan } from "@/domain/planRecommendation";
import { estimateRemainingTasks } from "@/domain/remainingTasks";
import { computeUsageRunway } from "@/domain/runway";
import { snapshotCycleState } from "@/domain/snapshotFreshness";
import type { TaskType } from "@/domain/types";
import { getAppServices } from "../appServices";
import {
  Badge,
  ConfidenceBadge,
  ConfidenceReasons,
  EmptyState,
  Meter,
  toast,
  useNow,
} from "../components/atoms";
import {
  formatCountdown,
  formatDateTime,
  formatRelative,
  pct,
  PROVIDER_BRANDS,
  SOURCE_LABELS,
  TASK_TYPE_LABELS,
} from "../components/format";
import { SnapshotFormModal } from "../components/SnapshotForm";
import { buildCycleSummaries, currentCycleStart, daysOfData, latestValid } from "../derive";
import { useAppStore } from "../state/store";

const ESTIMATE_TYPES: TaskType[] = ["short_chat", "general_chat", "coding", "large_context"];

export function DashboardPage() {
  const now = useNow();
  const store = useAppStore();
  const [showSnapshotForm, setShowSnapshotForm] = useState(false);
  const [checking, setChecking] = useState(false);

  const limit = store.limits.find((l) => l.id === store.selectedLimitId);
  const snapshotsByLimit = store.snapshotsByLimit;
  const snapshots = useMemo(
    () => (limit ? snapshotsByLimit[limit.id] ?? [] : []),
    [limit, snapshotsByLimit]
  );
  const resetEvents = useMemo(
    () => store.resetEvents.filter((e) => e.limitId === limit?.id),
    [store.resetEvents, limit?.id]
  );
  const activities = useMemo(
    () => store.activities.filter((a) => a.limitId === limit?.id),
    [store.activities, limit?.id]
  );
  const latest = latestValid(snapshots);
  const awaitingRefresh = snapshotCycleState(latest, new Date(now).toISOString()) === "awaiting_provider_refresh";
  const plan = store.plans.find((p) => p.id === limit?.planId);

  const forecast = useMemo(() => {
    if (!limit || awaitingRefresh) return undefined;
    const manualOnly = snapshots.every((s) => s.source === "manual" || s.source === "json_import");
    const isDemo = snapshots.length > 0 && snapshots.filter((s) => s.valid).every((s) => s.source === "demo");
    return computeForecast({
      limitId: limit.id,
      snapshots,
      now: new Date(now).toISOString(),
      resetAt: latest?.resetAt,
      cycleStartIso: currentCycleStart(resetEvents),
      manualOnly,
      sourceReliability: isDemo ? "demo" : manualOnly ? "manual" : "automated",
    });
  }, [limit, snapshots, latest?.resetAt, resetEvents, now, awaitingRefresh]);

  const estimates = useMemo(() => {
    if (!latest || awaitingRefresh) return [];
    return ESTIMATE_TYPES.map((taskType) =>
      estimateRemainingTasks({
        taskType,
        activities,
        currentUsedPercent: latest.usedPercent,
      })
    );
  }, [activities, latest, awaitingRefresh]);

  const recommendation = useMemo(() => {
    const cycles = buildCycleSummaries(snapshots, resetEvents);
    return recommendPlan({ cycles, totalDaysOfData: Math.round(daysOfData(snapshots)) });
  }, [snapshots, resetEvents]);

  const runway = useMemo(() => computeUsageRunway({
    forecast,
    remainingPercent: latest?.remainingPercent ?? 0,
    now: new Date(now).toISOString(),
    resetAt: latest?.resetAt,
  }), [forecast, latest?.remainingPercent, latest?.resetAt, now]);
  const qualifiedEstimates = estimates.filter((estimate) => estimate.sampleCount >= 3);

  async function checkNow() {
    setChecking(true);
    try {
      const services = await getAppServices();
      await services.monitor.runOnce("manual");
      await store.refresh();
      toast.success("已完成一次立即檢查");
    } catch (err) {
      toast.error(`檢查失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecking(false);
    }
  }

  if (store.limits.length === 0) {
    return (
      <EmptyState
        icon="◎"
        title="還沒有任何監控目標"
        body="先建立 Provider 帳號、方案與額度限制，或載入 Demo 資料快速體驗完整功能。"
        action={
          <div className="row" style={{ justifyContent: "center" }}>
            <button type="button" className="primary" onClick={() => store.navigate("plans")}>
              建立方案與額度
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void (async () => {
                  const services = await getAppServices();
                  await services.demo.load();
                  await store.refresh();
                  toast.success("已載入 Demo 資料");
                })()
              }
            >
              載入 Demo 資料
            </button>
          </div>
        }
      />
    );
  }

  const remaining = latest && !awaitingRefresh ? latest.remainingPercent : undefined;
  const usedTone = latest && !awaitingRefresh
    ? latest.usedPercent >= 90
      ? "danger"
      : latest.usedPercent >= 70
        ? "warn"
        : "ok"
    : "ok";

  return (
    <>
      <header>
        <div className="card-head" style={{ gap: 0 }}>
          {plan && (
            <div
              className="provider-mark"
              style={{ background: PROVIDER_BRANDS[plan.providerId]?.color ?? "#656b78" }}
              aria-hidden
            >
              {PROVIDER_BRANDS[plan.providerId]?.mark ?? "AI"}
            </div>
          )}
          <div>
            <h1>用量總覽</h1>
            <p>
              {plan ? `${PROVIDER_BRANDS[plan.providerId]?.label ?? ""} ${plan.name} · ` : ""}
              {limit?.name ?? ""}
            </p>
          </div>
        </div>
        <div className="row">
          <select
            className="input"
            style={{ width: "auto", padding: "8px 10px" }}
            value={store.selectedLimitId ?? ""}
            onChange={(e) => store.selectLimit(e.target.value)}
            aria-label="選擇額度限制"
          >
            {store.limits.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => void checkNow()} disabled={checking}>
            {checking ? "檢查中…" : "立即檢查"}
          </button>
          <button type="button" className="primary" onClick={() => setShowSnapshotForm(true)} disabled={!limit}>
            ＋ 新增快照
          </button>
        </div>
      </header>

      <div className="cards" style={{ marginBottom: 15 }}>
        {/* ---------- Current Usage ---------- */}
        <section className="card" aria-label="目前用量">
          <div className="card-title">
            <h3>目前用量</h3>
            {latest && <Badge tone={usedTone === "ok" ? "ok" : usedTone}>{SOURCE_LABELS[latest.source] ?? latest.source}</Badge>}
          </div>
          {latest && !awaitingRefresh ? (
            <>
              <div className="usage-row" style={{ marginTop: 4 }}>
                <strong>{pct(latest.usedPercent)}</strong>
                <span>已使用 · 剩餘 {pct(remaining)}</span>
              </div>
              <Meter value={latest.usedPercent} tone={usedTone === "ok" ? undefined : usedTone} />
              <div className="metric-row">
                <span className="label">下一次重置</span>
                <span className="value">{latest.resetAt ? formatDateTime(latest.resetAt) : "未設定"}</span>
              </div>
              <div className="metric-row">
                <span className="label">距離重置</span>
                <span className="value">{formatCountdown(latest.resetAt, now)}</span>
              </div>
              <div className="metric-row">
                <span className="label">最近更新</span>
                <span className="value">{formatRelative(latest.capturedAt, now)}</span>
              </div>
            </>
          ) : awaitingRefresh ? (
            <div className="provider-refresh-state">
              <strong>新週期等待官方資料</strong>
              <p>官方重置時間已到，上一週期的百分比已停止顯示。App 會自動重試，不需要用舊數字假裝目前用量。</p>
              <span>上一筆資料更新於 {latest ? formatRelative(latest.capturedAt, now) : "未知"}</span>
            </div>
          ) : (
            <p className="muted" style={{ padding: "18px 0" }}>
              尚無有效快照。點右上角「＋ 新增快照」輸入目前用量。
            </p>
          )}
        </section>

        {/* ---------- Forecast ---------- */}
        <section className="card" aria-label="用量續航">
          <div className="card-title">
            <h3>用量續航</h3>
            {forecast && <ConfidenceBadge value={forecast.confidence} />}
          </div>
          {forecast && latest ? (
            <>
              <div className="metric-row">
                <span className="label">預估耗盡時間</span>
                <span className="value">
                  {forecast.estimatedExhaustionAt ? formatDateTime(forecast.estimatedExhaustionAt) : "—"}
                </span>
              </div>
              <div className="metric-row">
                <span className="label">會在重置前用完？</span>
                <span className="value">
                  {forecast.willExhaustBeforeReset === undefined ? (
                    "—"
                  ) : forecast.willExhaustBeforeReset ? (
                    <Badge tone="danger">可能會</Badge>
                  ) : (
                    <Badge tone="ok">預估不會</Badge>
                  )}
                </span>
              </div>
              <div className="metric-row">
                <span className="label">重置時預估剩餘</span>
                <span className="value">{pct(forecast.estimatedRemainingAtReset)}</span>
              </div>
              <div className="metric-row">
                <span className="label">消耗速度（6h / 24h / 週期）</span>
                <span className="value mono">
                  {[forecast.burnRate6h, forecast.burnRate24h, forecast.burnRateCurrentCycle]
                    .map((r) => (r === undefined ? "—" : `${r.toFixed(1)}%/h`))
                    .join(" · ")}
                </span>
              </div>
              <ConfidenceReasons reasons={forecast.warnings} />
            </>
          ) : (
            <p className="muted" style={{ padding: "18px 0" }}>
              需要至少兩筆有效快照才能開始預測。
            </p>
          )}
        </section>

        {/* ---------- Usage pace ---------- */}
        <section className="card" aria-label="使用節奏">
          <div className="card-title">
            <h3>使用節奏</h3>
            {runway.status === "slow_down" && <Badge tone="danger">建議放慢</Badge>}
            {runway.status === "watch" && <Badge tone="warn">接近安全速度</Badge>}
            {runway.status === "comfortable" && <Badge tone="ok">節奏充裕</Badge>}
          </div>
          {runway.safeDailyBudget !== undefined ? (
            <>
              <div className="metric-row"><span className="label">要撐到重置</span><span className="value">每天預估 ≤ {pct(runway.safeDailyBudget)}</span></div>
              <div className="metric-row"><span className="label">目前使用速度</span><span className="value">約 {pct(runway.currentDailyPace)}／天</span></div>
              <div className="metric-row"><span className="label">相較安全速度</span><span className="value">{runway.paceDifferencePercent === undefined ? "資料不足" : runway.paceDifferencePercent > 0 ? `快約 ${Math.round(runway.paceDifferencePercent)}%` : `慢約 ${Math.abs(Math.round(runway.paceDifferencePercent))}%`}</span></div>
              <p className="faint" style={{ marginTop: 10 }}>依目前剩餘額度、重置時間與近期消耗速度進行本機預估，不會使用 AI 額度。</p>
            </>
          ) : (
            <p className="muted" style={{ padding: "18px 0" }}>
              需要重置時間與至少兩筆有效快照，才能計算安全使用節奏。
            </p>
          )}
        </section>

        {/* ---------- Plan recommendation ---------- */}
        <section className="card" aria-label="方案建議">
          <div className="card-title">
            <h3>方案建議</h3>
            <ConfidenceBadge value={recommendation.confidence} />
          </div>
          <div className="usage-row" style={{ marginTop: 2 }}>
            <strong style={{ fontSize: 24 }}>
              {recommendation.recommendation === "upgrade" && "建議升級"}
              {recommendation.recommendation === "keep" && "維持目前方案"}
              {recommendation.recommendation === "downgrade" && "可考慮降級"}
              {recommendation.recommendation === "insufficient_data" && "資料不足"}
            </strong>
          </div>
          {plan && (
            <div className="metric-row">
              <span className="label">目前方案</span>
              <span className="value">
                {plan.name} · {plan.currency} {plan.monthlyPrice}/月
              </span>
            </div>
          )}
          <div className="metric-row">
            <span className="label">近四週平均利用率</span>
            <span className="value">{pct(recommendation.fourWeekAverageUtilization)}</span>
          </div>
          <div className="metric-row">
            <span className="label">提前用完的週期</span>
            <span className="value">
              {recommendation.earlyExhaustedCycles ?? 0} / {recommendation.evaluatedCycles}
            </span>
          </div>
          <ConfidenceReasons reasons={recommendation.reasons} />
        </section>
      </div>

      {qualifiedEstimates.length > 0 && <section className="card" aria-label="進階相似任務估算" style={{ marginBottom: 15 }}>
        <div className="card-title"><h3>進階：相似任務估算</h3><Badge tone="neutral">依活動紀錄</Badge></div>
        {qualifiedEstimates.map((estimate) => <div className="metric-row" key={estimate.taskType}>
          <span className="label">{TASK_TYPE_LABELS[estimate.taskType]} · {estimate.sampleCount} 筆樣本</span>
          <span className="value">預估約 {estimate.minimum}～{estimate.maximum} 次</span>
        </div>)}
        <p className="faint" style={{ marginTop: 10 }}>僅在同類活動至少 3 筆時顯示，範圍為統計預估，不代表官方可用次數。</p>
      </section>}

      {showSnapshotForm && limit && (
        <SnapshotFormModal limit={limit} onClose={() => setShowSnapshotForm(false)} />
      )}
    </>
  );
}
