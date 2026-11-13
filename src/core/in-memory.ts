import {
  type ActionDescriptor,
  type ActionId,
  type ActionLedger,
  type ClaimAuthority,
  ClaimConflictError,
  type BusinessInterpretation,
  type DomainGateResult,
  type EventKey,
  type ExecutionIdentity,
  type ExecutionRecord,
  type NfActionRuntime,
  type NfExecutionRequest,
  type NfExecutionResult,
  type PlanId,
  type PlanRevision,
  type PlanSnapshot,
  type PlanSource,
  type Profile,
  type ProgramId,
  type Receipt,
  StaleWriteError,
} from "./types.js";

export class InMemoryPlanSource implements PlanSource {
  public readCount = 0;

  public constructor(private plan: PlanSnapshot) {}

  public async read(programId: ProgramId, planId: PlanId): Promise<PlanSnapshot> {
    this.readCount += 1;
    if (programId !== this.plan.programId || planId !== this.plan.planId) {
      throw new Error(`Plan not found: ${programId}/${planId}`);
    }
    return this.plan;
  }

  public setRevision(revision: PlanRevision, profileInput = this.plan.profileInput): void {
    this.plan = { ...this.plan, revision, profileInput };
  }
}

export class InMemoryActionLedger implements ActionLedger {
  private readonly recordsByEvent = new Map<EventKey, ExecutionRecord>();
  private readonly recordsByAction = new Map<string, ExecutionRecord[]>();

  public async beginExecution(
    identity: ExecutionIdentity,
    action: ActionDescriptor,
  ): Promise<{ readonly created: boolean; readonly record: ExecutionRecord }> {
    const existing = this.recordsByEvent.get(identity.eventKey);
    if (existing) {
      return { created: false, record: existing };
    }

    const record: ExecutionRecord = {
      identity,
      action,
      lifecycle: "STARTED",
    };
    this.recordsByEvent.set(identity.eventKey, record);
    const records = this.recordsByAction.get(this.actionKey(identity)) ?? [];
    records.push(record);
    this.recordsByAction.set(this.actionKey(identity), records);
    return { created: true, record };
  }

  public async appendReceipt(receipt: Receipt): Promise<void> {
    const record = this.recordsByEvent.get(receipt.identity.eventKey);
    if (!record) {
      throw new Error(`Execution has not been started: ${receipt.identity.eventKey}`);
    }
    if (record.receipt) {
      throw new Error(`Receipt already exists: ${receipt.identity.eventKey}`);
    }
    if (!this.matchesIdentity(record.identity, receipt.identity)) {
      throw new StaleWriteError(`Receipt identity is stale: ${receipt.identity.eventKey}`);
    }

    const updated: ExecutionRecord = {
      ...record,
      lifecycle: this.lifecycleFor(receipt),
      receipt,
    };
    this.recordsByEvent.set(receipt.identity.eventKey, updated);
    const records = this.recordsByAction.get(this.actionKey(receipt.identity)) ?? [];
    const index = records.findIndex((candidate) => candidate.identity.eventKey === receipt.identity.eventKey);
    if (index >= 0) {
      records[index] = updated;
    }
  }

  public async replaceReceipt(expectedIdentity: ExecutionIdentity, receipt: Receipt): Promise<void> {
    const record = this.recordsByEvent.get(expectedIdentity.eventKey);
    if (!record || !record.receipt || record.receipt.businessStatus !== "UNKNOWN") {
      throw new StaleWriteError(`Execution is not recoverable: ${expectedIdentity.eventKey}`);
    }
    if (!this.matchesIdentity(record.identity, expectedIdentity)) {
      throw new StaleWriteError(`Recovery identity is stale: ${expectedIdentity.eventKey}`);
    }

    const updated: ExecutionRecord = {
      ...record,
      identity: receipt.identity,
      lifecycle: this.lifecycleFor(receipt),
      receipt,
    };
    this.recordsByEvent.set(receipt.identity.eventKey, updated);
    const records = this.recordsByAction.get(this.actionKey(receipt.identity)) ?? [];
    const index = records.findIndex((candidate) => candidate.identity.eventKey === receipt.identity.eventKey);
    if (index >= 0) {
      records[index] = updated;
    }
  }

  public async findByEventKey(eventKey: EventKey): Promise<ExecutionRecord | undefined> {
    return this.recordsByEvent.get(eventKey);
  }

