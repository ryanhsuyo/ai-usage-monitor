// App shell: sidebar navigation, demo banner, page routing, bootstrap (scheduler + tray wiring).
// Replaces the earlier localStorage prototype with the SQLite-backed app; the prototype's visual
// language (provider marks, stats row, card grid) lives on in the pages.

import { useEffect, useMemo, useState } from "react";
import { computeForecast, shouldShowExhaustion } from "@/domain/forecast";
import { formatLocalDateTime, formatLocalDateTimeShort } from "@/domain/util";
import { estimateCodexApiEquivalent, type CodexModelUsage } from "@/domain/codexCost";
import { estimateClaudeApiEquivalent, type ClaudeModelUsage } from "@/domain/claudeCost";
import { computeQuotaExpiry } from "@/domain/quotaExpiry";
import { summarizeResetCredits, type ResetCreditExpiry } from "@/domain/resetCredits";
import { snapshotCycleState } from "@/domain/snapshotFreshness";
import { getAppServices } from "./appServices";
import { toast, ToastRegion, useNow } from "./components/atoms";
import { formatCompactCountdown } from "./components/format";
import type { UsageSnapshot } from "@/domain/types";
import { useAppStore, type PageId } from "./state/store";
import { DashboardPage } from "./pages/Dashboard";
import { HistoryPage } from "./pages/History";
import { UsageStatsPage } from "./pages/UsageStats";
import { ActivityPage } from "./pages/Activity";
import { PlansPage } from "./pages/Plans";
import { SkillsPage } from "./pages/Skills";
import { DataSourcesPage } from "./pages/DataSources";
import { NotificationsPage } from "./pages/Notifications";
import { SettingsPage } from "./pages/Settings";
import { OnboardingPage } from "./pages/Onboarding";
import { currentCycleStart, latestValid } from "./derive";
import { SETTINGS_KEYS, settingBool, settingNum, settingStripRightInfo, settingStripSize } from "@/services/settingsKeys";

const WIDGET_MODE_KEY = "ai-usage-monitor.widget-mode";
const ALWAYS_ON_TOP_KEY = "ai-usage-monitor.always-on-top";
const STRIP_MODE_KEY = "ai-usage-monitor.strip-mode";
const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex", claude: "Claude Code", chatgpt: "ChatGPT", gemini: "Gemini", cursor: "Cursor", custom: "AI",
};

type CodexMeta = { sessionCount?: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; models?: CodexModelUsage[]; apiEquivalentUsd?: number; unpricedModels?: string[]; pricingBasis?: string; resetAvailableCount?: number; resetCredits?: ResetCreditExpiry[]; resetCreditsAvailable?: boolean };
type ClaudeMeta = { kind: "claude-local-24h"; inputTokens: number; cachedInputTokens: number; outputTokens: number; models: ClaudeModelUsage[]; quotaStale?: boolean; quotaCapturedAt?: string; authNeedsLogin?: boolean };
function codexMeta(note?: string): CodexMeta | undefined {
  if (!note?.startsWith("AUTO:")) return undefined;
  try {
    const parsed = JSON.parse(note.slice(5)) as Partial<CodexMeta>;
    if (![parsed.inputTokens, parsed.cachedInputTokens, parsed.outputTokens].every(Number.isFinite)) return undefined;
    const meta = parsed as CodexMeta;
    if (meta.apiEquivalentUsd === undefined && meta.models?.length) {
      return { ...meta, ...estimateCodexApiEquivalent(meta.models) };
    }
    return meta;
  } catch { return undefined; }
}

function claudeMeta(note?: string): ClaudeMeta | undefined {
  if (!note?.startsWith("AUTO:")) return undefined;
  try {
    const parsed = JSON.parse(note.slice(5)) as ClaudeMeta;
    return parsed.kind === "claude-local-24h" && Array.isArray(parsed.models) ? parsed : undefined;
  } catch { return undefined; }
}

function codexCostTooltip(meta: CodexMeta | undefined): string {
  if (!meta) return "";
  const totalTokens = meta.inputTokens + meta.outputTokens;
  const cost = meta.apiEquivalentUsd === undefined
    ? "成本資料不足"
    : `${meta.unpricedModels?.length ? "≥ " : ""}US$${meta.apiEquivalentUsd.toFixed(2)}（API 等值）`;
  const unpriced = meta.unpricedModels?.length ? `\n未定價模型：${meta.unpricedModels.join("、")}` : "";
  return `\n目前週期 Token：${new Intl.NumberFormat("zh-TW").format(totalTokens)}\n其中快取輸入：${new Intl.NumberFormat("zh-TW").format(meta.cachedInputTokens)}\n換算美元：${cost}${unpriced}\n※ API 等值成本，不是訂閱實際扣款`;
}

function compactLimitLabel(provider: string, limit: { name: string; type: string; model?: string }) {
  // Kept short on purpose: the strip row shares one line with the percentage and the countdown,
  // and the label is the only part that ellipsises when it runs out of room.
  if (provider !== "claude") return PROVIDER_LABELS[provider] ?? provider;
  if (limit.type === "rolling_session") return "Claude 5HR sub";
  if (limit.type === "weekly_model") return `${limit.model ?? limit.name.match(/[（(](.+?)[）)]/)?.[1] ?? "模型"} weekly`;
  const scoped = limit.name.match(/[（(](.+?)[）)]/)?.[1];
  if (scoped && scoped !== "全模型") return `${scoped} weekly`;
  return "Claude weekly";
}

