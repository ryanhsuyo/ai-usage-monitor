// Notification event generation (spec §9). Pure.
//
// Turns the current forecast / reset outcome / freshness state into candidate notification events
// with STABLE dedup keys. All predictive copy uses hedged wording ("預估 / 可能 / 依目前資料") and
// never claims an official guarantee.

import { NOTIFICATION, THRESHOLDS } from "./constants";
import { buildEventKey } from "./dedup";
import type { ResetDetectionOutcome } from "./resetDetection";
import type {
  ForecastResult,
  NotificationEventType,
  ProviderId,
  Severity,
} from "./types";
import { hoursBetween, isValidIso } from "./util";
import { computeQuotaExpiry } from "./quotaExpiry";
import { summarizeResetCredits, type ResetCreditExpiry } from "./resetCredits";

export type CandidateEvent = {
  eventKey: string;
  eventType: NotificationEventType;
  providerId?: ProviderId;
  accountId?: string;
  limitId?: string;
  title: string;
  body: string;
  severity: Severity;
};

export type NotificationEvalSettings = {
  usageWarningRemainingPercent: number;
  dataStaleHours: number;
  exhaustionWarningLeadHours: number;
};

export type NotificationContext = {
  providerId: ProviderId;
  providerLabel: string; // e.g. "Claude"
  accountId?: string;
  limitId: string;
  limitKey: string; // stable label, e.g. "weekly"
  limitLabel: string; // e.g. "週額度"
  now: string;
  currentUsedPercent?: number;
  remainingPercent?: number;
  nextResetAt?: string;
  windowHours?: number;
  forecast?: ForecastResult;
  resetOutcome?: ResetDetectionOutcome;
  lastSuccessAt?: string;
  pollingFailed?: boolean;
  resetCredits?: ResetCreditExpiry[];
  resetCreditsAvailable?: number;
  settings?: Partial<NotificationEvalSettings>;
};

function hourBucketIso(iso: string): string {
  const d = new Date(Date.parse(iso));
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

// The product speaks zh-TW everywhere, but toLocaleString() follows the runtime locale, which
// rendered notification times as "7/18/2026, 7:59:59 PM" inside otherwise-Chinese copy.
const LOCAL_DATE_TIME = new Intl.DateTimeFormat("zh-TW", {
  month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit",
});

function formatLocal(iso: string | undefined): string {
  if (!iso || !isValidIso(iso)) return "未知時間";
  return LOCAL_DATE_TIME.format(new Date(Date.parse(iso)));
}

/**
 * Durations in reader-friendly units. Hours alone forced "距離重置仍有 168 小時" onto weekly
 * limits, and rounding sub-hour gaps produced the nonsensical "預估約 0 小時後耗盡".
 */
export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "未知";
  if (hours < 1) return "不到 1 小時";
  if (hours < 48) return `約 ${Math.round(hours)} 小時`;
  return `約 ${Math.round(hours / 24)} 天`;
}

