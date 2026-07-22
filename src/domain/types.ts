// Domain model — pure TypeScript types. NO React, NO SQL, NO OS awareness here.
// Timestamps are ISO 8601 UTC strings unless noted. Percentages are 0..100.
// Secret VALUES never appear in these types; only `secretRef` strings do.

export type ProviderId =
  | "claude"
  | "codex"
  | "chatgpt"
  | "gemini"
  | "cursor"
  | "custom";

export type UsageSource =
  | "manual"
  | "json_import"
  | "demo"
  | "cli"
  | "browser"
  | "api";

export type LimitType =
  | "rolling_session"
  | "weekly"
  | "weekly_model"
  | "context"
  | "credits"
  | "custom";

export type TaskType =
  | "short_chat"
  | "general_chat"
  | "coding"
  | "large_context"
  | "research"
  | "custom";

export type NotificationChannelType =
  | "desktop"
  | "discord"
  | "slack"
  | "telegram"
  | "custom_webhook";

export type NotificationEventType =
  | "quota_expiring"
  | "reset_expected"
  | "reset_confirmed"
  | "usage_warning"
  | "usage_exhausted"
  | "exhaustion_forecast"
  | "polling_failed"
  | "data_stale";

export type Severity = "info" | "warning" | "critical";

export type ProviderAccount = {
  id: string;
  providerId: ProviderId;
  displayName: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SubscriptionPlan = {
  id: string;
  providerId: ProviderId;
  accountId: string;
  name: string;
  monthlyPrice: number;
  currency: string;
  relativeCapacity?: number;
  active: boolean;
  startedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type UsageLimit = {
  id: string;
  planId: string;
  name: string;
  type: LimitType;
  model?: string;
  windowHours?: number;
  resetRule?: string;
  timezone: string;
  active: boolean;
  monitoringEnabled: boolean;
  notifyEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UsageSnapshot = {
  id: string;
  providerId: ProviderId;
  accountId: string;
  limitId: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt?: string;
  capturedAt: string;
  source: UsageSource;
  valid: boolean;
  confidence: number;
  errorCode?: string;
  note?: string;
};

export type ActivityStatus = "in_progress" | "completed" | "cancelled";

export type UsageActivity = {
  id: string;
  providerId: ProviderId;
  accountId: string;
  limitId: string;
  model?: string;
  projectName?: string;
  taskType: TaskType;
  startedAt: string;
  endedAt?: string;
  usageBefore?: number;
  usageAfter?: number;
  usageDelta?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  status: ActivityStatus;
  note?: string;
};

export type ResetDetectionMethod =
  | "confirmed_by_usage_drop"
  | "confirmed_by_reset_change"
  | "expected_time_reached"
  | "manual";

export type ResetEvent = {
  id: string;
  providerId: ProviderId;
  accountId: string;
  limitId: string;
  previousUsedPercent?: number;
  currentUsedPercent?: number;
  expectedResetAt?: string;
  detectedAt: string;
  detectionMethod: ResetDetectionMethod;
  confidence: number;
};

export type ForecastResult = {
  limitId: string;
  calculatedAt: string;
  estimatedExhaustionAt?: string;
  estimatedRemainingAtReset?: number;
  willExhaustBeforeReset?: boolean;
  burnRate6h?: number;
  burnRate24h?: number;
  burnRateCurrentCycle?: number;
  confidence: number;
  sampleCount: number;
  warnings: string[];
};

export type RemainingTaskEstimate = {
  taskType: TaskType;
  minimum: number;
  maximum: number;
  medianUsageDelta?: number;
  sampleCount: number;
  confidence: number;
  warnings: string[];
};

export type PlanRecommendationType =
  | "upgrade"
  | "keep"
  | "downgrade"
  | "insufficient_data";

export type PlanRecommendation = {
  recommendation: PlanRecommendationType;
  confidence: number;
  reasons: string[];
  fourWeekAverageUtilization?: number;
  earlyExhaustedCycles?: number;
  evaluatedCycles: number;
};

export type NotificationChannelConfig = {
  id: string;
  type: NotificationChannelType;
  displayName: string;
  enabled: boolean;
  secretRef?: string;
  /** Non-secret config, e.g. Telegram chatId, custom-webhook headers template. */
  config?: Record<string, string>;
  eventPreferences: Record<NotificationEventType, boolean>;
  quietHoursStart?: string; // "HH:MM" local
  quietHoursEnd?: string; // "HH:MM" local
  minIntervalMinutes?: number;
  createdAt: string;
  updatedAt: string;
};

export type NotificationEvent = {
  id: string;
  eventKey: string;
  eventType: NotificationEventType;
  providerId?: ProviderId;
  accountId?: string;
  limitId?: string;
  title: string;
  body: string;
  severity: Severity;
  createdAt: string;
};

export type NotificationDeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export type NotificationDelivery = {
  id: string;
  eventId: string;
  eventKey: string;
  channelId: string;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  attemptedAt?: string;
  deliveredAt?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type DataSourceReliability = "manual" | "imported" | "demo" | "automated";

export type DataSourceStatus = {
  id: string;
  providerId: ProviderId;
  adapterId: string;
  displayName: string;
  enabled: boolean;
  supportsAutomaticPolling: boolean;
  reliability: DataSourceReliability;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  updatedAt: string;
};

export type SchedulerRunStatus = "running" | "success" | "failed";

export type SchedulerRun = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: SchedulerRunStatus;
  trigger: "launch" | "interval" | "manual";
  detail?: string;
};

export type ConfidenceLevel = "low" | "medium" | "high";

/** A numeric confidence in [0,1] together with the human-readable reasons that produced it. */
export type ConfidenceResult = {
  value: number;
  level: ConfidenceLevel;
  reasons: string[];
};