function stripTimeLabel(iso: string | undefined, now: number) {
  const countdown = formatCompactCountdown(iso, now);
  return countdown && countdown !== "重置中" ? countdown : undefined;
}

function StripProviderRow({
  provider,
  label,
  latest,
  snapshots,
  resetEvents,
  limitId,
  windowHours,
}: {
  provider: string;
  label: string;
  latest?: UsageSnapshot;
  snapshots: UsageSnapshot[];
  resetEvents: ReturnType<typeof useAppStore.getState>["resetEvents"];
  limitId: string;
  windowHours?: number;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stripRightInfo = useAppStore((state) => settingStripRightInfo(state.settings[SETTINGS_KEYS.stripRightInfo]));
  const now = useNow();
  const awaitingRefresh = snapshotCycleState(latest, new Date(now).toISOString()) === "awaiting_provider_refresh";
  const used = latest?.usedPercent ?? 0;
  const forecast = useMemo(() => computeForecast({
    limitId,
    snapshots,
    now: new Date(now).toISOString(),
    resetAt: latest?.resetAt,
    cycleStartIso: currentCycleStart(resetEvents),
    manualOnly: snapshots.every((snapshot) => snapshot.source === "manual" || snapshot.source === "json_import"),
    sourceReliability: snapshots.every((snapshot) => snapshot.source === "demo") ? "demo" : "automated",
  }), [latest?.resetAt, limitId, now, resetEvents, snapshots]);
  const exhaustion = !awaitingRefresh && shouldShowExhaustion(forecast, 0.35)
    ? stripTimeLabel(forecast.estimatedExhaustionAt, now)
    : undefined;
  const reset = stripTimeLabel(latest?.resetAt, now);
  const expiry = computeQuotaExpiry({
    now: new Date(now).toISOString(), resetAt: latest?.resetAt,
    remainingPercent: latest?.remainingPercent, windowHours,
  });
  const meta = provider === "codex" ? codexMeta(latest?.note) : undefined;
  const resetCredits = summarizeResetCredits(meta?.resetAvailableCount ?? 0, meta?.resetCredits ?? [], new Date(now).toISOString(), 72, used, latest?.resetAt, forecast.burnRate24h);
  // The credit count is not repeated here: the block below the rows already leads with it.
  const visibleLabel = provider === "codex" && !meta?.resetCreditsAvailable
    ? `${label}·票?`
    : label;
  const claude = provider === "claude" ? claudeMeta(latest?.note) : undefined;
  const quotaStale = claude?.quotaStale === true;
  const authNeedsLogin = claude?.authNeedsLogin === true;
  const claudeBreakdown = claude ? estimateClaudeApiEquivalent(claude.models) : [];
  const claudeCost = claudeBreakdown.reduce((sum, model) => sum + (model.cost ?? 0), 0);
  const hasPricedClaudeModel = claudeBreakdown.some((model) => model.cost !== undefined);
  const inlineCost = meta?.apiEquivalentUsd !== undefined
    ? `${meta.unpricedModels?.length ? "≥ " : ""}US$${meta.apiEquivalentUsd.toFixed(2)}`
    : claude && hasPricedClaudeModel ? `US$${claudeCost.toFixed(2)}` : undefined;
  // A row holding reset credits shows the wall-clock reset next to the countdown: deciding whether
  // to spend a credit means comparing its expiry date against the date the quota returns by itself,
  // and "4d0h" cannot be compared with "7/28" at a glance.
  const resetMoment = resetCredits.availableCount > 0 && latest?.resetAt
    ? formatLocalDateTimeShort(latest.resetAt)
    : undefined;
  const resetText = `重置 ${reset ?? "--"}${resetMoment ? ` · ${resetMoment}` : ""}`;
  const visibleTiming = authNeedsLogin ? "需重新登入 Claude" : quotaStale ? "等待官方更新" : awaitingRefresh ? "等待新週期資料" : stripRightInfo === "reset"
    ? resetText
    : stripRightInfo === "exhaustion"
      ? `用完 ${exhaustion ?? "--"}`
      : stripRightInfo === "cost"
        ? `金額 ${inlineCost ?? "--"}`
        : `${resetText} · 用完 ${exhaustion ?? "--"}`;
  const fullDate = (iso?: string) => iso ? formatLocalDateTime(iso) : "資料不足";
  const resetCreditTooltip = resetCredits.availableCount > 0
    ? `\n可用 Full reset：${resetCredits.availableCount} 張${resetCredits.plan ? `\n${resetCredits.plan.message}` : ""}${resetCredits.recommendations.length ? `\n${resetCredits.recommendations.map((item, index) => `第 ${index + 1} 張 ${fullDate(item.expiresAt)} 到期：${item.message}；最晚 ${fullDate(item.latestUseAt)}`).join("\n")}` : "（未提供到期明細）"}`
    : "";
  const tooltip = authNeedsLogin
    ? `${label}：Claude Code 登入已過期，無法取得官方額度。\n請在終端機執行 claude 後輸入 /login 重新登入；完成後最多 5 分鐘會自動恢復。\n（顯示的是最後一次成功的快取值）`
    : quotaStale
    ? `${label}：偵測到較新的 Claude 活動，但官方額度快取仍停在 ${claude?.quotaCapturedAt ? fullDate(claude.quotaCapturedAt) : "較早時間"}\n舊的 ${Math.round(used)}% 暫不顯示；Token／API 等值仍由本機活動計算`
    : awaitingRefresh
    ? `${label}：官方重置時間已到，舊週期用量已停止顯示\n正在等待供應商回傳新週期資料，不會把未確認資料假設為 0%${resetCreditTooltip}`
    : latest
    ? `${label}：已使用 ${Math.round(used)}%\n預估耗盡：${exhaustion ? fullDate(forecast.estimatedExhaustionAt) : forecast.willExhaustBeforeReset === false ? "本週期用不完" : "資料不足"}\n額度重置：${fullDate(latest.resetAt)}${expiry.expiring ? `\n額度即將到期：尚餘 ${Math.round(latest.remainingPercent)}%${(expiry.hoursUntilReset ?? 0) >= 1 && expiry.suggestedPercentPerHour !== undefined ? `，每小時約可使用 ${Math.max(1, Math.round(expiry.suggestedPercentPerHour))}%` : "，重置在即，可能來不及用完"}` : ""}\n預測可信度：${Math.round(forecast.confidence * 100)}%${resetCreditTooltip}${codexCostTooltip(meta)}`
    : `${label}：等待資料`;
  const tokenTotal = meta ? meta.inputTokens + meta.outputTokens : undefined;
  const costLabel = meta?.apiEquivalentUsd === undefined
    ? "成本資料不足"
    : `${meta.unpricedModels?.length ? "≥ " : ""}US$${meta.apiEquivalentUsd.toFixed(2)}`;
  const hasDetails = Boolean(meta || claude);
  const toggleDetails = () => hasDetails && setDetailsOpen((open) => !open);
  return <div
    className={`strip-provider provider-${provider} ${hasDetails ? "has-cost" : ""} ${detailsOpen ? "details-open" : ""} ${expiry.expiring || resetCredits.expiringSoon ? "expiring" : ""}`}
    aria-label={tooltip}
    aria-expanded={hasDetails ? detailsOpen : undefined}
    role={hasDetails ? "button" : undefined}
    tabIndex={hasDetails ? 0 : undefined}
    onClick={toggleDetails}
    onKeyDown={(event) => {
      if (!hasDetails || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      toggleDetails();
    }}
  >
    <div className="strip-label">
      <strong>{expiry.expiring ? "⚠ " : ""}{visibleLabel}</strong>
      {latest ? quotaStale || awaitingRefresh ? <span className="strip-status awaiting"><small>{visibleTiming}</small></span> : <span className="strip-status"><b className="strip-percent">{Math.round(used)}</b><small>· {visibleTiming}</small></span> : <span>等待資料</span>}
    </div>
    <div className={`strip-meter ${latest && !awaitingRefresh && !quotaStale ? "" : "waiting"}`}><i style={{ width: `${latest && !awaitingRefresh && !quotaStale ? Math.min(100, Math.max(0, used)) : 35}%` }} /></div>
    {meta && <div className="strip-hover" role="tooltip">
      {/* The row only has space for a countdown; the reader still needs the wall-clock moment. */}
      <div><strong>額度重置</strong><b>{fullDate(latest?.resetAt)}</b></div>
      <div><strong>Codex 成本</strong><b>{costLabel}</b></div>
      <small>{new Intl.NumberFormat("zh-TW", { notation: "compact", maximumFractionDigits: 1 }).format(tokenTotal ?? 0)} tokens · API 等值，非實際扣款</small>
      {resetCredits.availableCount > 0 && <><div className={resetCredits.expiringSoon ? "reset-credit-warning" : ""}><strong>Full reset</strong><b>{resetCredits.availableCount} 張 · {resetCredits.recommendations[0]?.action === "use_now" ? "建議現在用" : `最近 ${resetCredits.nearestExpiry ? new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(new Date(resetCredits.nearestExpiry)) : "日期未知"}到期`}</b></div><small>{resetCredits.plan?.message ?? resetCredits.recommendations[0]?.message} · 全部：{resetCredits.expiryDates.length ? resetCredits.expiryDates.map((date) => new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(new Date(date))).join("、") : "未提供明細"}</small></>}
    </div>}
    {claude && <div className="strip-hover" role="tooltip">
      <div><strong>額度重置</strong><b>{fullDate(latest?.resetAt)}</b></div>
      <div><strong>Claude 近 24 小時</strong><b>API 等值 US${claudeCost.toFixed(2)}</b></div>
      <small>{claudeBreakdown.map((model) => `${model.model.replace("claude-", "")} ${model.cost === undefined ? "未定價" : `$${model.cost.toFixed(2)}`}`).join(" · ")}</small>
    </div>}
  </div>;
}

/**
 * The rows the widget and strip actually show, in display order.
 *
 * Shared with `WindowControls` because the strip window is sized from this count — the two must
 * agree, or the window is built for a different number of rows than gets rendered into it.
 */
function selectWidgetLimits(store: ReturnType<typeof useAppStore.getState>) {
  const active = store.limits
    .filter((limit) => limit.active)
    .map((limit) => {
      const plan = store.plans.find((item) => item.id === limit.planId);
      const latest = latestValid(store.snapshotsByLimit[limit.id] ?? []);
      return { limit, plan, latest };
    });
  const providersWithData = new Set(active.filter((item) => item.latest).map((item) => item.plan?.providerId));
  return active
    .filter((item) => item.latest || !providersWithData.has(item.plan?.providerId))
    .sort((a, b) => {
      const priority = (item: typeof a) => {
        const provider = item.plan?.providerId;
        if (provider === "claude") {
          if (item.limit.type === "rolling_session") return 0;
          if (item.limit.resetRule?.includes("weekly_all")) return 1;
          return 2;
        }
        if (provider === "codex") return 3;
        return 4;
      };
      return priority(a) - priority(b);
    })
    .slice(0, 4);
}

function WindowControls() {
  const [widgetMode, setWidgetMode] = useState(() => localStorage.getItem(WIDGET_MODE_KEY) === "true");
  const [alwaysOnTop, setAlwaysOnTopState] = useState(() => localStorage.getItem(ALWAYS_ON_TOP_KEY) === "true");
  const [stripMode, setStripMode] = useState(() => localStorage.getItem(STRIP_MODE_KEY) === "true");
  const stripSize = useAppStore((state) => settingStripSize(state.settings[SETTINGS_KEYS.stripSize]));
  const widgetIdleOpacity = useAppStore((state) => Math.min(100, Math.max(40, settingNum(state.settings[SETTINGS_KEYS.widgetIdleOpacity], 72))));
  const widgetHoverOpaque = useAppStore((state) => settingBool(state.settings[SETTINGS_KEYS.widgetHoverOpaque], true));
  // What the strip will actually render. Limits arrive after the first paint and the Codex credit
  // block appears the first time credits are read, so both grow the window after mount.
  const stripRows = useAppStore((state) => selectWidgetLimits(state).length);
  const stripTickets = useAppStore((state) =>
    selectWidgetLimits(state).some((item) => codexMeta(item.latest?.note) !== undefined)
  );

  async function applyWindow(widget: boolean, pinned: boolean, strip = stripMode) {
    document.documentElement.classList.toggle("widget-mode", widget);
    document.documentElement.classList.toggle("strip-mode", widget && strip);
    document.documentElement.classList.toggle("strip-size-small", widget && strip && stripSize === "small");
    document.documentElement.classList.toggle("strip-size-large", widget && strip && stripSize === "large");
    document.documentElement.classList.toggle("widget-hover-opaque", widget && widgetHoverOpaque);
    document.documentElement.style.setProperty("--widget-idle-opacity", String(widgetIdleOpacity / 100));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // The strip is not resizable, so its height has to be asked for: too short and the rows are
      // cropped without a scrollbar to show it.
      await invoke("set_window_mode", {
        mode: widget ? strip ? "strip" : "widget" : "full",
        pinned,
        stripSize,
        stripRows,
        stripTickets,
      });
    } catch {
      // Running in a regular browser: keep the responsive preview, skip native window controls.
    }
  }

  useEffect(() => {
    void applyWindow(widgetMode, alwaysOnTop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (widgetMode && stripMode) void applyWindow(true, alwaysOnTop, true);
  }, [stripSize, widgetIdleOpacity, widgetHoverOpaque, stripRows, stripTickets]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      cleanup = await listen<boolean>("ui://request-widget-mode", (event) => {
        setWidgetMode(event.payload);
        if (!event.payload) {
          setStripMode(false);
          localStorage.setItem(STRIP_MODE_KEY, "false");
          document.documentElement.classList.remove("strip-mode");
        }
        localStorage.setItem(WIDGET_MODE_KEY, String(event.payload));
        void applyWindow(event.payload, alwaysOnTop);
      });
    }).catch(() => undefined);
    return () => cleanup?.();
  }, [alwaysOnTop]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleWidget() {
    const next = !widgetMode;
    setWidgetMode(next);
    localStorage.setItem(WIDGET_MODE_KEY, String(next));
    void applyWindow(next, alwaysOnTop);
  }

  function toggleStrip() {
    if (!widgetMode) {
      setWidgetMode(true);
      setStripMode(true);
      localStorage.setItem(WIDGET_MODE_KEY, "true");
      localStorage.setItem(STRIP_MODE_KEY, "true");
      void applyWindow(true, alwaysOnTop, true);
      return;
    }
    const next = !stripMode;
    setStripMode(next);
    localStorage.setItem(STRIP_MODE_KEY, String(next));
    void applyWindow(true, alwaysOnTop, next);
  }

  function togglePinned() {
    const next = !alwaysOnTop;
    setAlwaysOnTopState(next);
    localStorage.setItem(ALWAYS_ON_TOP_KEY, String(next));
    void applyWindow(widgetMode, next);
  }

  function startDragging(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("start_window_dragging"))
      .catch(() => undefined);
  }

  function minimizeToDock() {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("minimize_window"))
      .catch(() => undefined);
  }

  return (
    <><div className="window-drag-handle" data-tauri-drag-region aria-hidden onMouseDown={startDragging} />
    <div className="window-controls" aria-label="視窗控制">
      {widgetMode && <button type="button" onClick={minimizeToDock} title="縮到 Dock／工作列" aria-label="縮到 Dock 或工作列"><WindowControlIcon type="minimize" /><span>最小化</span></button>}
      <button type="button" className={stripMode ? "on" : ""} onClick={toggleStrip} title={stripMode ? "展開成小工具卡片" : "縮成極簡橫條"} aria-pressed={stripMode}><WindowControlIcon type={stripMode ? "strip-expand" : "strip-collapse"} /><span>{stripMode ? "展開卡片" : "極簡橫條"}</span></button>
      <button type="button" className={alwaysOnTop ? "on" : ""} onClick={togglePinned} title={alwaysOnTop ? "取消置頂" : "永遠置頂"} aria-pressed={alwaysOnTop}>
        <WindowControlIcon type="pin" filled={alwaysOnTop} /><span>{alwaysOnTop ? "取消置頂" : "置頂"}</span>
      </button>
      <button type="button" className={widgetMode ? "on" : ""} onClick={toggleWidget} title={widgetMode ? "恢復完整視窗" : "切換小工具模式"} aria-pressed={widgetMode}>
        <WindowControlIcon type={widgetMode ? "full" : "widget"} /><span>{widgetMode ? "完整視窗" : "小工具"}</span>
      </button>
    </div></>
  );
}