  public async findLatestForAction(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<ExecutionRecord | undefined> {
    const records = this.recordsByAction.get(`${programId}:${planId}:${actionId}`);
    return records?.at(-1);
  }

  public async hasBusinessCompletion(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<boolean> {
    return (await this.findLatestForAction(programId, planId, actionId))?.lifecycle === "COMPLETED";
  }

  public records(): readonly ExecutionRecord[] {
    return [...this.recordsByEvent.values()];
  }

  private actionKey(identity: ExecutionIdentity): string {
    return `${identity.programId}:${identity.planId}:${identity.actionId}`;
  }

  private matchesIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
    return left.programId === right.programId
      && left.planId === right.planId
      && left.planRevision === right.planRevision
      && left.actionId === right.actionId
      && left.eventKey === right.eventKey
      && left.nfTaskId === right.nfTaskId
      && left.runGeneration === right.runGeneration
      && left.claimFence === right.claimFence;
  }

  private lifecycleFor(receipt: Receipt): ExecutionRecord["lifecycle"] {
    switch (receipt.businessStatus) {
      case "COMPLETED":
        return "COMPLETED";
      case "WAIT_EXTERNAL":
        return "WAITING";
      case "FAILED":
        return "FAILED";
      case "UNKNOWN":
        return "UNKNOWN";
      case "CONTINUE":
        return "STARTED";
    }
  }
}

export class NoopClaimAuthority implements ClaimAuthority {
  public async claim(identity: ExecutionIdentity): Promise<ExecutionIdentity> {
    return identity;
  }

  public async assertValid(): Promise<void> {
    // T1 keeps the seam without claiming to enforce distributed ownership.
  }

  public async withValidClaim<T>(_identity: ExecutionIdentity, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  public async release(): Promise<void> {
    // T1 has no external lease to release.
  }
}

export class InMemoryClaimAuthority implements ClaimAuthority {
  private readonly claims = new Map<string, { readonly identity: ExecutionIdentity; readonly ownerId: string; readonly expiresAt: number }>();
  private readonly fences = new Map<string, number>();

  public constructor(private readonly leaseDurationMs = 30_000, private readonly clock = () => Date.now()) {}

  public async claim(identity: ExecutionIdentity, ownerId: string, now: number): Promise<ExecutionIdentity> {
    const current = this.claims.get(this.claimKey(identity));
    if (current && current.expiresAt > now) {
      throw new ClaimConflictError(`Action ${identity.actionId} is claimed by ${current.ownerId}`);
    }

    const fence = (this.fences.get(this.claimKey(identity)) ?? 0) + 1;
    this.fences.set(this.claimKey(identity), fence);
    const claimed = { ...identity, claimFence: fence };
    this.claims.set(this.claimKey(identity), {
      identity: claimed,
      ownerId,
      expiresAt: now + this.leaseDurationMs,
    });
    return claimed;
  }

  public async assertValid(identity: ExecutionIdentity, now: number): Promise<void> {
    const current = this.claims.get(this.claimKey(identity));
    if (!current || current.expiresAt <= now || !this.matchesIdentity(current.identity, identity)) {
      throw new StaleWriteError(`Claim fence is stale for ${identity.actionId}`);
    }
  }

  public async withValidClaim<T>(identity: ExecutionIdentity, operation: () => Promise<T>): Promise<T> {
    await this.assertValid(identity, this.clock());
    const result = await operation();
    await this.assertValid(identity, this.clock());
    return result;
  }

  public async release(identity: ExecutionIdentity): Promise<void> {
    const current = this.claims.get(this.claimKey(identity));
    if (current && current.identity.claimFence === identity.claimFence) {
      this.claims.delete(this.claimKey(identity));
    }
  }

  private claimKey(identity: ExecutionIdentity): string {
    return `${identity.programId}:${identity.planId}:${identity.actionId}`;
  }

  private matchesIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
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

export class InMemoryProfile implements Profile {
  public constructor(
    private readonly descriptors: readonly ActionDescriptor[],
    private readonly gate: (input: Parameters<Profile["checkDomainGate"]>[0]) => DomainGateResult = () => ({
      accepted: true,
      evidence: [],
    }),
    private readonly interpreter: (input: Parameters<Profile["interpretResult"]>[0]) => BusinessInterpretation = ({ result }) => ({
      status: result.status === "DONE" ? "COMPLETED" : result.status,
      evidence: [],
    }),
  ) {}

  public getActionDescriptors(_plan: PlanSnapshot): readonly ActionDescriptor[] {
    return this.descriptors;
  }

  public checkDomainGate(input: Parameters<Profile["checkDomainGate"]>[0]): DomainGateResult {
    return this.gate(input);
  }

  public interpretResult(input: Parameters<Profile["interpretResult"]>[0]): BusinessInterpretation {
    return this.interpreter(input);
  }
}

export class InMemoryNfRuntime implements NfActionRuntime {
  public readonly requests: ExecutionIdentity[] = [];

  public constructor(
    private readonly response: NfExecutionResult | ((request: NfExecutionRequest) => NfExecutionResult | Promise<NfExecutionResult>),
  ) {}

  public async execute(request: NfExecutionRequest): Promise<NfExecutionResult> {
    this.requests.push(request.identity);
    return typeof this.response === "function" ? this.response(request) : this.response;
  }
}
