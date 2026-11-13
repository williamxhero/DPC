export type ProgramId = string & { readonly __brand: "ProgramId" };
export type PlanId = string & { readonly __brand: "PlanId" };
export type PlanRevision = string & { readonly __brand: "PlanRevision" };
export type ActionId = string & { readonly __brand: "ActionId" };
export type EventKey = string & { readonly __brand: "EventKey" };
export type NfTaskId = string & { readonly __brand: "NfTaskId" };

export type ActionLifecycle = "NOT_STARTED" | "STARTED" | "COMPLETED" | "WAITING" | "FAILED" | "UNKNOWN";

export interface TimeWindow {
  readonly notBefore?: number;
  readonly expiresAt?: number;
}

export interface TacticalRoute {
  readonly routeKey: string;
  readonly expectedEvidence: readonly string[];
  readonly expectedSignals: readonly string[];
  readonly risks: readonly string[];
  readonly fallback: string;
  readonly successConditions: readonly string[];
  readonly stopConditions: readonly string[];
}

export interface ActionDescriptor {
  readonly actionId: ActionId;
  readonly actionType: string;
  readonly target: unknown;
  readonly metrics: readonly string[];
  readonly authorization: {
    readonly reference: string;
    readonly scopes: readonly string[];
  };
  readonly timeWindow?: TimeWindow;
  readonly stopConditions: readonly string[];
  readonly waitConditions: readonly string[];
  readonly dependencies: readonly ActionId[];
  readonly tacticalRoutes?: readonly TacticalRoute[];
}

export interface RevisionScope {
  readonly actionIds: readonly ActionId[];
}

export interface PlanRevisionRecord {
  readonly planId: PlanId;
  readonly revision: PlanRevision;
  readonly previousRevision?: PlanRevision;
  readonly source: string;
  readonly evidenceReferences: readonly string[];
  readonly approvalReference?: string;
  readonly scope: RevisionScope;
  readonly effectiveAt: number;
  readonly createdAt: number;
}

export interface PlanSnapshot {
  readonly programId: ProgramId;
  readonly planId: PlanId;
  readonly revision: PlanRevision;
  readonly profileInput: unknown;
  readonly revisionRecord?: PlanRevisionRecord;
}

export interface Evidence {
  readonly reference: string;
  readonly kind: string;
  readonly observedAt: number;
  readonly value?: unknown;
}

export type NfStatus = "CONTINUE" | "DONE" | "WAIT_EXTERNAL" | "FAILED" | "UNKNOWN";
export type BusinessStatus = "CONTINUE" | "COMPLETED" | "WAIT_EXTERNAL" | "FAILED" | "UNKNOWN";

export interface NfExecutionResult {
  readonly status: NfStatus;
  readonly evidence: readonly Evidence[];
  readonly output?: unknown;
  readonly error?: string;
  /** Runtime adapters echo this when they can prove which invocation completed. */
  readonly identity?: ExecutionIdentity;
}

export interface DomainGateResult {
  readonly accepted: boolean;
  readonly evidence: readonly Evidence[];
  readonly reason?: string;
}

export interface BusinessInterpretation {
  readonly status: BusinessStatus;
  readonly evidence: readonly Evidence[];
  readonly reason?: string;
}

export interface PlanChangeRequest {
  readonly planId: PlanId;
  readonly baseRevision: PlanRevision;
  readonly source: string;
  readonly evidenceReferences: readonly string[];
  readonly requestedChanges: readonly string[];
  readonly impactedActionIds: readonly ActionId[];
  readonly rationale: string;
  readonly effectiveAt?: number;
}

export interface PlanChangeProposal extends PlanChangeRequest {
  readonly proposalId: string;
  readonly status: "ADVISORY";
  readonly createdAt: number;
}

export interface RevisionActionState {
  readonly actionId: ActionId;
  readonly lifecycle: ActionLifecycle;
  readonly frozen: boolean;
  readonly hasExternalEffect: boolean;
}

export interface ExecutionIdentity {
  readonly programId: ProgramId;
  readonly planId: PlanId;
  readonly planRevision: PlanRevision;
  readonly actionId: ActionId;
  readonly eventKey: EventKey;
  readonly nfTaskId: NfTaskId;
  readonly runGeneration: number;
  readonly claimFence: number;
}

export interface NfExecutionRequest {
  readonly identity: ExecutionIdentity;
  readonly plan: PlanSnapshot;
  readonly action: ActionDescriptor;
}

