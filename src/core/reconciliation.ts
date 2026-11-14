import type { ReconciliationCandidate, ReconciliationReader } from "./types.js";

/**
 * Thin coordinator seam: persistence discovers candidates; the caller decides
 * which durable RECOVERY wake to schedule. It never retries an external action.
 */
export class ReconciliationRunner {
  public constructor(private readonly store: ReconciliationReader) {}

  public scan(now = Date.now()): Promise<readonly ReconciliationCandidate[]> {
    return this.store.listReconciliationCandidates(now);
  }
}
