import {
  StaleWriteError,
  type ActionId,
  type EventKey,
  type PlanId,
  type PlanRevision,
  type ProgramId,
} from "./types.js";

export type CheckpointMode = "commit" | "artifact" | "read-only";
export type WorkspaceState = "CLEAN" | "DIRTY" | "UNKNOWN";
export type HandoffStatus = "READY" | "BLOCKED" | "UNKNOWN" | "ACCEPTED";
export type DeliveryState = "CONFIRMED" | "UNKNOWN";
export type UnknownExternalResult = "NONE" | "PRESENT";

export interface WorkspaceCheckpoint {
  readonly mode: CheckpointMode;
  readonly state: WorkspaceState;
  readonly reference?: string;
}

export interface HandoffInput {
  readonly programId: ProgramId;
  readonly planId: PlanId;
  readonly planRevision: PlanRevision;
  readonly actionId: ActionId;
  readonly eventKey: EventKey;
  readonly sourceHarness: string;
  readonly sourceRun: string;
  readonly currentStatus: string;
  readonly completedScope: readonly string[];
  readonly remainingScope: readonly string[];
  readonly acceptanceReferences: readonly string[];
  readonly authorizationReferences: readonly string[];
  readonly evidenceReferences: readonly string[];
  readonly lastCheckpoint: string;
  readonly nextAction?: string;
  readonly unknownExternalResult: UnknownExternalResult;
  readonly workspace: WorkspaceCheckpoint;
  readonly checkpointConfirmed: boolean;
  readonly deliveryState: DeliveryState;
}

export interface HandoffBundle extends HandoffInput {
  readonly handoffId: string;
  readonly status: HandoffStatus;
  readonly createdAt: number;
  readonly acceptedBy?: string;
}

export interface HandoffContinuationIdentity {
  readonly programId: ProgramId;
  readonly planId: PlanId;
  readonly planRevision: PlanRevision;
  readonly actionId: ActionId;
  readonly eventKey: EventKey;
}

export interface HandoffStore {
  putOrGet(bundle: HandoffBundle): Promise<{ readonly created: boolean; readonly bundle: HandoffBundle }>;
  get(handoffId: string): Promise<HandoffBundle | undefined>;
  accept(handoffId: string, targetHarness: string, expected: HandoffBundle): Promise<HandoffBundle>;
}

export interface HandoffCoordinatorDependencies {
  readonly store: HandoffStore;
  readonly clock?: () => number;
}

export class HandoffBlockedError extends Error {
  public readonly code = "HANDOFF_BLOCKED" as const;

  public constructor(message: string) {
    super(message);
    this.name = "HandoffBlockedError";
  }
}

/**
 * Handoff is a verifiable checkpoint transfer, not a transcript/session
 * transfer. Sensitive provider context is intentionally absent from the model.
 */
export class HandoffCoordinator {
  private readonly clock: () => number;

  public constructor(private readonly dependencies: HandoffCoordinatorDependencies) {
    this.clock = dependencies.clock ?? (() => Date.now());
  }

  public async create(input: HandoffInput): Promise<HandoffBundle> {
    const bundle: HandoffBundle = {
      ...input,
      handoffId: `handoff:${[input.programId, input.planId, input.eventKey, input.sourceRun]
        .map((value) => encodeURIComponent(value))
        .join(":")}`,
      status: this.initialStatus(input),
      createdAt: this.clock(),
      completedScope: [...input.completedScope],
      remainingScope: [...input.remainingScope],
      acceptanceReferences: [...input.acceptanceReferences],
      authorizationReferences: [...input.authorizationReferences],
      evidenceReferences: [...input.evidenceReferences],
    };
    return (await this.dependencies.store.putOrGet(bundle)).bundle;
  }

  public async readForContinuation(
    handoffId: string,
    targetHarness: string,
    expected: HandoffContinuationIdentity,
  ): Promise<HandoffBundle> {
    const bundle = await this.dependencies.store.get(handoffId);
    if (!bundle) {
      throw new HandoffBlockedError(`Handoff not found: ${handoffId}`);
    }
    if (bundle.status !== "READY" && bundle.status !== "ACCEPTED") {
      throw new HandoffBlockedError(`Handoff ${handoffId} is ${bundle.status}`);
    }
    if (!this.sameIdentity(bundle, expected)) {
      throw new StaleWriteError(`Handoff context is stale: ${handoffId}`);
    }
    return this.dependencies.store.accept(handoffId, targetHarness, bundle);
  }

  private sameIdentity(bundle: HandoffBundle, expected: HandoffContinuationIdentity): boolean {
    return bundle.programId === expected.programId
      && bundle.planId === expected.planId
      && bundle.planRevision === expected.planRevision
      && bundle.actionId === expected.actionId
      && bundle.eventKey === expected.eventKey;
  }

  private initialStatus(input: HandoffInput): HandoffStatus {
    if (!input.checkpointConfirmed || input.workspace.state === "DIRTY") {
      return "BLOCKED";
    }
    if (input.deliveryState === "UNKNOWN" || input.workspace.state === "UNKNOWN" || input.unknownExternalResult === "PRESENT") {
      return "UNKNOWN";
    }
    return "READY";
  }
}

export class InMemoryHandoffStore implements HandoffStore {
  private readonly bundles = new Map<string, HandoffBundle>();

  public async putOrGet(bundle: HandoffBundle): Promise<{ readonly created: boolean; readonly bundle: HandoffBundle }> {
    const existing = this.bundles.get(bundle.handoffId);
    if (existing) {
      if (existing.programId !== bundle.programId
        || existing.planId !== bundle.planId
        || existing.planRevision !== bundle.planRevision
        || existing.actionId !== bundle.actionId
        || existing.eventKey !== bundle.eventKey) {
        throw new StaleWriteError(`Handoff identity conflicts: ${bundle.handoffId}`);
      }
      return { created: false, bundle: existing };
    }
    this.bundles.set(bundle.handoffId, bundle);
    return { created: true, bundle };
  }

  public async get(handoffId: string): Promise<HandoffBundle | undefined> {
    return this.bundles.get(handoffId);
  }

  public async accept(handoffId: string, targetHarness: string, expected: HandoffBundle): Promise<HandoffBundle> {
    const current = this.bundles.get(handoffId);
    if (!current
      || current.programId !== expected.programId
      || current.planId !== expected.planId
      || current.planRevision !== expected.planRevision
      || current.actionId !== expected.actionId
      || current.eventKey !== expected.eventKey) {
      throw new StaleWriteError(`Handoff changed before acceptance: ${handoffId}`);
    }
    const accepted = {
      ...current,
      status: "ACCEPTED" as const,
      acceptedBy: targetHarness,
    };
    this.bundles.set(handoffId, accepted);
    return accepted;
  }
}
