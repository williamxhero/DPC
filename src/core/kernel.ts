import {
  type ActionDescriptor,
  type ActionId,
  type ActionLedger,
  type BusinessInterpretation,
  type ClaimAuthority,
  type ExecutionIdentity,
  type ExecutionLease,
  type ExecutionRecord,
  type ExecutionStore,
  type DispatchRequest,
  type DispatchResult,
  DpcAdapterError,
  InvalidPlanError,
  type NfActionRuntime,
  type NfExecutionResult,
  type NfTaskId,
  type PlanSnapshot,
  type PlanSource,
  type Profile,
  type Receipt,
  RecoveryError,
  type RecoveryRequest,
  type RecoveryResult,
  StaleWriteError,
} from "./types.js";

const INITIAL_RUN_GENERATION = 1;
const PROVISIONAL_CLAIM_FENCE = 0;

interface DpcCoreCommonDependencies {
  readonly plans: PlanSource;
  readonly nf: NfActionRuntime;
  readonly profile: Profile;
  readonly recovery?: import("./types.js").RecoveryAdapter;
  readonly ownerId?: string;
  readonly clock?: () => number;
}

export type DpcCoreDependencies = DpcCoreCommonDependencies & (
  | {
      /** Preferred durable path: one store owns claims and atomic receipt writes. */
      readonly store: ExecutionStore;
      readonly ledger?: never;
      readonly claims?: never;
    }
  | {
      /** Legacy T1/T2 path retained for non-durable adapters. */
      readonly ledger: ActionLedger;
      readonly claims: ClaimAuthority;
      readonly store?: never;
    }
);

class LegacyExecutionStoreAdapter implements ExecutionStore {
  public constructor(
    private readonly ledger: ActionLedger,
    private readonly claims: ClaimAuthority,
  ) {}

  public async acquire(
    identity: ExecutionIdentity,
    ownerId: string,
    now: number,
  ): Promise<ExecutionLease> {
    return { identity: await this.claims.claim(identity, ownerId, now) };
  }

  public startExecution(
    lease: ExecutionLease,
    action: ActionDescriptor,
  ): Promise<{ readonly created: boolean; readonly record: ExecutionRecord }> {
    return this.claims.withValidClaim(
      lease.identity,
      () => this.ledger.beginExecution(lease.identity, action),
    );
  }

  public withValidLease<T>(lease: ExecutionLease, operation: () => Promise<T>): Promise<T> {
    return this.claims.withValidClaim(lease.identity, operation);
  }

  public appendReceipt(lease: ExecutionLease, receipt: Receipt, now: number): Promise<void> {
    this.assertLeaseIdentity(lease, receipt.identity);
    return this.ledger.appendReceiptWithClaim(receipt, this.claims, now);
  }

  public replaceUnknownReceipt(
    lease: ExecutionLease,
    expectedIdentity: ExecutionIdentity,
    receipt: Receipt,
    now: number,
  ): Promise<void> {
    this.assertLeaseStableIdentity(lease, expectedIdentity);
    this.assertLeaseIdentity(lease, receipt.identity);
    return this.ledger.replaceReceiptWithClaim(expectedIdentity, receipt, this.claims, now);
  }

  public releaseExecution(lease: ExecutionLease): Promise<void> {
    return this.claims.release(lease.identity);
  }

  public findByEventKey(
    programId: ExecutionIdentity["programId"],
    planId: ExecutionIdentity["planId"],
    eventKey: ExecutionIdentity["eventKey"],
  ): Promise<ExecutionRecord | undefined> {
    return this.ledger.findByEventKey(programId, planId, eventKey);
  }

  public findLatestForAction(
    programId: ExecutionIdentity["programId"],
    planId: ExecutionIdentity["planId"],
    actionId: ActionId,
  ): Promise<ExecutionRecord | undefined> {
    return this.ledger.findLatestForAction(programId, planId, actionId);
  }

  public hasBusinessCompletion(
    programId: ExecutionIdentity["programId"],
    planId: ExecutionIdentity["planId"],
    actionId: ActionId,
  ): Promise<boolean> {
    return this.ledger.hasBusinessCompletion(programId, planId, actionId);
  }

  private assertLeaseIdentity(lease: ExecutionLease, identity: ExecutionIdentity): void {
    if (!this.sameIdentity(lease.identity, identity)) {
      throw new StaleWriteError(`Execution lease is stale: ${identity.eventKey}`);
    }
  }

  private assertLeaseStableIdentity(lease: ExecutionLease, identity: ExecutionIdentity): void {
    if (!this.sameStableIdentity(lease.identity, identity)) {
      throw new StaleWriteError(`Execution lease is stale: ${identity.eventKey}`);
    }
  }

