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

/**
 * A fenced execution capability returned by an ExecutionStore.
 * The stable identity remains the value persisted in requests and receipts;
 * the lease only makes ownership explicit at the Core-facing seam.
 */
export interface ExecutionLease {
  readonly identity: ExecutionIdentity;
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

export interface OutboxEvent {
  readonly outboxId: string;
  readonly dedupeKey: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly status: string;
  readonly attempts: number;
}

export interface PlanSource {
  read(programId: ProgramId, planId: PlanId): Promise<PlanSnapshot>;
}

export interface ActionLedger {
  beginExecution(identity: ExecutionIdentity, action: ActionDescriptor): Promise<{ readonly created: boolean; readonly record: ExecutionRecord }>;
  /**
   * Implementations must validate the claim and mutate the receipt in one
   * compare-and-write transaction. The in-memory adapter performs both steps
   * without an intervening await; durable adapters must use their storage CAS
   * or transaction equivalent.
   */
  appendReceiptWithClaim(receipt: Receipt, claims: ClaimAuthority, now: number): Promise<void>;
  replaceReceiptWithClaim(
    expectedIdentity: ExecutionIdentity,
    receipt: Receipt,
    claims: ClaimAuthority,
    now: number,
  ): Promise<void>;
  findByEventKey(programId: ProgramId, planId: PlanId, eventKey: EventKey): Promise<ExecutionRecord | undefined>;
  findLatestForAction(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<ExecutionRecord | undefined>;
  hasBusinessCompletion(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<boolean>;
}

export interface ClaimAuthority {
  claim(identity: ExecutionIdentity, ownerId: string, now: number): Promise<ExecutionIdentity>;
  assertValid(identity: ExecutionIdentity, now: number): Promise<void>;
  withValidClaim<T>(identity: ExecutionIdentity, operation: () => Promise<T>): Promise<T>;
  release(identity: ExecutionIdentity): Promise<void>;
}

/**
 * Core-facing execution seam. The store owns the claim authority used by its
 * receipt writes; callers never provide a sibling ClaimAuthority instance.
 */
export interface ExecutionStore {
  acquire(identity: ExecutionIdentity, ownerId: string, now: number): Promise<ExecutionLease>;
  startExecution(
    lease: ExecutionLease,
    action: ActionDescriptor,
  ): Promise<{ readonly created: boolean; readonly record: ExecutionRecord }>;
  withValidLease<T>(lease: ExecutionLease, operation: () => Promise<T>): Promise<T>;
  appendReceipt(lease: ExecutionLease, receipt: Receipt, now: number): Promise<void>;
  replaceUnknownReceipt(
    lease: ExecutionLease,
    expectedIdentity: ExecutionIdentity,
    receipt: Receipt,
    now: number,
  ): Promise<void>;
  releaseExecution(lease: ExecutionLease): Promise<void>;
  findByEventKey(programId: ProgramId, planId: PlanId, eventKey: EventKey): Promise<ExecutionRecord | undefined>;
  findLatestForAction(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<ExecutionRecord | undefined>;
  hasBusinessCompletion(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<boolean>;
  /**
   * Return the same latest-per-action view as findLatestForAction, but for one
   * selection read. Missing actions are omitted from the returned map.
   */
  findLatestForActions(
    programId: ProgramId,
    planId: PlanId,
    actionIds: readonly ActionId[],
  ): Promise<ReadonlyMap<ActionId, ExecutionRecord>>;
}

export interface ReceiptHistoryReader {
  listReceipts(
    programId: ProgramId,
    planId: PlanId,
    eventKey: EventKey,
  ): Promise<readonly Receipt[]>;
}

export interface OutboxReader {
  pendingOutbox(): Promise<readonly OutboxEvent[]>;
}

export interface ReconciliationReader {
  listReconciliationCandidates(now: number): Promise<readonly ReconciliationCandidate[]>;
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

export interface RecoveryRequest {
  readonly programId: ProgramId;
  readonly planId: PlanId;
  readonly eventKey: EventKey;
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

export type ReconciliationKind = "UNKNOWN_RECEIPT" | "STARTED_WITHOUT_RECEIPT" | "EXPIRED_CLAIM";

export interface ReconciliationCandidate {
  readonly executionId: string;
  readonly programId: ProgramId;
  readonly planId: PlanId;
  readonly planRevision: PlanRevision;
  readonly actionId: ActionId;
  readonly eventKey: EventKey;
  readonly kind: ReconciliationKind;
  readonly observedAt: number;
}

/**
 * Combined durable execution store. Core consumes the smaller ExecutionStore
 * seam; this aggregate also exposes operational readers and legacy ledger/claim
 * methods so existing adapters and tests can migrate without a flag day.
 *
 * The implementation hides action execution rows, append-only receipts, claims,
 * fences, leases, transaction boundaries, outbox insertion and reconciliation
 * queries behind one durable Adapter.
 *
 * ## Transaction semantics
 * `startExecution` is idempotent for the scoped execution identity. The
 * Core-facing receipt methods validate their supplied lease and persist the
 * receipt, lifecycle, outbox event and claim release atomically.
 *
 * The legacy `ActionLedger` methods remain available for compatibility. New
 * Core code must use `ExecutionStore.appendReceipt` and
 * `ExecutionStore.replaceUnknownReceipt`, which do not accept a sibling claim
 * authority.
 *
 * ## Ordering
 * Receipts are append-only within an execution lifecycle. The Core-facing
 * `appendReceipt` rejects a write if a receipt already exists
 * (`StaleWriteError`). `replaceUnknownReceipt` rejects if there is no prior
 * UNKNOWN receipt.
 *
 * ## Error semantics
 * - `ClaimConflictError`: a valid unexpired claim already exists for a different
 *   owner; the caller must back off and retry after the lease expires.
 * - `StaleWriteError`: the claim fence, event key or run generation on the
 *   provided identity no longer matches the stored claim, or the execution row is
 *   not in the expected state.
 * - `DpcAdapterError`: a lower-level storage failure that the caller cannot
 *   recover from without human intervention.
 *
 * ## Performance
 * Implementations are expected to be network-bound. Callers must not hold any
 * application-level lock while awaiting these methods. The store itself is
 * responsible for serialising concurrent writers via its own row-level locking or
 * CAS mechanism.
 *
 * ## migrate()
 * Must be safe to call more than once (versioned, repeat-safe). Calling it on an
 * already-migrated schema MUST succeed without modifying existing data.
 */
export interface DurableExecutionStore extends ActionLedger, ClaimAuthority, ExecutionStore, ReceiptHistoryReader, OutboxReader, ReconciliationReader {
  /**
   * Apply (or verify) the versioned schema migration.
   * Safe to call on every startup — idempotent, never destructive.
   */
  migrate(): Promise<void>;

  /** Return every receipt retained for one execution, oldest first. */
  listReceipts(
    programId: ProgramId,
    planId: PlanId,
    eventKey: EventKey,
  ): Promise<readonly Receipt[]>;

  /** Return committed coordination notifications that have not been delivered. */
  pendingOutbox(): Promise<readonly OutboxEvent[]>;

  /**
   * List reconciliation candidates: UNKNOWN receipts, STARTED executions without
   * receipts, and expired claims. This is a read-only discovery operation that
   * never invokes an external action.
   */
  listReconciliationCandidates(now: number): Promise<readonly ReconciliationCandidate[]>;
}

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
