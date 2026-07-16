// Composition root: builds repositories + services against the real Tauri runtime, or against
// in-memory fakes when running outside Tauri (plain `vite dev` preview / tests).

import {
  createBestSecretStore,
  createTauriAutoStart,
  createTauriBackgroundRuntime,
  createTauriNotifier,
  InMemoryAutoStart,
  InMemoryBackgroundRuntime,
  InMemoryNotifier,
  InMemorySecretStore,
  isTauriRuntime,
} from "@/adapters/platform";
import { createChannelAdapters } from "@/adapters/notifications/channels";
import { createTauriHttpPoster } from "@/adapters/notifications/http";
import type { HttpPoster } from "@/adapters/notifications/http";
import { getTauriDatabase } from "@/adapters/storage/db";
import { FakeSqlDatabase } from "@/adapters/storage/fakeDb";
import {
  createActivityRepository,
  createDataSourceRepository,
  createNotificationRepository,
  createProviderRepository,
  createResetEventRepository,
  createSchedulerRepository,
  createSettingsRepository,
  createSnapshotRepository,
} from "@/adapters/storage/repositories";
import type {
  AutoStartService,
  BackgroundRuntime,
  DataSourceRepository,
  NotificationRepository,
  ProviderRepository,
  ResetEventRepository,
  SchedulerRepository,
  SecretStore,
  SettingsRepository,
  SystemNotifier,
  UsageActivityRepository,
  UsageSnapshotRepository,
} from "@/ports";
import { createDemoDataService, type DemoDataService } from "@/services/demoData";
import { createExportImportService, type ExportImportService } from "@/services/exportImport";
import { createMonitorService, createScheduler, type MonitorService } from "@/services/monitorService";
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from "@/services/notificationDispatcher";
import { SETTINGS_KEYS, settingBool } from "@/services/settingsKeys";

export const APP_VERSION = "0.1.0";

export type AppServices = {
  isTauri: boolean;
  secretBackend: "keychain" | "file" | "memory";
  providerRepo: ProviderRepository;
  snapshotRepo: UsageSnapshotRepository;
  activityRepo: UsageActivityRepository;
  resetRepo: ResetEventRepository;
  notificationRepo: NotificationRepository;
  settingsRepo: SettingsRepository;
  dataSourceRepo: DataSourceRepository;
  schedulerRepo: SchedulerRepository;
  secretStore: SecretStore;
  notifier: SystemNotifier;
  autoStart: AutoStartService;
  backgroundRuntime: BackgroundRuntime;
  dispatcher: NotificationDispatcher;
  monitor: MonitorService;
  scheduler: ReturnType<typeof createScheduler>;
  demo: DemoDataService;
  exportImport: ExportImportService;
};

/** Browser-preview HTTP poster: regular fetch (subject to CORS; fine for previews). */
function browserHttpPoster(): HttpPoster {
  return {
    async postJson(url, body, headers) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify(body),
      });
      return { status: res.status, ok: res.ok, bodyText: await res.text().catch(() => "") };
    },
  };
}

let servicesPromise: Promise<AppServices> | null = null;

export function getAppServices(): Promise<AppServices> {
  if (!servicesPromise) servicesPromise = buildServices();
  return servicesPromise;
}

async function buildServices(): Promise<AppServices> {
  const tauri = isTauriRuntime();

  const db = tauri ? await getTauriDatabase() : new FakeSqlDatabase();

  const providerRepo = createProviderRepository(db);
  const snapshotRepo = createSnapshotRepository(db);
  const activityRepo = createActivityRepository(db);
  const resetRepo = createResetEventRepository(db);
  const notificationRepo = createNotificationRepository(db);
  const settingsRepo = createSettingsRepository(db);
  const dataSourceRepo = createDataSourceRepository(db);
  const schedulerRepo = createSchedulerRepository(db);

  let secretStore: SecretStore;
  let secretBackend: AppServices["secretBackend"];
  let notifier: SystemNotifier;
  let autoStart: AutoStartService;
  let backgroundRuntime: BackgroundRuntime;
  let http: HttpPoster;

  if (tauri) {
    const best = await createBestSecretStore();
    secretStore = best.store;
    secretBackend = best.backend;
    notifier = createTauriNotifier();
    autoStart = createTauriAutoStart();
    backgroundRuntime = createTauriBackgroundRuntime();
    http = createTauriHttpPoster();
  } else {
    secretStore = new InMemorySecretStore();
    secretBackend = "memory";
    notifier = new InMemoryNotifier();
    autoStart = new InMemoryAutoStart();
    backgroundRuntime = new InMemoryBackgroundRuntime();
    http = browserHttpPoster();
  }

  await settingsRepo.set(SETTINGS_KEYS.secretBackend, secretBackend);

  const adapters = createChannelAdapters({ notifier, http });

  const dispatcher = createNotificationDispatcher({
    repo: notificationRepo,
    secretStore,
    adapters,
    notificationsEnabled: async () =>
      settingBool(await settingsRepo.get(SETTINGS_KEYS.notificationsEnabled), true),
  });

  const monitor = createMonitorService({
    providerRepo,
    snapshotRepo,
    resetRepo,
    schedulerRepo,
    settingsRepo,
    dispatcher,
  });

  const scheduler = createScheduler(monitor, 1);

  const demo = createDemoDataService({
    providerRepo,
    snapshotRepo,
    activityRepo,
    resetRepo,
    notificationRepo,
    settingsRepo,
  });

  const exportImport = createExportImportService({
    providerRepo,
    snapshotRepo,
    activityRepo,
    resetRepo,
    notificationRepo,
    settingsRepo,
    appVersion: APP_VERSION,
  });

  return {
    isTauri: tauri,
    secretBackend,
    providerRepo,
    snapshotRepo,
    activityRepo,
    resetRepo,
    notificationRepo,
    settingsRepo,
    dataSourceRepo,
    schedulerRepo,
    secretStore,
    notifier,
    autoStart,
    backgroundRuntime,
    dispatcher,
    monitor,
    scheduler,
    demo,
    exportImport,
  };
}
