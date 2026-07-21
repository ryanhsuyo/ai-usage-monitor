import { formatLocalDateTime } from "./util";
export type ResetCreditExpiry = { title: string; expiresAtUnix?: number };

export type ResetCreditSummary = {
  availableCount: number;
  nearestExpiry?: string;
  expiringSoon: boolean;
  expiryDates: string[];
  recommendations: ResetCreditRecommendation[];
};

export type ResetCreditRecommendation = {
  expiresAt: string;
  latestUseAt: string;
  action: "use_now" | "wait";
  message: string;
};

export function summarizeResetCredits(
  availableCount: number,
  credits: ResetCreditExpiry[],
  nowIso: string,
  warningHours = 72,
  usedPercent = 0,
  automaticResetAt?: string
): ResetCreditSummary {
  const now = Date.parse(nowIso);
  const expiryDates = credits
    .map((credit) => credit.expiresAtUnix)
    .filter((value): value is number => Number.isFinite(value))
    .map((value) => new Date(value * 1000).toISOString())
    .filter((value) => Date.parse(value) > now)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const nearestExpiry = expiryDates[0];
  const recommendations = expiryDates.map((expiresAt, index): ResetCreditRecommendation => {
    const latestUseTime = Math.max(now, Date.parse(expiresAt) - 6 * 60 * 60 * 1000);
    const latestUseAt = new Date(latestUseTime).toISOString();
    if (index === 0 && usedPercent >= 80) {
      return { expiresAt, latestUseAt, action: "use_now", message: `目前已使用 ${Math.round(usedPercent)}%，建議現在使用` };
    }
    const resetsBeforeExpiry = automaticResetAt
      && Date.parse(automaticResetAt) > now
      && Date.parse(automaticResetAt) < Date.parse(expiresAt);
    // Name the official reset date. "先等官方重置" alone makes the reader work out when that
    // is before they can judge which day spending a credit actually pays off.
    const message = resetsBeforeExpiry
      ? `先等 ${formatLocalDateTime(automaticResetAt)} 官方重置，下一輪達 80% 再用`
      : index === 0 ? "用量達 80% 再用" : "先用較早到期票券，輪到時達 80% 再用";
    return { expiresAt, latestUseAt, action: "wait", message };
  });
  return {
    availableCount: Math.max(0, Math.round(availableCount)), nearestExpiry,
    expiringSoon: Boolean(nearestExpiry && Date.parse(nearestExpiry) - now <= warningHours * 60 * 60 * 1000),
    expiryDates, recommendations,
  };
}
