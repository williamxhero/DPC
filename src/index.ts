export { DpcCore } from "./core/kernel.js";
export { assessTacticalRoute, createAdvisoryPlanChange, revisionCanAffectAction } from "./core/revision.js";
export { CloudflareKvEffectRuntime } from "./adapters/cloudflare-kv.js";
export { WranglerKvEffectRuntime } from "./adapters/wrangler-kv.js";
export type { CloudflareKvConfig } from "./adapters/cloudflare-kv.js";
export type { WranglerKvConfig } from "./adapters/wrangler-kv.js";
export { LocalFileEffectRuntime } from "./adapters/local-file.js";
export { InMemoryWakeStore, WakeCoordinator } from "./core/wake.js";
export { HandoffBlockedError, HandoffCoordinator, InMemoryHandoffStore } from "./core/handoff.js";
export { inspectProfileConformance } from "./core/standard-kit.js";
export { InMemoryProjectionAdapter } from "./core/projection.js";
export type { ConformanceCheck, ProfileConformanceReport } from "./core/standard-kit.js";
export type { ProjectionAdapter, ProjectionDrift, ReadOnlyProjection } from "./core/projection.js";
export type {
  CheckpointMode,
  DeliveryState,
  HandoffBundle,
  HandoffContinuationIdentity,
  HandoffInput,
  HandoffStatus,
  UnknownExternalResult,
  WorkspaceCheckpoint,
  WorkspaceState,
} from "./core/handoff.js";
export type {
  DedupeKey,
  WakeClaim,
  WakeDeliveryAcknowledgement,
  WakeId,
  WakeIntent,
  WakeResultWrite,
  WakeScheduleRequest,
  WakeScheduleResult,
  WakeStatus,
  WakeTriggerType,
} from "./core/wake.js";
export type { DpcCoreDependencies } from "./core/kernel.js";
export {
  InMemoryActionLedger,
  InMemoryClaimAuthority,
  InMemoryNfRuntime,
  InMemoryPlanSource,
  InMemoryProfile,
  NoopClaimAuthority,
} from "./core/in-memory.js";
export * from "./core/types.js";
