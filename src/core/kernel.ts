import {
  type ActionDescriptor,
  type ActionId,
  type ActionLedger,
  type BusinessInterpretation,
  type ClaimAuthority,
  type DispatchRequest,
  type DispatchResult,
  DpcAdapterError,
  InvalidPlanError,
  type ExecutionIdentity,
  type ExecutionRecord,
  type NfActionRuntime,
  type NfExecutionResult,
  type NfTaskId,
  type PlanSnapshot,
  type PlanSource,
  type Profile,
  type Receipt,
  RecoveryError,
  type RecoveryResult,
  StaleWriteError,
} from "./types.js";

const INITIAL_RUN_GENERATION = 1;
const PROVISIONAL_CLAIM_FENCE = 0;

export interface DpcCoreDependencies {
  readonly plans: PlanSource;
  readonly ledger: ActionLedger;
  readonly nf: NfActionRuntime;
  readonly profile: Profile;
  readonly claims: ClaimAuthority;
  readonly recovery?: import("./types.js").RecoveryAdapter;
  readonly ownerId?: string;
  readonly clock?: () => number;
}

/**
 * The DPC module. One dispatch advances one action occurrence and returns the
 * next action without exposing storage or lifecycle internals.
 */
export class DpcCore {
  private readonly clock: () => number;
  private readonly claims: ClaimAuthority;
  private readonly ownerId: string;

  public constructor(private readonly dependencies: DpcCoreDependencies) {
    this.clock = dependencies.clock ?? (() => Date.now());
    this.claims = dependencies.claims;
    this.ownerId = dependencies.ownerId ?? "dpc-core";
  }

  public async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const plan = await this.readPlan(request.programId, request.planId);
    const descriptors = this.readDescriptors(plan);
    this.validateDescriptors(descriptors);

    const duplicate = await this.dependencies.ledger.findByEventKey(request.eventKey);
    if (duplicate) {
      return this.duplicateResult(duplicate, plan, descriptors, request.now ?? this.clock());
    }

    const action = await this.selectAction(plan, descriptors, request.now ?? this.clock());
    if (!action) {
      return { status: "NO_ELIGIBLE_ACTION", planRevision: plan.revision };
    }

    const previous = await this.dependencies.ledger.findLatestForAction(plan.programId, plan.planId, action.actionId);
    const identity = this.createIdentity(
      request,
      plan,
      action,
      previous?.identity.runGeneration ?? INITIAL_RUN_GENERATION - 1,
    );
    const claimed = await this.claim(identity, request.now ?? this.clock());
    const started = await this.dependencies.ledger.beginExecution(claimed, action);
    if (!started.created) {
      await this.release(claimed);
      return this.duplicateResult(started.record, plan, descriptors, request.now ?? this.clock());
    }

    let released = false;
    try {
      const result = await this.execute(claimed, plan, action);
      this.validateReturnedIdentity(claimed, result);
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
        identity: claimed,
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
  public async recover(eventKey: import("./types.js").EventKey): Promise<RecoveryResult> {
    const record = await this.dependencies.ledger.findByEventKey(eventKey);
    if (!record) {
      throw new RecoveryError(`No execution exists for ${eventKey}`);
    }
    const plan = await this.readPlan(record.identity.programId, record.identity.planId);
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
        identity: claimed,
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
      this.validateReturnedIdentity(claimed, result);
      const receipt = await this.claims.withValidClaim(claimed, async () => {
        const gate = this.checkGate(plan, record.action, result);
        const interpretation = this.interpret(plan, record.action, result, gate);
        const nextReceipt = this.createReceipt(claimed, record.action, result, interpretation);
        await this.dependencies.ledger.replaceReceipt(record.identity, nextReceipt);
        return nextReceipt;
      });
      await this.release(claimed);
      released = true;

      if (receipt.businessStatus === "UNKNOWN") {
        return {
          status: "STILL_UNKNOWN",
          planRevision: plan.revision,
          identity: claimed,
          receipt,
        };
      }
      const descriptors = this.readDescriptors(plan);
      this.validateDescriptors(descriptors);
      return {
        status: "RECOVERED",
        planRevision: plan.revision,
        identity: claimed,
        receipt,
        nextAction: await this.selectAction(plan, descriptors, this.clock()),
      };
    } catch (error) {
      if (!released) {
        await this.release(claimed);
      }
      if (error instanceof RecoveryError || error instanceof StaleWriteError || error instanceof DpcAdapterError) {
        throw error;
      }
      throw new DpcAdapterError(`Recovery failed for ${eventKey}`, error);
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
      const record = await this.dependencies.ledger.findLatestForAction(plan.programId, plan.planId, action.actionId);
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
        if (!(await this.dependencies.ledger.hasBusinessCompletion(plan.programId, plan.planId, dependency))) {
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

  private async claim(identity: ExecutionIdentity, now: number): Promise<ExecutionIdentity> {
    return this.claims.claim(identity, this.ownerId, now);
  }

  private async release(identity: ExecutionIdentity): Promise<void> {
    await this.claims.release(identity);
  }

  private async execute(
    identity: ExecutionIdentity,
    plan: PlanSnapshot,
    action: ActionDescriptor,
  ): Promise<NfExecutionResult> {
    try {
      return await this.dependencies.nf.execute({ identity, plan, action });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown NF adapter error";
      const failed: NfExecutionResult = { status: "FAILED", evidence: [], error: message };
      try {
        await this.claims.withValidClaim(identity, async () => {
          const gate = this.checkGate(plan, action, failed);
          const interpretation = this.interpret(plan, action, failed, gate);
          await this.dependencies.ledger.appendReceipt(this.createReceipt(identity, action, failed, interpretation));
        });
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
    identity: ExecutionIdentity,
    plan: PlanSnapshot,
    action: ActionDescriptor,
    result: NfExecutionResult,
  ): Promise<Receipt> {
    return this.claims.withValidClaim(identity, async () => {
      const gate = this.checkGate(plan, action, result);
      const interpretation = this.interpret(plan, action, result, gate);
      const receipt = this.createReceipt(identity, action, result, interpretation);
      try {
        await this.dependencies.ledger.appendReceipt(receipt);
      } catch (error) {
        throw new DpcAdapterError("Failed to write the action receipt", error);
      }
      return receipt;
    });
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