export function evaluateNotificationEvents(ctx: NotificationContext): CandidateEvent[] {
  const s: NotificationEvalSettings = {
    usageWarningRemainingPercent:
      ctx.settings?.usageWarningRemainingPercent ?? THRESHOLDS.USAGE_WARNING_REMAINING_PERCENT,
    dataStaleHours: ctx.settings?.dataStaleHours ?? THRESHOLDS.DATA_STALE_HOURS,
    exhaustionWarningLeadHours:
      ctx.settings?.exhaustionWarningLeadHours ?? THRESHOLDS.EXHAUSTION_WARNING_LEAD_HOURS,
  };

  const out: CandidateEvent[] = [];
  const base = {
    providerId: ctx.providerId,
    accountId: ctx.accountId,
    limitId: ctx.limitId,
  };
  const anchorReset = ctx.resetOutcome?.expectedResetAt ?? ctx.nextResetAt ?? ctx.now;
  const cycleAnchor = ctx.nextResetAt ?? ctx.now;

  // --- Codex Full reset credit expiry / use recommendation ---
  if ((ctx.resetCreditsAvailable ?? 0) > 0 && ctx.resetCredits?.length) {
    const credits = summarizeResetCredits(
      ctx.resetCreditsAvailable ?? 0,
      ctx.resetCredits,
      ctx.now,
      72,
      ctx.currentUsedPercent ?? 0,
      ctx.nextResetAt
    );
    const first = credits.recommendations[0];
    if (first && (credits.expiringSoon || first.action === "use_now")) {
      out.push({
        ...base,
        eventType: "quota_expiring",
        eventKey: buildEventKey({
          providerId: ctx.providerId,
          limitKey: `${ctx.limitKey}:reset-credit`,
          eventType: "quota_expiring",
          anchorIso: first.expiresAt,
        }),
        title: `Codex Full reset 票券${first.action === "use_now" ? "建議現在使用" : "即將到期"}`,
        body: `目前有 ${credits.availableCount} 張可用，最早一張將於 ${formatLocal(first.expiresAt)} 到期。\n${first.message}；依目前資料，最晚安全使用時間約為 ${formatLocal(first.latestUseAt)}。`,
        severity: first.action === "use_now" ? "warning" : "info",
      });
    }
  }

  // --- Meaningful unused allowance will expire at the next provider reset ---
  const expiry = computeQuotaExpiry({
    now: ctx.now,
    resetAt: ctx.nextResetAt,
    remainingPercent: ctx.remainingPercent,
    windowHours: ctx.windowHours,
  });
  if (expiry.expiring && ctx.nextResetAt) {
    out.push({
      ...base,
      eventType: "quota_expiring",
      eventKey: buildEventKey({
        providerId: ctx.providerId,
        limitKey: ctx.limitKey,
        eventType: "quota_expiring",
        anchorIso: ctx.nextResetAt,
      }),
      title: `${ctx.providerLabel} ${ctx.limitLabel}即將到期`,
      body:
        `依目前資料，仍剩約 ${Math.round(ctx.remainingPercent ?? 0)}%，將於 ${formatLocal(ctx.nextResetAt)} 重置。` +
        // An hourly pace only means something while at least an hour remains; dividing the
        // remainder by a few minutes produced advice like "每小時可使用約 242%".
        ((expiry.hoursUntilReset ?? 0) >= 1 && expiry.suggestedPercentPerHour !== undefined
          ? `\n若希望在到期前充分使用，平均每小時可使用約 ${Math.max(1, Math.round(expiry.suggestedPercentPerHour))}%。`
          : `\n距離重置${formatDuration(expiry.hoursUntilReset ?? 0)}，剩餘額度可能來不及用完。`),
      severity: "info",
    });
  }

  // --- Reset confirmed ---
  if (ctx.resetOutcome?.kind === "confirmed") {
    // A reset at (or after) its expected time is routine; "臨時／提前" is reserved for a reset
    // that arrives BEFORE the expected boundary.
    const expectedIso = ctx.resetOutcome.expectedResetAt;
    const early = Boolean(expectedIso && Date.parse(ctx.now) < Date.parse(expectedIso));
    out.push({
      ...base,
      eventType: "reset_confirmed",
      eventKey: buildEventKey({
        providerId: ctx.providerId,
        limitKey: ctx.limitKey,
        eventType: "reset_confirmed",
        anchorIso: anchorReset,
      }),
      title: early ? `${ctx.providerLabel} 額度可能臨時／提前重置` : `${ctx.providerLabel} 額度已重置`,
      body:
        (early ? "" : "新週期已開始。\n") +
        `目前已使用 ${Math.round(ctx.currentUsedPercent ?? 0)}%。` +
        (ctx.nextResetAt ? `\n新的預計重置時間為 ${formatLocal(ctx.nextResetAt)}。` : ""),
      severity: "info",
    });
  }

  // --- Reset expected (never claims confirmation) ---
  if (ctx.resetOutcome?.kind === "expected") {
    out.push({
      ...base,
      eventType: "reset_expected",
      eventKey: buildEventKey({
        providerId: ctx.providerId,
        limitKey: ctx.limitKey,
        eventType: "reset_expected",
        anchorIso: anchorReset,
      }),
      title: `${ctx.providerLabel} 額度預計已重置`,
      body: "預計重置時間已到達。\n目前尚未取得新的有效用量，請開啟 App 更新或同步資料。",
      severity: "info",
    });
  }

  // --- Exhaustion forecast ---
  // Skipped once the quota is actually spent: "may run out before reset" is not news at 0%
  // remaining, and the usage warning already covers that state once per cycle.
  const exhausted =
    ctx.remainingPercent !== undefined &&
    ctx.remainingPercent <= NOTIFICATION.EXHAUSTED_REMAINING_PERCENT;
  if (!exhausted && ctx.forecast?.willExhaustBeforeReset === true && ctx.forecast.estimatedExhaustionAt) {
    const hoursToExhaust = Math.max(0, hoursBetween(ctx.now, ctx.forecast.estimatedExhaustionAt));
    const hoursToReset = ctx.nextResetAt ? Math.max(0, hoursBetween(ctx.now, ctx.nextResetAt)) : undefined;
    out.push({
      ...base,
      eventType: "exhaustion_forecast",
      eventKey: buildEventKey({
        providerId: ctx.providerId,
        limitKey: ctx.limitKey,
        eventType: "exhaustion_forecast",
        anchorIso: cycleAnchor,
      }),
      title: `${ctx.providerLabel} ${ctx.limitLabel}可能在重置前用完`,
      body:
        (hoursToExhaust < 1
          ? "依目前速度，預估不到 1 小時就會耗盡。"
          : `依目前速度，預估${formatDuration(hoursToExhaust)}後耗盡。`) +
        (hoursToReset !== undefined ? `\n距離重置還有${formatDuration(hoursToReset)}。` : ""),
      severity: "warning",
    });
  }

  // --- Usage warning (low remaining) ---
  if (
    ctx.remainingPercent !== undefined &&
    ctx.remainingPercent <= s.usageWarningRemainingPercent
  ) {
    out.push({
      ...base,
      eventType: "usage_warning",
      eventKey: buildEventKey({
        providerId: ctx.providerId,
        limitKey: ctx.limitKey,
        eventType: "usage_warning",
        anchorIso: cycleAnchor,
      }),
      // At (or below) the exhausted threshold the quota is gone, not "about to" go.
      title: exhausted
        ? `${ctx.providerLabel} ${ctx.limitLabel}已用完`
        : `${ctx.providerLabel} ${ctx.limitLabel}即將用完`,
      body: exhausted
        ? `額度已用盡，需等待重置。` +
          (ctx.nextResetAt ? `\n預計 ${formatLocal(ctx.nextResetAt)} 重置。` : "")
        : `依目前資料，剩餘額度約 ${Math.round(ctx.remainingPercent)}%。`,
      severity: "warning",
    });
  }

  // --- Data stale ---
  if (ctx.lastSuccessAt && isValidIso(ctx.lastSuccessAt)) {
    const ageHours = hoursBetween(ctx.lastSuccessAt, ctx.now);
    if (ageHours >= s.dataStaleHours) {
      out.push({
        ...base,
        eventType: "data_stale",
        eventKey: buildEventKey({
          providerId: ctx.providerId,
          limitKey: ctx.limitKey,
          eventType: "data_stale",
          anchorIso: hourBucketIso(ctx.lastSuccessAt),
        }),
        title: `${ctx.providerLabel} 用量資料已過期`,
        body: `最近一次成功更新是在約 ${Math.round(ageHours)} 小時前。\n目前預測可信度已降低。`,
        severity: "warning",
      });
    }
  }

  // --- Polling failed ---
  if (ctx.pollingFailed) {
    out.push({
      ...base,
      eventType: "polling_failed",
      eventKey: buildEventKey({
        providerId: ctx.providerId,
        limitKey: ctx.limitKey,
        eventType: "polling_failed",
        anchorIso: hourBucketIso(ctx.now),
      }),
      title: `${ctx.providerLabel} 同步失敗`,
      body: "最近一次自動同步未成功，將於下次排程重試。",
      severity: "info",
    });
  }

  return out;
}