type WindowControlIconType = "minimize" | "strip-collapse" | "strip-expand" | "pin" | "widget" | "full";

function WindowControlIcon({ type, filled = false }: { type: WindowControlIconType; filled?: boolean }) {
  return <svg className="window-control-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {type === "minimize" && <path d="M5 12h14" />}
    {type === "strip-collapse" && <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 8h18M9 15l3 3 3-3" /></>}
    {type === "strip-expand" && <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 16h18M9 9l3-3 3 3" /></>}
    {type === "pin" && <><path fill={filled ? "currentColor" : "none"} d="M12 17v5M5 17h14M15 3v4l2 3v2H7v-2l2-3V3" /><path d="M8 3h8" /></>}
    {type === "widget" && <><rect x="3" y="3" width="18" height="18" rx="2" /><rect x="11" y="11" width="7" height="6" rx="1" fill={filled ? "currentColor" : "none"} /></>}
    {type === "full" && <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /><path d="m3 8 5-5m8 0 5 5M3 16l5 5m8 0 5-5" /></>}
  </svg>;
}

type NavIconType = "dashboard" | "trend" | "cost" | "activity" | "plans" | "skills" | "source" | "notifications" | "settings" | "menu";

function NavIcon({ type }: { type: NavIconType }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {type === "dashboard" && <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>}
    {type === "trend" && <><path d="M4 19V5M4 19h16" /><path d="m7 15 4-4 3 2 5-6" /></>}
    {type === "cost" && <><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5c-.7-.7-1.8-1-3-1-1.7 0-3 .8-3 2s1.1 1.8 3 2.2 3 1 3 2.3-1.3 2.2-3 2.2c-1.3 0-2.5-.4-3.3-1.2M12 5.5v13" /></>}
    {type === "activity" && <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4Z" /></>}
    {type === "plans" && <><path d="m12 3 8 5-8 5-8-5 8-5Z" /><path d="m4 12 8 5 8-5M4 16l8 5 8-5" /></>}
    {type === "skills" && <><path d="M8.5 3.5h7v5h5v7h-5v5h-7v-5h-5v-7h5Z" /><circle cx="12" cy="12" r="2.5" /></>}
    {type === "source" && <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" /></>}
    {type === "notifications" && <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>}
    {type === "settings" && <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>}
    {type === "menu" && <><path d="M4 6h16M4 12h16M4 18h16" /></>}
  </svg>;
}

const NAV: Array<{ id: PageId; icon: NavIconType; label: string }> = [
  { id: "dashboard", icon: "dashboard", label: "總覽" },
  { id: "history", icon: "trend", label: "用量趨勢" },
  { id: "usageStats", icon: "cost", label: "成本統計" },
  { id: "activity", icon: "activity", label: "活動紀錄" },
  { id: "plans", icon: "plans", label: "方案與額度" },
  { id: "skills", icon: "skills", label: "Skills Insights" },
  { id: "dataSources", icon: "source", label: "資料來源" },
  { id: "notifications", icon: "notifications", label: "通知設定" },
  { id: "settings", icon: "settings", label: "設定" },
];

/** Rate limit for the provider fetch the tray triggers when it opens the widget. */
const TRAY_REFRESH_MIN_INTERVAL_MS = 90_000;
let lastTrayFetch = 0;

/** One-time app bootstrap: initial load, scheduler start, tray events, background mode. */
function useBootstrap() {
  const refresh = useAppStore((s) => s.refresh);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unwatchClaudeCache: (() => void) | undefined;
    let unwatchLocalUsageActivity: (() => void) | undefined;
    let resetRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let startedScheduler: { stop: () => void } | undefined;
    const attemptedResetAnchors = new Set<string>();

    void (async () => {
      const services = await getAppServices();

      // Paint the stored data first. The live collectLocalUsage() below shells out to the Claude
      // CLI (~2–3s) and the Codex app-server, and the first render depends on none of it — every
      // snapshot it would show is already in SQLite. Gating `ready` on that fetch left the window
      // sitting on the spinner for seconds each launch.
      await refresh();
      // A returning user (limits already exist) sees them immediately; the live fetch updates the
      // numbers a moment later. A genuine first run has no limits yet, so keep it on the spinner
      // until the fetch has had a chance to import some — otherwise the onboarding screen flashes
      // before the auto-import flips it to the dashboard.
      const returning = useAppStore.getState().limits.length > 0;
      if (!disposed && returning) setReady(true);

      const imported = (await services.collectLocalUsage().catch(() => undefined))?.inserted ?? 0;
      if (imported > 0) {
        await services.settingsRepo.set(SETTINGS_KEYS.onboardingCompleted, "true");
        await services.settingsRepo.set(SETTINGS_KEYS.pollingEnabled, "true");
      }
      // Reflect whatever the live fetch brought in (or the onboarding flags just set).
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
      startedScheduler = services.scheduler;

      // Reset boundaries deserve a prompt refresh instead of waiting for the regular scheduler.
      // Each limit/resetAt pair is attempted once; the normal scheduler remains the retry path.
      resetRefreshTimer = setInterval(() => void (async () => {
        const state = useAppStore.getState();
        const now = Date.now();
        const reached = state.limits.flatMap((limit) => {
          const latest = latestValid(state.snapshotsByLimit[limit.id] ?? []);
          if (!latest?.resetAt || Date.parse(latest.resetAt) > now) return [];
          const anchor = `${limit.id}:${latest.resetAt}`;
          return attemptedResetAnchors.has(anchor) ? [] : [anchor];
        });
        if (!reached.length) return;
        reached.forEach((anchor) => attemptedResetAnchors.add(anchor));
        const result = await services.monitor.runOnce("interval").catch(() => undefined);
        if (result?.skipped) reached.forEach((anchor) => attemptedResetAnchors.delete(anchor));
        if (!disposed) await refresh();
      })(), 30_000);

      // compact status line on the tray icon after every refresh
      async function updateTray() {
        if (!services.isTauri) return;
        try {
          const state = useAppStore.getState();
          const limit = state.limits.find((l) => l.id === state.selectedLimitId);
          const latest = limit ? latestValid(state.snapshotsByLimit[limit.id] ?? []) : undefined;
          const awaitingRefresh = snapshotCycleState(latest, new Date().toISOString()) === "awaiting_provider_refresh";
          const text = latest && !awaitingRefresh
            ? `${limit?.name ?? ""}：剩餘 ${Math.round(latest.remainingPercent)}%`
            : awaitingRefresh ? `${limit?.name ?? ""}：等待新週期資料`
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
            } else if (action === "refresh_now") {
              // Sent every time the tray pops the widget open. A monitor run spawns the provider
              // CLIs and ends in a full store reload, so doing it on every click made the widget
              // stutter as it appeared. The scheduler and the file watchers already keep the
              // numbers current; only reach for the provider again if they have not run recently.
              if (Date.now() - lastTrayFetch > TRAY_REFRESH_MIN_INTERVAL_MS) {
                lastTrayFetch = Date.now();
                await services.monitor.runOnce("manual").catch(() => undefined);
                await refresh();
              }
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

        // Watch the home directory rather than the file itself because Claude Code may replace
        // .claude.json atomically. The adapter debounces duplicate OS events before this callback.
        unwatchClaudeCache = await services.usageCacheWatcher.watchClaudeCache(() => void (async () => {
          const inserted = (await services.collectLocalUsage(["claude"]).catch(() => undefined))?.inserted ?? 0;
          if (inserted > 0 && !disposed) {
            await refresh();
            await updateTray();
          }
        })()).catch(() => undefined);

        // Transcript/session files change while the user is actively using Claude or Codex.
        // Refresh only that provider after the platform adapter has debounced the write burst.
        unwatchLocalUsageActivity = await services.usageCacheWatcher.watchLocalUsageActivity((providerId) => void (async () => {
          const inserted = (await services.collectLocalUsage([providerId]).catch(() => undefined))?.inserted ?? 0;
          if (!disposed) window.dispatchEvent(new CustomEvent("local-usage-updated", { detail: { providerId } }));
          if (inserted > 0 && !disposed) {
            await refresh();
            await updateTray();
          }
        })()).catch(() => undefined);
      }

      if (!disposed) setReady(true);
    })().catch((err) => {
      toast.error(`初始化失敗：${err instanceof Error ? err.message : String(err)}`);
      setReady(true);
    });

    return () => {
      disposed = true;
      unlisten?.();
      unwatchClaudeCache?.();
      unwatchLocalUsageActivity?.();
      if (resetRefreshTimer) clearInterval(resetRefreshTimer);
      // Stop the poller too. Without this every remount (dev hot reload, StrictMode's double
      // mount) leaves the previous scheduler ticking, and each survivor dispatches its own
      // notifications — the observed four interval runs inside half a second.
      startedScheduler?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ready;
}

export function App() {
  const ready = useBootstrap();
  const store = useAppStore();

  const widgetLimits = selectWidgetLimits(store);
  const codexWidget = widgetLimits.find((item) => (item.plan?.providerId ?? item.latest?.providerId) === "codex");
  const codexWidgetMeta = codexMeta(codexWidget?.latest?.note);
  // Feed the strip footer the same context the hover panels get. Without current usage and the
  // reset time it defaulted to 0% used, so the advice could never say a credit was worth using.
  const codexWidgetSnapshot = codexWidget?.latest;
  const codexWidgetForecast = codexWidget
    ? computeForecast({
        limitId: codexWidget.limit.id,
        snapshots: store.snapshotsByLimit[codexWidget.limit.id] ?? [],
        now: new Date().toISOString(),
        resetAt: codexWidgetSnapshot?.resetAt,
        cycleStartIso: currentCycleStart(store.resetEvents.filter((event) => event.limitId === codexWidget.limit.id)),
        manualOnly: false,
        sourceReliability: "automated",
      })
    : undefined;
  const codexWidgetTickets = summarizeResetCredits(
    codexWidgetMeta?.resetAvailableCount ?? 0,
    codexWidgetMeta?.resetCredits ?? [],
    new Date().toISOString(),
    72,
    codexWidgetSnapshot?.usedPercent ?? 0,
    codexWidgetSnapshot?.resetAt,
    codexWidgetForecast?.burnRate24h
  );
  const codexTicketDates = codexWidgetTickets.expiryDates.map((date) =>
    new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(new Date(date))
  );
  const codexTicketAdvice = codexWidgetTickets.recommendations[0]?.action === "use_now"
    ? `建議用 1 張`
    : undefined;
  if (!ready || !store.loaded) {
    return (
      <><WindowControls /><div className="loading" role="status">
          <span className="spinner" aria-hidden />載入中…
      </div></>
    );
  }

  if (!store.onboardingCompleted) {
    return (
      <><WindowControls /><main className="onboarding-shell" style={{ minHeight: "100vh", display: "block", padding: "38px 44px 60px" }}>
        <OnboardingPage />
        <ToastRegion />
      </main></>
    );
  }

  return (
    <><WindowControls /><div className="app">
      <section className="widget-summary" aria-label="AI 用量小工具">
        <div className="widget-title">
          <div><strong>AI Usage</strong><small>LOCAL MONITOR</small></div>
          <button type="button" onClick={() => store.navigate("dashboard")} title="開啟總覽" aria-label="開啟總覽"><NavIcon type="menu" /></button>
        </div>
        <div className="widget-provider-list">
          {widgetLimits.length ? widgetLimits.map(({ limit, plan, latest }) => {
            const provider = plan?.providerId ?? latest?.providerId ?? "custom";
            const label = PROVIDER_LABELS[provider] ?? provider;
            const used = latest?.usedPercent ?? 0;
            const meta = provider === "codex" ? codexMeta(latest?.note) : undefined;
            const claude = provider === "claude" ? claudeMeta(latest?.note) : undefined;
            const quotaStale = claude?.quotaStale === true;
            const authNeedsLogin = claude?.authNeedsLogin === true;
            const tokenTotal = meta ? meta.inputTokens + meta.outputTokens : undefined;
            const awaitingRefresh = snapshotCycleState(latest, new Date().toISOString()) === "awaiting_provider_refresh";
            const resetCredits = summarizeResetCredits(meta?.resetAvailableCount ?? 0, meta?.resetCredits ?? [], new Date().toISOString(), 72, awaitingRefresh ? 0 : used, latest?.resetAt);
            const resetCreditDetails = resetCredits.recommendations.map((item, index) => {
              const expiry = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(new Date(item.expiresAt));
              const latestUse = formatLocalDateTimeShort(item.latestUseAt);
              return `第 ${index + 1} 張：${expiry} 到期｜${item.message}｜最晚 ${latestUse}`;
            });
            if (!latest) return <article className="widget-provider unavailable" key={limit.id}>
              <div className="widget-provider-head"><strong>{label}</strong><span className="waiting">等待資料</span></div>
              <small>{limit.name}</small>
              <div className="widget-source-status">尚未取得 Claude 官方 Current 5h／Weekly 額度</div>
            </article>;
            return <article className={`widget-provider ${awaitingRefresh || quotaStale ? "awaiting-refresh" : ""}`} key={limit.id} title={authNeedsLogin ? `${label}：Claude Code 登入已過期，請在終端機執行 claude 後輸入 /login 重新登入` : quotaStale ? `${label}：有新活動，但 Claude 官方額度快取未更新` : awaitingRefresh ? `${label}：官方重置時間已到，等待新週期資料${resetCreditDetails.length ? `\n${resetCreditDetails.join("\n")}` : ""}` : `${label}：已使用 ${Math.round(used)}%${resetCreditDetails.length ? `\n${resetCreditDetails.join("\n")}` : ""}${codexCostTooltip(meta) || "\nToken／成本資料不足"}`}>
              <div className="widget-provider-head"><strong>{label}{provider === "codex" && meta?.resetCreditsAvailable ? ` · Reset ${resetCredits.availableCount} 張` : ""}</strong>{authNeedsLogin ? <span className="waiting">需登入</span> : quotaStale ? <span className="waiting">待官方更新</span> : awaitingRefresh ? <span className="waiting">待更新</span> : <span>{Math.round(used)}</span>}</div>
              <small>{limit.name}</small>
              <div className={`widget-meter ${awaitingRefresh || quotaStale ? "waiting" : ""}`}><i style={{ width: `${awaitingRefresh || quotaStale ? 35 : Math.min(100, Math.max(0, used))}%` }} /></div>
              {quotaStale ? <div className="widget-cycle-refresh">偵測到使用活動，等待 Claude 官方額度更新</div> : awaitingRefresh ? <div className="widget-cycle-refresh">已到官方重置時間，等待新週期資料</div> : <div className="widget-meta"><span>剩餘 {Math.round(100 - used)}%</span><span>{latest?.resetAt ? `重置 ${formatLocalDateTimeShort(latest.resetAt)}` : "未提供重置時間"}</span></div>}
              {resetCredits.availableCount > 0 && <div className={`widget-reset-credit ${resetCredits.expiringSoon ? "warning" : ""}`}><span>Full reset {resetCredits.availableCount} 張</span><strong>{resetCredits.nearestExpiry ? `最近 ${new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(new Date(resetCredits.nearestExpiry))} 到期` : "到期日未知"}</strong></div>}
              {provider === "codex" && meta && !meta.resetCreditsAvailable && <div className="widget-reset-credit warning"><span>Reset 票券</span><strong>同步失敗，將自動重試</strong></div>}
              {resetCreditDetails.length > 0 && <div className="widget-reset-list">{resetCreditDetails.map((detail, index) => <div className={resetCredits.recommendations[index]?.action === "use_now" ? "use-now" : ""} key={resetCredits.recommendations[index]?.expiresAt}><b>{index + 1}</b><span>{detail.replace(`第 ${index + 1} 張：`, "")}</span></div>)}</div>}
              {meta && <div className="widget-cost"><span>{tokenTotal && tokenTotal >= 1_000_000 ? `${(tokenTotal / 1_000_000).toFixed(1)}M` : `${Math.round((tokenTotal ?? 0) / 1000)}K`} tokens</span><strong>{meta.apiEquivalentUsd === undefined ? "成本待定" : `API 等值 ${meta.unpricedModels?.length ? "≥ " : ""}$${meta.apiEquivalentUsd.toFixed(2)}`}</strong></div>}
            </article>;
          }) : <div className="widget-empty"><span>◌</span><strong>等待本機用量資料</strong><small>使用 Codex 後會自動更新</small></div>}
        </div>
        <footer className="widget-footer"><i />每 5 分鐘自動同步<span>{widgetLimits.find((item) => item.latest)?.latest ? `更新 ${new Intl.RelativeTimeFormat("zh-TW", { numeric: "auto" }).format(-Math.max(0, Math.round((Date.now() - Date.parse(widgetLimits.find((item) => item.latest)!.latest!.capturedAt)) / 60000)), "minute")}` : ""}</span></footer>
      </section>
      <section className="strip-summary" aria-label="AI 極簡用量">
        {widgetLimits.map(({ limit, plan, latest }) => {
          const provider = plan?.providerId ?? latest?.providerId ?? "custom";
          return <StripProviderRow
            provider={provider}
            label={compactLimitLabel(provider, limit)}
            latest={latest}
            snapshots={store.snapshotsByLimit[limit.id] ?? []}
            resetEvents={store.resetEvents.filter((event) => event.limitId === limit.id)}
            limitId={limit.id}
            windowHours={limit.windowHours}
            key={limit.id}
          />;
        })}
        {codexWidgetMeta && <div className={`strip-reset-tickets ${codexWidgetTickets.expiringSoon ? "warning" : ""}`}>
          {codexWidgetMeta.resetCreditsAvailable
            ? <>
                <strong>Reset {codexWidgetTickets.availableCount} 張{codexTicketAdvice ? ` · ${codexTicketAdvice}` : ""}</strong>
                {/* Only the credits belong here. The quota's own reset is a property of the quota,
                    so it sits on the Codex row above; under a "Reset 3 張" heading it read as
                    something the credits do. */}
                <span>{codexTicketDates.length ? `到期 ${codexTicketDates.join("、")}` : "無可用票券"}</span>
              </>
            : <><strong>Reset 票券</strong><span>同步中，將自動重試</span></>}
        </div>}
      </section>
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
              <span aria-hidden><NavIcon type={item.icon} /></span>
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
            <span aria-hidden><NavIcon type="settings" /></span>設定
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
        {store.page === "usageStats" && <UsageStatsPage />}
        {store.page === "activity" && <ActivityPage />}
        {store.page === "plans" && <PlansPage />}
        {store.page === "skills" && <SkillsPage />}
        {store.page === "dataSources" && <DataSourcesPage />}
        {store.page === "notifications" && <NotificationsPage />}
        {store.page === "settings" && <SettingsPage />}
      </main>
      <ToastRegion />
    </div></>
  );
}
