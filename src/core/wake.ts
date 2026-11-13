import {
  ClaimConflictError,
  StaleWriteError,
  type ActionId,
  type PlanId,
  type PlanRevision,
  type ProgramId,
} from "./types.js";

export type WakeId = string & { readonly __brand: "WakeId" };
export type DedupeKey = string & { readonly __brand: "DedupeKey" };
export type WakeTriggerType = "MANUAL" | "TIMER" | "EVIDENCE" | "PLAN_REVISION" | "HANDOFF" | "RECOVERY";
export type WakeStatus = "PENDING" | "CLAIMED" | "DELIVERED" | "COMPLETED" | "FAILED" | "UNKNOWN";

export interface WakeIntent {
  readonly wakeId: WakeId;
  readonly dedupeKey: DedupeKey;
  readonly programId: ProgramId;
  readonly planId: PlanId;
  readonly actionId?: ActionId;
  readonly planRevision: PlanRevision;
  readonly triggerType: WakeTriggerType;
  readonly notBefore: number;
  readonly preferredHarness?: string;
  readonly fallbackPolicy: string;
  readonly attempt: number;
  readonly status: WakeStatus;
}

export interface WakeScheduleRequest {
  readonly dedupeKey: DedupeKey;
  readonly programId: ProgramId;
  readonly planId: PlanId;
  readonly actionId?: ActionId;
  readonly planRevision: PlanRevision;
  readonly triggerType: WakeTriggerType;
  readonly notBefore?: number;
  readonly preferredHarness?: string;
  readonly fallbackPolicy: string;
}

export interface WakeClaim {
  readonly wakeId: WakeId;
  readonly fence: number;
  readonly ownerId: string;
}

export interface WakeDeliveryAcknowledgement {
  readonly status: "ACKNOWLEDGED" | "UNKNOWN";
  readonly deliveryId: string;
}

export interface WakeResultWrite {
  readonly status: "COMPLETED" | "FAILED" | "UNKNOWN";
  readonly evidenceReferences: readonly string[];
  readonly value?: unknown;
}

export interface WakeStore {
  putOrGet(intent: WakeIntent): Promise<{ readonly created: boolean; readonly intent: WakeIntent }>;
  listReady(now: number): Promise<readonly WakeIntent[]>;
  claim(wakeId: WakeId, ownerId: string, now: number): Promise<WakeClaim>;
  acknowledgeDelivery(claim: WakeClaim, acknowledgement: WakeDeliveryAcknowledgement): Promise<WakeIntent>;
  writeResult(claim: WakeClaim, result: WakeResultWrite): Promise<WakeIntent>;
  get(wakeId: WakeId): Promise<WakeIntent | undefined>;
}

export type WakeScheduleResult =
  | { readonly status: "SCHEDULED"; readonly intent: WakeIntent }
  | { readonly status: "DUPLICATE"; readonly intent: WakeIntent };

export interface WakeCoordinatorDependencies {
  readonly store: WakeStore;
  readonly clock?: () => number;
}

/**
 * The wake module owns trigger identity and delivery state. Harness adapters
 * only need to pull intents, claim one, acknowledge delivery, and write back.
 */
export class WakeCoordinator {
  private readonly clock: () => number;

  public constructor(private readonly dependencies: WakeCoordinatorDependencies) {
    this.clock = dependencies.clock ?? (() => Date.now());
  }

  public async schedule(request: WakeScheduleRequest): Promise<WakeScheduleResult> {
    const intent: WakeIntent = {
      wakeId: `wake:${request.dedupeKey}` as WakeId,
      dedupeKey: request.dedupeKey,
      programId: request.programId,
      planId: request.planId,
      actionId: request.actionId,
      planRevision: request.planRevision,
      triggerType: request.triggerType,
      notBefore: request.notBefore ?? this.clock(),
      preferredHarness: request.preferredHarness,
      fallbackPolicy: request.fallbackPolicy,
      attempt: 0,
      status: "PENDING",
    };
    return this.dependencies.store.putOrGet(intent).then((result) => ({
      status: result.created ? "SCHEDULED" : "DUPLICATE",
      intent: result.intent,
    }));
  }

  public resolve(now = this.clock()): Promise<readonly WakeIntent[]> {
    return this.dependencies.store.listReady(now);
  }

  public claim(wakeId: WakeId, ownerId: string, now = this.clock()): Promise<WakeClaim> {
    return this.dependencies.store.claim(wakeId, ownerId, now);
  }

