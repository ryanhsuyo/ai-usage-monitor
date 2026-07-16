// Local re-exports so channel adapters depend on one small surface.
import type { HttpPoster } from "./http";

export type {
  ChannelRuntime,
  NotificationChannelAdapter,
  NotificationMessage,
  NotificationResult,
  SystemNotifier,
  ValidationResult,
} from "@/ports";

export type HttpPosterLike = HttpPoster;
