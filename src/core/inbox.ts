import { StaleWriteError } from "./types.js";

export type InboxEventStatus = "RECEIVED" | "PROCESSED";

export interface InboxOccurrence {
  readonly provider: string;
  readonly externalEventId: string;
  readonly eventType: string;
  /**
   * The payload stored at receipt time. Never contains provider tokens,
   * credentials, private transcripts or absolute temporary paths — callers
   * are responsible for stripping sensitive fields before calling putOrIgnore.
   */
  readonly payload: unknown;
  readonly status: InboxEventStatus;
  readonly receivedAt: number;
  readonly processedAt?: number;
}

/**
 * Durable external occurrence-ID inbox.
 *
 * An inbox row records that an external system delivered an event identified by
 * (provider, externalEventId). The row is NOT a business fact until
 * markProcessed() is called inside the same execution transaction that creates
 * the business receipt. Callers must coordinate this atomicity; the store
 * interface does not enforce it on its own.
 *
 * ## Idempotency
 * putOrIgnore is idempotent: a repeated call for the same (provider,
 * externalEventId) returns the existing occurrence with created = false and
 * never modifies the stored payload or status.
 *
 * ## Security
 * Never store provider tokens, credentials, private transcripts or absolute
 * temporary paths in the payload field. Strip them before calling putOrIgnore.
 */
export interface InboxStore {
  /**
   * Record an external occurrence by (provider, externalEventId).
   * Idempotent — repeated calls return { created: false, occurrence: <existing> }.
   */
  putOrIgnore(
    provider: string,
    externalEventId: string,
    eventType: string,
    payload: unknown,
  ): Promise<{ readonly created: boolean; readonly occurrence: InboxOccurrence }>;

  /**
   * Find a previously received occurrence by (provider, externalEventId).
   * Returns undefined if not found.
   */
  get(provider: string, externalEventId: string): Promise<InboxOccurrence | undefined>;

  /**
   * Mark the occurrence as PROCESSED. Must be called inside the same
   * execution transaction that records the corresponding business receipt so
   * that receipt and inbox-status update atomically.
   *
   * Throws StaleWriteError if no occurrence exists or if already PROCESSED.
   */
  markProcessed(
    provider: string,
    externalEventId: string,
    processedAt: number,
  ): Promise<InboxOccurrence>;
}

export class InMemoryInboxStore implements InboxStore {
  private readonly occurrences = new Map<string, InboxOccurrence>();

  private static key(provider: string, externalEventId: string): string {
    return `${encodeURIComponent(provider)}:${encodeURIComponent(externalEventId)}`;
  }

  public async putOrIgnore(
    provider: string,
    externalEventId: string,
    eventType: string,
    payload: unknown,
  ): Promise<{ readonly created: boolean; readonly occurrence: InboxOccurrence }> {
    const k = InMemoryInboxStore.key(provider, externalEventId);
    const existing = this.occurrences.get(k);
    if (existing) {
      return { created: false, occurrence: existing };
    }
    const occurrence: InboxOccurrence = {
      provider,
      externalEventId,
      eventType,
      payload,
      status: "RECEIVED",
      receivedAt: Date.now(),
    };
    this.occurrences.set(k, occurrence);
    return { created: true, occurrence };
  }

  public async get(provider: string, externalEventId: string): Promise<InboxOccurrence | undefined> {
    return this.occurrences.get(InMemoryInboxStore.key(provider, externalEventId));
  }

  public async markProcessed(
    provider: string,
    externalEventId: string,
    processedAt: number,
  ): Promise<InboxOccurrence> {
    const k = InMemoryInboxStore.key(provider, externalEventId);
    const existing = this.occurrences.get(k);
    if (!existing) {
      throw new StaleWriteError(`Inbox occurrence not found: ${provider}:${externalEventId}`);
    }
    if (existing.status === "PROCESSED") {
      throw new StaleWriteError(`Inbox occurrence already processed: ${provider}:${externalEventId}`);
    }
    const updated: InboxOccurrence = { ...existing, status: "PROCESSED", processedAt };
    this.occurrences.set(k, updated);
    return updated;
  }
}