export interface Receipt {
  readonly identity: ExecutionIdentity;
  readonly actionType: string;
  readonly nfStatus: NfStatus;
  readonly businessStatus: BusinessStatus;
  readonly evidence: readonly Evidence[];
  readonly output?: unknown;
  readonly recordedAt: number;
  readonly error?: string;
}

export interface ExecutionRecord {
  readonly identity: ExecutionIdentity;
  readonly action: ActionDescriptor;
  readonly lifecycle: ActionLifecycle;
  readonly receipt?: Receipt;
}

export interface PlanSource {
  read(programId: ProgramId, planId: PlanId): Promise<PlanSnapshot>;
}

export interface ActionLedger {
  beginExecution(identity: ExecutionIdentity, action: ActionDescriptor): Promise<{ readonly created: boolean; readonly record: ExecutionRecord }>;
  appendReceipt(receipt: Receipt): Promise<void>;
  replaceReceipt(expectedIdentity: ExecutionIdentity, receipt: Receipt): Promise<void>;
  findByEventKey(eventKey: EventKey): Promise<ExecutionRecord | undefined>;
  findLatestForAction(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<ExecutionRecord | undefined>;
  hasBusinessCompletion(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<boolean>;
}

export interface ClaimAuthority {
  claim(identity: ExecutionIdentity, ownerId: string, now: number): Promise<ExecutionIdentity>;
  assertValid(identity: ExecutionIdentity, now: number): Promise<void>;
  withValidClaim<T>(identity: ExecutionIdentity, operation: () => Promise<T>): Promise<T>;
  release(identity: ExecutionIdentity): Promise<void>;
}

export interface RecoveryAdapter {
  readback(request: NfExecutionRequest): Promise<NfExecutionResult | undefined>;
}

export interface NfActionRuntime {
  execute(request: NfExecutionRequest): Promise<NfExecutionResult>;
}

export interface Profile {
  getActionDescriptors(plan: PlanSnapshot): readonly ActionDescriptor[];
  checkDomainGate(input: {
    readonly plan: PlanSnapshot;
    readonly action: ActionDescriptor;
    readonly result: NfExecutionResult;
  }): DomainGateResult;
  interpretResult(input: {
    readonly plan: PlanSnapshot;
    readonly action: ActionDescriptor;
    readonly result: NfExecutionResult;
    readonly gate: DomainGateResult;
  }): BusinessInterpretation;
  proposePlanChange?(input: PlanChangeRequest): PlanChangeProposal;
}

export interface DispatchRequest {
  readonly programId: ProgramId;
  readonly planId: PlanId;
  /** A stable caller-supplied trigger identity. Repeating it is idempotent. */
  readonly eventKey: EventKey;
  readonly now?: number;
}

export type DispatchResult =
  | {
      readonly status: "DISPATCHED" | "DUPLICATE";
      readonly planRevision: PlanRevision;
      readonly identity: ExecutionIdentity;
      readonly receipt?: Receipt;
      readonly nextAction?: ActionDescriptor;
    }
  | {
      readonly status: "NO_ELIGIBLE_ACTION";
      readonly planRevision: PlanRevision;
      readonly nextAction?: ActionDescriptor;
    };

export type RecoveryResult =
  | {
      readonly status: "RECOVERED";
      readonly planRevision: PlanRevision;
      readonly identity: ExecutionIdentity;
      readonly receipt: Receipt;
      readonly nextAction?: ActionDescriptor;
    }
  | {
      readonly status: "STILL_UNKNOWN";
      readonly planRevision: PlanRevision;
      readonly identity: ExecutionIdentity;
      readonly receipt: Receipt;
    }
  | {
      readonly status: "NOT_RECOVERABLE";
      readonly planRevision: PlanRevision;
      readonly identity: ExecutionIdentity;
      readonly receipt?: Receipt;
    };

export class DpcAdapterError extends Error {
  public readonly code = "ADAPTER_ERROR" as const;

  public constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DpcAdapterError";
  }
}

export class InvalidPlanError extends Error {
  public readonly code = "INVALID_PLAN" as const;

  public constructor(message: string) {
    super(message);
    this.name = "InvalidPlanError";
  }
}

export class ClaimConflictError extends Error {
  public readonly code = "CLAIM_CONFLICT" as const;

  public constructor(message: string) {
    super(message);
    this.name = "ClaimConflictError";
  }
}

export class StaleWriteError extends Error {
  public readonly code = "STALE_WRITE" as const;

  public constructor(message: string) {
    super(message);
    this.name = "StaleWriteError";
  }
}

export class RecoveryError extends Error {
  public readonly code = "RECOVERY_ERROR" as const;

  public constructor(message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}