  private sameStableIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
    return left.programId === right.programId
      && left.planId === right.planId
      && left.planRevision === right.planRevision
      && left.actionId === right.actionId
      && left.eventKey === right.eventKey
      && left.nfTaskId === right.nfTaskId
      && left.runGeneration === right.runGeneration;
  }

  private sameIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
    return left.programId === right.programId
      && left.planId === right.planId
      && left.planRevision === right.planRevision
      && left.actionId === right.actionId
      && left.eventKey === right.eventKey
      && left.nfTaskId === right.nfTaskId
      && left.runGeneration === right.runGeneration
      && left.claimFence === right.claimFence;
  }
}

/**
 * The DPC module. One dispatch advances one action occurrence and returns the
 * next action without exposing storage or lifecycle internals.
 */
export class DpcCore {
  private readonly clock: () => number;
  private readonly executionStore: ExecutionStore;
  private readonly ownerId: string;

  public constructor(private readonly dependencies: DpcCoreDependencies) {
    this.clock = dependencies.clock ?? (() => Date.now());
    this.executionStore = dependencies.store
      ?? new LegacyExecutionStoreAdapter(dependencies.ledger, dependencies.claims);
    this.ownerId = dependencies.ownerId ?? "dpc-core";
  }

  public async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const plan = await this.readPlan(request.programId, request.planId);
    const descriptors = this.readDescriptors(plan);
    this.validateDescriptors(descriptors);

    const duplicate = await this.executionStore.findByEventKey(
      request.programId,
      request.planId,
      request.eventKey,
    );
    if (duplicate) {
      return this.duplicateResult(duplicate, plan, descriptors, request.now ?? this.clock());
    }

    const action = await this.selectAction(plan, descriptors, request.now ?? this.clock());
    if (!action) {
      return { status: "NO_ELIGIBLE_ACTION", planRevision: plan.revision };
    }

    const previous = await this.executionStore.findLatestForAction(plan.programId, plan.planId, action.actionId);
    const identity = this.createIdentity(
      request,
      plan,
      action,
      previous?.identity.runGeneration ?? INITIAL_RUN_GENERATION - 1,
    );
    const claimed = await this.claim(identity, request.now ?? this.clock());
    let started;
    try {
      started = await this.executionStore.startExecution(claimed, action);
    } catch (error) {
      await this.release(claimed);
      throw new DpcAdapterError(`Failed to begin execution for ${action.actionId}`, error);
    }
    if (!started.created) {
      await this.release(claimed);
      return this.duplicateResult(started.record, plan, descriptors, request.now ?? this.clock());
    }

