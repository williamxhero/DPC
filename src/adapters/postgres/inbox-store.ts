import type { Pool } from "pg";
import { StaleWriteError } from "../../core/types.js";
import type { InboxOccurrence, InboxQueryable, InboxStore } from "../../core/inbox.js";

interface InboxRow {
  provider: string;
  external_event_id: string;
  event_type: string;
  payload_json: unknown;
  status: InboxOccurrence["status"];
  received_at: Date;
  processed_at: Date | null;
}

export interface PostgresInboxStoreConfig {
  readonly pool: Pool;
}

/**
 * PostgreSQL durable inbox. Rows are keyed by (provider, external_event_id).
 *
 * putOrIgnore uses INSERT … ON CONFLICT DO NOTHING so that concurrent
 * deliveries of the same external event ID produce exactly one row.
 *
 * `markProcessed` is retained only as a compatibility operation for legacy
 * callers. The durable execution seam performs the same conditional update
 * internally, in the transaction that writes the receipt and outbox event, so
 * new callers never pass a transaction client.
 */
export class PostgresInboxStore implements InboxStore {
  private readonly pool: Pool;

  public constructor(config: PostgresInboxStoreConfig) {
    this.pool = config.pool;
  }

  public async putOrIgnore(
    provider: string,
    externalEventId: string,
    eventType: string,
    payload: unknown,
  ): Promise<{ readonly created: boolean; readonly occurrence: InboxOccurrence }> {
    const inserted = await this.pool.query<{ provider: string }>(
      `INSERT INTO dpc_inbox_events
        (provider, external_event_id, event_type, payload_json, status, received_at)
       VALUES ($1, $2, $3, $4, 'RECEIVED', now())
       ON CONFLICT (provider, external_event_id) DO NOTHING
       RETURNING provider`,
      [provider, externalEventId, eventType, JSON.stringify(payload)],
    );
    const existing = await this.pool.query<InboxRow>(
      `SELECT provider, external_event_id, event_type, payload_json, status, received_at, processed_at
       FROM dpc_inbox_events
       WHERE provider = $1 AND external_event_id = $2`,
      [provider, externalEventId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new StaleWriteError(`Inbox occurrence disappeared after insert: ${provider}:${externalEventId}`);
    }
    return {
      created: (inserted.rowCount ?? 0) === 1,
      occurrence: this.map(row),
    };
  }

  public async get(provider: string, externalEventId: string): Promise<InboxOccurrence | undefined> {
    const result = await this.pool.query<InboxRow>(
      `SELECT provider, external_event_id, event_type, payload_json, status, received_at, processed_at
       FROM dpc_inbox_events
       WHERE provider = $1 AND external_event_id = $2`,
      [provider, externalEventId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  /**
   * Legacy compatibility operation. New callers should use
   * PostgresExecutionStore.processInboxOccurrence(), which keeps the client
   * and the enclosing transaction private to the execution adapter.
   *
   * Pass a client only when maintaining an older caller that already owns the
   * surrounding transaction.
   */
  public async markProcessed(
    provider: string,
    externalEventId: string,
    processedAt: number,
    client?: InboxQueryable,
  ): Promise<InboxOccurrence> {
    const queryable = client ?? this.pool;
    const result = await queryable.query<InboxRow>(
      `UPDATE dpc_inbox_events
       SET status = 'PROCESSED', processed_at = $3
       WHERE provider = $1 AND external_event_id = $2 AND status = 'RECEIVED'
       RETURNING provider, external_event_id, event_type, payload_json, status, received_at, processed_at`,
      [provider, externalEventId, new Date(processedAt)],
    );
    if (!result.rows[0]) {
      throw new StaleWriteError(`Inbox occurrence not found or already processed: ${provider}:${externalEventId}`);
    }
    return this.map(result.rows[0]);
  }

  private map(row: InboxRow): InboxOccurrence {
    return {
      provider: row.provider,
      externalEventId: row.external_event_id,
      eventType: row.event_type,
      payload: row.payload_json,
      status: row.status,
      receivedAt: row.received_at.getTime(),
      processedAt: row.processed_at ? row.processed_at.getTime() : undefined,
    };
  }
}
