import type { DurableExecutionStore, ReconciliationCandidate } from "./types.js";

/**
 * Thin coordinator seam: persistence discovers candidates; the caller decides
 * which durable RECOVERY wake to schedule. It never retries an external action.
 */
export class ReconciliationRunner {
  public constructor(private readonly store: DurableExecutionStore) {}

  public scan(now = Date.now()): Promise<readonly ReconciliationCandidate[]> {
    return this.store.listReconciliationCandidates(now);
  }
}