    let released = false;
    try {
      const result = await this.execute(claimed, plan, action);
      this.validateReturnedIdentity(claimed.identity, result);
      const receipt = await this.recordResult(claimed, plan, action, result);
      await this.release(claimed);
      released = true;

      // This read is deliberately after receipt writeback: future selection must
      // use the current revision rather than the context that started the action.
      const currentPlan = await this.readPlan(request.programId, request.planId);
      const currentDescriptors = this.readDescriptors(currentPlan);
      this.validateDescriptors(currentDescriptors);
      const nextAction = await this.selectAction(
        currentPlan,
        currentDescriptors,
        request.now ?? this.clock(),
      );

      return {
        status: "DISPATCHED",
        planRevision: currentPlan.revision,
        identity: claimed.identity,
        receipt,
        nextAction,
      };
    } catch (error) {
      if (error instanceof DpcAdapterError || error instanceof StaleWriteError) {
        if (!released) {
          await this.release(claimed);
        }
        throw error;
      }
      if (!released) {
        await this.release(claimed);
      }
      throw new DpcAdapterError(`Action ${action.actionId} failed`, error);
    }
  }

  /**
   * Resolve an UNKNOWN receipt by readback only. This method never invokes the
   * NF execute seam, so callers cannot accidentally repeat a side effect.
   */
  public async recover(request: RecoveryRequest): Promise<RecoveryResult> {
    const record = await this.executionStore.findByEventKey(
      request.programId,
      request.planId,
      request.eventKey,
    );
    if (!record) {
      throw new RecoveryError(`No execution exists for ${request.eventKey}`);
    }
    const plan = await this.readPlan(request.programId, request.planId);
    if (!record.receipt || record.receipt.businessStatus !== "UNKNOWN") {
      return {
        status: "NOT_RECOVERABLE",
        planRevision: plan.revision,
        identity: record.identity,
        receipt: record.receipt,
      };
    }
    if (!this.dependencies.recovery) {
      throw new RecoveryError("No readback adapter is configured");
    }

    const claimed = await this.claim(record.identity, this.clock());
    let released = false;
    try {
      const result = await this.dependencies.recovery.readback({
        identity: claimed.identity,
        plan,
        action: record.action,
      });
      if (!result) {
        await this.release(claimed);
        released = true;
        return {
          status: "STILL_UNKNOWN",
          planRevision: plan.revision,
          identity: record.identity,
          receipt: record.receipt,
        };
      }
      this.validateReturnedIdentity(claimed.identity, result);
      const receipt = await this.executionStore.withValidLease(claimed, async () => {
        const gate = this.checkGate(plan, record.action, result);
        const interpretation = this.interpret(plan, record.action, result, gate);
        return this.createReceipt(claimed.identity, record.action, result, interpretation);
      });
      await this.executionStore.replaceUnknownReceipt(
        claimed,
        record.identity,
        receipt,
        this.clock(),
      );
      await this.release(claimed);
      released = true;

      const currentPlan = await this.readPlan(request.programId, request.planId);
      if (receipt.businessStatus === "UNKNOWN") {
        return {
          status: "STILL_UNKNOWN",
          planRevision: currentPlan.revision,
          identity: claimed.identity,
          receipt,
        };
      }
      const descriptors = this.readDescriptors(currentPlan);
      this.validateDescriptors(descriptors);
      return {
        status: "RECOVERED",
        planRevision: currentPlan.revision,
        identity: claimed.identity,
        receipt,
        nextAction: await this.selectAction(currentPlan, descriptors, this.clock()),
      };
    } catch (error) {
      if (!released) {
        await this.release(claimed);
      }
      if (error instanceof RecoveryError || error instanceof StaleWriteError || error instanceof DpcAdapterError) {
        throw error;
      }
      throw new DpcAdapterError(`Recovery failed for ${request.eventKey}`, error);
    }
  }

  private async readPlan(programId: ExecutionIdentity["programId"], planId: ExecutionIdentity["planId"]): Promise<PlanSnapshot> {
    try {
      return await this.dependencies.plans.read(programId, planId);
    } catch (error) {
      throw new DpcAdapterError("Failed to read the current plan", error);
    }
  }

  private readDescriptors(plan: PlanSnapshot): readonly ActionDescriptor[] {
    try {
      return this.dependencies.profile.getActionDescriptors(plan);
    } catch (error) {
      throw new DpcAdapterError("Failed to read action descriptors from the profile", error);
    }
  }

  private validateDescriptors(descriptors: readonly ActionDescriptor[]): void {
    const ids = new Set<ActionId>();
    for (const descriptor of descriptors) {
      if (ids.has(descriptor.actionId)) {
        throw new InvalidPlanError(`Duplicate action id: ${descriptor.actionId}`);
      }
      ids.add(descriptor.actionId);
    }
    for (const descriptor of descriptors) {
      for (const dependency of descriptor.dependencies) {
        if (!ids.has(dependency)) {
          throw new InvalidPlanError(
            `Action ${descriptor.actionId} depends on unknown action ${dependency}`,
          );
        }
      }
    }
  }

  private async selectAction(
    plan: PlanSnapshot,
    descriptors: readonly ActionDescriptor[],
    now: number,
  ): Promise<ActionDescriptor | undefined> {
    for (const action of descriptors) {
      const record = await this.executionStore.findLatestForAction(plan.programId, plan.planId, action.actionId);
      if (record && this.isBlockedByRecord(record)) {
        continue;
      }
      if (action.timeWindow?.notBefore !== undefined && now < action.timeWindow.notBefore) {
        continue;
      }
      if (action.timeWindow?.expiresAt !== undefined && now > action.timeWindow.expiresAt) {
        continue;
      }

      let dependenciesComplete = true;
      for (const dependency of action.dependencies) {
        if (!(await this.executionStore.hasBusinessCompletion(plan.programId, plan.planId, dependency))) {
          dependenciesComplete = false;
          break;
        }
      }
      if (!dependenciesComplete) {
        continue;
      }

      try {
        const gate = this.dependencies.profile.checkDomainGate({
          plan,
          action,
          result: { status: "CONTINUE", evidence: [] },
        });
        if (!gate.accepted) {
          continue;
        }
      } catch (error) {
        throw new DpcAdapterError(`Failed to evaluate domain gate for ${action.actionId}`, error);
      }
      return action;
    }
    return undefined;
  }

  private isBlockedByRecord(record: ExecutionRecord): boolean {
    if (record.lifecycle === "STARTED") {
      return !record.receipt;
    }
    return record.lifecycle === "COMPLETED"
      || record.lifecycle === "WAITING"
      || record.lifecycle === "FAILED"
      || record.lifecycle === "UNKNOWN";
  }

  private createIdentity(
    request: DispatchRequest,
    plan: PlanSnapshot,
    action: ActionDescriptor,
    previousGeneration: number,
  ): ExecutionIdentity {
    const nfTaskId = `nf:${request.eventKey}:${action.actionId}` as NfTaskId;
    return {
      programId: request.programId,
      planId: request.planId,
      planRevision: plan.revision,
      actionId: action.actionId,
      eventKey: request.eventKey,
      nfTaskId,
      runGeneration: previousGeneration + 1,
      claimFence: PROVISIONAL_CLAIM_FENCE,
    };
  }

  private async claim(identity: ExecutionIdentity, now: number): Promise<ExecutionLease> {
    return this.executionStore.acquire(identity, this.ownerId, now);
  }

  private async release(lease: ExecutionLease): Promise<void> {
    await this.executionStore.releaseExecution(lease);
  }

  private async execute(
    lease: ExecutionLease,
    plan: PlanSnapshot,
    action: ActionDescriptor,
  ): Promise<NfExecutionResult> {
    const identity = lease.identity;
    try {
      return await this.dependencies.nf.execute({ identity, plan, action });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown NF adapter error";
      const failed: NfExecutionResult = { status: "FAILED", evidence: [], error: message };
      try {
        const failureReceipt = await this.executionStore.withValidLease(lease, async () => {
          const gate = this.checkGate(plan, action, failed);
          const interpretation = this.interpret(plan, action, failed, gate);
          return this.createReceipt(identity, action, failed, interpretation);
        });
        await this.executionStore.appendReceipt(lease, failureReceipt, this.clock());
      } catch (recordingError) {
        throw new DpcAdapterError("NF adapter failed and failure receipt could not be recorded", recordingError);
      }
      throw new DpcAdapterError(`NF adapter failed for ${action.actionId}`, error);
    }
  }

  private validateReturnedIdentity(expected: ExecutionIdentity, result: NfExecutionResult): void {
    if (!result.identity) {
      return;
    }
    if (!this.sameIdentity(expected, result.identity)) {
      throw new StaleWriteError(`NF result identity is stale for ${expected.actionId}`);
    }
  }

  private async recordResult(
    lease: ExecutionLease,
    plan: PlanSnapshot,
    action: ActionDescriptor,
    result: NfExecutionResult,
  ): Promise<Receipt> {
    const receipt = await this.executionStore.withValidLease(lease, async () => {
      const gate = this.checkGate(plan, action, result);
      const interpretation = this.interpret(plan, action, result, gate);
      return this.createReceipt(lease.identity, action, result, interpretation);
    });
    try {
      await this.executionStore.appendReceipt(lease, receipt, this.clock());
    } catch (error) {
      if (error instanceof StaleWriteError) throw error;
      throw new DpcAdapterError("Failed to write the action receipt", error);
    }
    return receipt;
  }

  private checkGate(plan: PlanSnapshot, action: ActionDescriptor, result: NfExecutionResult) {
    try {
      return this.dependencies.profile.checkDomainGate({ plan, action, result });
    } catch (error) {
      throw new DpcAdapterError(`Failed to evaluate domain gate for ${action.actionId}`, error);
    }
  }

  private interpret(
    plan: PlanSnapshot,
    action: ActionDescriptor,
    result: NfExecutionResult,
    gate: ReturnType<Profile["checkDomainGate"]>,
  ): BusinessInterpretation {
    try {
      const interpretation = this.dependencies.profile.interpretResult({ plan, action, result, gate });
      if (result.status === "UNKNOWN" && interpretation.status !== "UNKNOWN") {
        return {
          ...interpretation,
          status: "UNKNOWN",
          reason: "NF returned an unknown external outcome; recovery/readback is required",
        };
      }
      return interpretation;
    } catch (error) {
      throw new DpcAdapterError(`Failed to interpret NF result for ${action.actionId}`, error);
    }
  }

  private createReceipt(
    identity: ExecutionIdentity,
    action: ActionDescriptor,
    result: NfExecutionResult,
    interpretation: BusinessInterpretation,
  ): Receipt {
    return {
      identity,
      actionType: action.actionType,
      nfStatus: result.status,
      businessStatus: interpretation.status,
      evidence: [...result.evidence, ...interpretation.evidence],
      output: result.output,
      recordedAt: this.clock(),
      error: result.error ?? interpretation.reason,
    };
  }

  private async duplicateResult(
    record: ExecutionRecord,
    plan: PlanSnapshot,
    descriptors: readonly ActionDescriptor[],
    now: number,
  ): Promise<DispatchResult> {
    return {
      status: "DUPLICATE",
      planRevision: plan.revision,
      identity: record.identity,
      receipt: record.receipt,
      nextAction: await this.selectAction(plan, descriptors, now),
    };
  }

  private sameIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
    return left.programId === right.programId
      && left.planId === right.planId
      && left.planRevision === right.planRevision
      && left.actionId === right.actionId
      && left.eventKey === right.eventKey
      && left.nfTaskId === right.nfTaskId
      && left.runGeneration === right.runGeneration
      && left.claimFence === right.claimFence;
  }
}