  public acknowledgeDelivery(
    claim: WakeClaim,
    acknowledgement: WakeDeliveryAcknowledgement,
  ): Promise<WakeIntent> {
    return this.dependencies.store.acknowledgeDelivery(claim, acknowledgement);
  }

  public writeResult(claim: WakeClaim, result: WakeResultWrite): Promise<WakeIntent> {
    return this.dependencies.store.writeResult(claim, result);
  }
}

export class InMemoryWakeStore implements WakeStore {
  private readonly intents = new Map<WakeId, WakeIntent>();
  private readonly fences = new Map<WakeId, number>();
  private readonly leases = new Map<WakeId, { readonly claim: WakeClaim; readonly expiresAt: number }>();

  public constructor(private readonly leaseDurationMs = 30_000, private readonly clock = () => Date.now()) {}

  public async putOrGet(intent: WakeIntent): Promise<{ readonly created: boolean; readonly intent: WakeIntent }> {
    const existing = this.intents.get(intent.wakeId);
    if (existing) {
      if (!this.sameImmutableFields(existing, intent)) {
        throw new ClaimConflictError(`Wake dedupe key conflicts: ${intent.dedupeKey}`);
      }
      return { created: false, intent: existing };
    }
    this.intents.set(intent.wakeId, intent);
    return { created: true, intent };
  }

  public async listReady(now: number): Promise<readonly WakeIntent[]> {
    return [...this.intents.values()]
      .filter((intent) => intent.status === "PENDING" && intent.notBefore <= now)
      .sort((left, right) => left.notBefore - right.notBefore || left.wakeId.localeCompare(right.wakeId));
  }

  public async claim(wakeId: WakeId, ownerId: string, now: number): Promise<WakeClaim> {
    const intent = this.require(wakeId);
    const current = this.leases.get(wakeId);
    if (current && current.expiresAt > now) {
      throw new ClaimConflictError(`Wake ${wakeId} is claimed by ${current.claim.ownerId}`);
    }
    if (intent.status !== "PENDING" && intent.status !== "UNKNOWN") {
      throw new ClaimConflictError(`Wake ${wakeId} is not claimable in ${intent.status}`);
    }

    const fence = (this.fences.get(wakeId) ?? 0) + 1;
    const claim = { wakeId, fence, ownerId };
    this.fences.set(wakeId, fence);
    this.leases.set(wakeId, { claim, expiresAt: now + this.leaseDurationMs });
    this.intents.set(wakeId, { ...intent, attempt: intent.attempt + 1, status: "CLAIMED" });
    return claim;
  }

  public async acknowledgeDelivery(
    claim: WakeClaim,
    acknowledgement: WakeDeliveryAcknowledgement,
  ): Promise<WakeIntent> {
    this.assertClaim(claim);
    const intent = this.require(claim.wakeId);
    const status = acknowledgement.status === "ACKNOWLEDGED" ? "DELIVERED" : "UNKNOWN";
    const updated = { ...intent, status } as WakeIntent;
    this.intents.set(claim.wakeId, updated);
    return updated;
  }

  public async writeResult(claim: WakeClaim, result: WakeResultWrite): Promise<WakeIntent> {
    this.assertClaim(claim);
    const intent = this.require(claim.wakeId);
    const updated = { ...intent, status: result.status };
    this.intents.set(claim.wakeId, updated);
    this.leases.delete(claim.wakeId);
    return updated;
  }

  public async get(wakeId: WakeId): Promise<WakeIntent | undefined> {
    return this.intents.get(wakeId);
  }

  private require(wakeId: WakeId): WakeIntent {
    const intent = this.intents.get(wakeId);
    if (!intent) {
      throw new Error(`Wake not found: ${wakeId}`);
    }
    return intent;
  }

  private assertClaim(claim: WakeClaim): void {
    const current = this.leases.get(claim.wakeId);
    if (!current || current.claim.fence !== claim.fence || current.claim.ownerId !== claim.ownerId || current.expiresAt <= this.clock()) {
      throw new StaleWriteError(`Wake claim is stale: ${claim.wakeId}`);
    }
  }

  private sameImmutableFields(left: WakeIntent, right: WakeIntent): boolean {
    return left.dedupeKey === right.dedupeKey
      && left.programId === right.programId
      && left.planId === right.planId
      && left.actionId === right.actionId
      && left.planRevision === right.planRevision
      && left.triggerType === right.triggerType
      && left.notBefore === right.notBefore
      && left.preferredHarness === right.preferredHarness
      && left.fallbackPolicy === right.fallbackPolicy;
  }
}
