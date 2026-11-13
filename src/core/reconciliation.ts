import type { ActionId, EventKey, PlanId, PlanRevision, ProgramId } from "./types.js";

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

export interface ReconciliationStore {
  listReconciliationCandidates(now: number): Promise<readonly ReconciliationCandidate[]>;
}

/**
 * Thin coordinator seam: persistence discovers candidates; the caller decides
 * which durable RECOVERY wake to schedule. It never retries an external action.
 */
export class ReconciliationRunner {
  public constructor(private readonly store: ReconciliationStore) {}

  public scan(now = Date.now()): Promise<readonly ReconciliationCandidate[]> {
    return this.store.listReconciliationCandidates(now);
  }
}
