import { formatLocalDateTime } from "./util";
export type ResetCreditExpiry = { title: string; expiresAtUnix?: number };

export type ResetCreditSummary = {
  availableCount: number;
  nearestExpiry?: string;
  expiringSoon: boolean;
  expiryDates: string[];
  recommendations: ResetCreditRecommendation[];
  /** Headline advice for the whole stack — always about the next single credit. */
  plan?: ResetCreditPlan;
};

export type ResetCreditPlan = {
  /** Credits it would take to bridge the gap to the official reset at the recent burn rate. */
  estimatedNeeded?: number;
  /** How long one fresh quota is expected to last at that rate, in hours. */
  hoursPerCredit?: number;
  message: string;
};

export type ResetCreditRecommendation = {
  expiresAt: string;
  latestUseAt: string;
  action: "use_now" | "wait";
  message: string;
};

function formatSpan(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "未知";
  if (hours < 24) return `約 ${Math.max(1, Math.round(hours))} 小時`;
  return `約 ${Math.round(hours / 24)} 天`;
}

/**
 * Advice for a stack of Codex "Full reset" credits.
 *
 * Credits are spent one at a time: redeeming one starts a fresh quota immediately, so burning a
 * second before the first is used up throws it away. Every message therefore concerns only the
 * NEXT credit, and — when the recent burn rate is known — compares how far that one credit is
 * expected to carry the user against how long is left until the quota resets by itself, which is
 * what actually decides whether spending one is worth it.
 */
export function summarizeResetCredits(
  availableCount: number,
  credits: ResetCreditExpiry[],
  nowIso: string,
  warningHours = 72,
  usedPercent = 0,
  automaticResetAt?: string,
  /** Percentage points of quota consumed per hour recently (e.g. forecast.burnRate24h). */
  burnRatePerHour?: number
): ResetCreditSummary {
  const now = Date.parse(nowIso);
  const expiryDates = credits
    .map((credit) => credit.expiresAtUnix)
    .filter((value): value is number => Number.isFinite(value))
    .map((value) => new Date(value * 1000).toISOString())
    .filter((value) => Date.parse(value) > now)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const nearestExpiry = expiryDates[0];
  const count = Math.max(0, Math.round(availableCount));

  const hoursUntilReset = automaticResetAt && Date.parse(automaticResetAt) > now
    ? (Date.parse(automaticResetAt) - now) / 3_600_000
    : undefined;
  // A credit restores the whole quota, so its lifetime is 100 points at the recent burn rate.
  const hoursPerCredit = burnRatePerHour && burnRatePerHour > 0 ? 100 / burnRatePerHour : undefined;

  const recommendations = expiryDates.map((expiresAt, index): ResetCreditRecommendation => {
    const latestUseTime = Math.max(now, Date.parse(expiresAt) - 6 * 60 * 60 * 1000);
    const latestUseAt = new Date(latestUseTime).toISOString();
    // Only the earliest credit is ever actionable; the rest are queued behind it.
    if (index === 0 && usedPercent >= 80) {
      return {
        expiresAt, latestUseAt, action: "use_now",
        message: `目前已使用 ${Math.round(usedPercent)}%，建議使用這 1 張`,
      };
    }
    const resetsBeforeExpiry = automaticResetAt
      && Date.parse(automaticResetAt) > now
      && Date.parse(automaticResetAt) < Date.parse(expiresAt);
    const message = resetsBeforeExpiry
      ? `先等 ${formatLocalDateTime(automaticResetAt)} 官方重置，下一輪達 80% 再用`
      : index === 0 ? "用量達 80% 再用" : "排在前一張之後，輪到時達 80% 再用";
    return { expiresAt, latestUseAt, action: "wait", message };
  });

  return {
    availableCount: count,
    nearestExpiry,
    expiringSoon: Boolean(nearestExpiry && Date.parse(nearestExpiry) - now <= warningHours * 60 * 60 * 1000),
    expiryDates,
    recommendations,
    plan: buildPlan({ count, usedPercent, hoursUntilReset, hoursPerCredit, automaticResetAt }),
  };
}

function buildPlan(input: {
  count: number;
  usedPercent: number;
  hoursUntilReset?: number;
  hoursPerCredit?: number;
  automaticResetAt?: string;
}): ResetCreditPlan | undefined {
  const { count, usedPercent, hoursUntilReset, hoursPerCredit, automaticResetAt } = input;
  if (count <= 0) return undefined;

  const estimatedNeeded = hoursUntilReset !== undefined && hoursPerCredit !== undefined
    ? Math.max(1, Math.ceil(hoursUntilReset / hoursPerCredit))
    : undefined;
  const pace = hoursPerCredit !== undefined
    ? `依近期速度 1 張可撐 ${formatSpan(hoursPerCredit)}`
    : undefined;
  const gap = hoursUntilReset !== undefined
    ? `距離 ${formatLocalDateTime(automaticResetAt)} 重置還有 ${formatSpan(hoursUntilReset)}`
    : undefined;

  if (usedPercent < 80) {
    return {
      estimatedNeeded,
      hoursPerCredit,
      message: [`先不用票，用量達 80% 再考慮（目前 ${Math.round(usedPercent)}%）`, gap]
        .filter(Boolean).join("；"),
    };
  }

  // Ready to spend — exactly one, then reassess against fresh numbers.
  const outlook = estimatedNeeded === undefined
    ? "用完這張再依當時用量決定下一張"
    : estimatedNeeded <= 1
      ? "這 1 張預計就能撐到重置"
      : estimatedNeeded > count
        ? `照這個速度撐到重置約需 ${estimatedNeeded} 張，但只有 ${count} 張，後段可能要放慢`
        : `照這個速度撐到重置約需 ${estimatedNeeded} 張，用完這張再看要不要下一張`;
  return {
    estimatedNeeded,
    hoursPerCredit,
    message: [`建議現在用 1 張（用後還剩 ${count - 1} 張）`, pace, gap, outlook]
      .filter(Boolean).join("；"),
  };
}
