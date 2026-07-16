// UI state store (zustand). Holds loaded data + derived view models. UI-only state; domain
// objects pass through untouched (spec: UI state must not leak into the domain model).

import { create } from "zustand";
import type {
  NotificationChannelConfig,
  NotificationDelivery,
  NotificationEvent,
  ProviderAccount,
  ResetEvent,
  SchedulerRun,
  SubscriptionPlan,
  UsageActivity,
  UsageLimit,
  UsageSnapshot,
} from "@/domain/types";
import { getAppServices } from "../appServices";

export type PageId =
  | "dashboard"
  | "history"
  | "activity"
  | "plans"
  | "dataSources"
  | "notifications"
  | "settings";

type AppData = {
  loaded: boolean;
  accounts: ProviderAccount[];
  plans: SubscriptionPlan[];
  limits: UsageLimit[];
  snapshotsByLimit: Record<string, UsageSnapshot[]>;
  activities: UsageActivity[];
  resetEvents: ResetEvent[];
  channels: NotificationChannelConfig[];
  events: NotificationEvent[];
  deliveries: NotificationDelivery[];
  settings: Record<string, string>;
  latestRun?: SchedulerRun;
};

type AppState = AppData & {
  page: PageId;
  selectedLimitId?: string;
  demoMode: boolean;
  onboardingCompleted: boolean;
  navigate: (page: PageId) => void;
  selectLimit: (limitId: string | undefined) => void;
  refresh: () => Promise<void>;
};

export const useAppStore = create<AppState>((set, get) => ({
  loaded: false,
  accounts: [],
  plans: [],
  limits: [],
  snapshotsByLimit: {},
  activities: [],
  resetEvents: [],
  channels: [],
  events: [],
  deliveries: [],
  settings: {},
  page: "dashboard",
  demoMode: false,
  onboardingCompleted: true, // assume true until settings load to avoid flashing onboarding

  navigate: (page) => set({ page }),
  selectLimit: (selectedLimitId) => set({ selectedLimitId }),

  refresh: async () => {
    const services = await getAppServices();
    const [accounts, plans, limits, activities, resetEvents, channels, events, deliveries, settings, latestRun] =
      await Promise.all([
        services.providerRepo.listAccounts(),
        services.providerRepo.listPlans(),
        services.providerRepo.listLimits(),
        services.activityRepo.listAll(),
        services.resetRepo.listAll(),
        services.notificationRepo.listChannels(),
        services.notificationRepo.listEvents({ limit: 100 }),
        services.notificationRepo.listDeliveries({}),
        services.settingsRepo.getAll(),
        services.schedulerRepo.latestRun(),
      ]);

    const snapshotsByLimit: Record<string, UsageSnapshot[]> = {};
    for (const limit of limits) {
      snapshotsByLimit[limit.id] = await services.snapshotRepo.listByLimit(limit.id);
    }

    const selected = get().selectedLimitId;
    const firstActive = limits.find((l) => l.active && l.monitoringEnabled) ?? limits[0];

    set({
      loaded: true,
      accounts,
      plans,
      limits,
      snapshotsByLimit,
      activities,
      resetEvents,
      channels,
      events,
      deliveries,
      settings,
      latestRun,
      demoMode: settings["app.demoMode"] === "true",
      onboardingCompleted: settings["app.onboardingCompleted"] === "true",
      selectedLimitId: selected && limits.some((l) => l.id === selected) ? selected : firstActive?.id,
    });
  },
}));
