import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

const { Pool } = pg;
import type { ReconciliationCandidate, ReconciliationStore } from "../../core/reconciliation.js";
import type {
  ActionDescriptor,
  ActionId,
  ActionLedger,
  ClaimAuthority,
  ExecutionIdentity,
  ExecutionRecord,
  EventKey,
  PlanId,
  ProgramId,
  Receipt,
} from "../../core/types.js";
import {
  ClaimConflictError,
  DpcAdapterError,
  StaleWriteError,
} from "../../core/types.js";
import { INITIAL_SCHEMA_SQL } from "./schema.js";

export interface PostgresExecutionStoreConfig extends PoolConfig {
  readonly pool?: PgPool;
  readonly clock?: () => number;
  readonly leaseDurationMs?: number;
}

type Queryable = Pick<PoolClient, "query">;

type ExecutionRow = {
  execution_id: string;
  program_id: string;
  plan_id: string;
  plan_revision: string;
  action_id: string;
  event_key: string;
  nf_task_id: string;
  run_generation: number;
  claim_fence: number;
  lifecycle: ExecutionRecord["lifecycle"];
  action_json: ActionDescriptor;
  receipt_json?: Receipt;
};

/**
 * PostgreSQL durable execution adapter. It implements both ActionLedger and
 * ClaimAuthority deliberately so atomic claim/receipt transitions stay inside
 * one database transaction instead of crossing two independent adapters.
 */
export class PostgresExecutionStore implements ActionLedger, ClaimAuthority, ReconciliationStore {
  private readonly pool: PgPool;
  private readonly ownsPool: boolean;
  private readonly clock: () => number;
  private readonly leaseDurationMs: number;

  public constructor(config: PostgresExecutionStoreConfig) {
    if (config.pool) {
      this.pool = config.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool(config);
      this.ownsPool = true;
    }
    this.clock = config.clock ?? (() => Date.now());
    this.leaseDurationMs = config.leaseDurationMs ?? 30_000;
  }

  public async migrate(): Promise<void> {
    await this.pool.query(INITIAL_SCHEMA_SQL);
    await this.pool.query(
      "INSERT INTO dpc_schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
      [1],
    );
  }

  public async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  public async beginExecution(
    identity: ExecutionIdentity,
    action: ActionDescriptor,
  ): Promise<{ readonly created: boolean; readonly record: ExecutionRecord }> {
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO dpc_action_executions
          (execution_id, program_id, plan_id, plan_revision, action_id, event_key,
           nf_task_id, run_generation, claim_fence, lifecycle, action_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (program_id, plan_id, event_key) DO NOTHING
         RETURNING execution_id`,
        [
          this.executionId(identity),
          identity.programId,
          identity.planId,
          identity.planRevision,
          identity.actionId,
          identity.eventKey,
          identity.nfTaskId,
          identity.runGeneration,
          identity.claimFence,
          "STARTED",
          action,
        ],
      );
      const record = await this.findExecution(client, identity.programId, identity.planId, identity.eventKey);
      if (!record) throw new DpcAdapterError("PostgreSQL execution row disappeared after begin");
      return { created: inserted.rowCount === 1, record };
    });
  }

  public async appendReceiptWithClaim(receipt: Receipt, claims: ClaimAuthority, now: number): Promise<void> {
    if (claims !== this) {
      throw new DpcAdapterError("PostgreSQL atomic receipt writes require the same PostgresExecutionStore as ClaimAuthority");
    }
    await this.transaction(async (client) => {
      await this.lockClaim(client, receipt.identity, now);
      const execution = await this.findExecution(client, receipt.identity.programId, receipt.identity.planId, receipt.identity.eventKey, true);
      if (!execution || execution.receipt) {
        throw new StaleWriteError(`Execution is not writable: ${receipt.identity.eventKey}`);
      }
      await this.insertReceipt(client, execution.execution_id, receipt, "EXECUTION_RESULT");
      await this.updateExecution(client, execution.execution_id, receipt);
      await this.insertOutbox(client, `receipt:${receipt.identity.programId}:${receipt.identity.planId}:${receipt.identity.eventKey}:${receipt.identity.runGeneration}`, "RECEIPT_RECORDED", execution.execution_id, receipt);
      await this.deleteClaim(client, receipt.identity);
    });
  }

  public async replaceReceiptWithClaim(
    expectedIdentity: ExecutionIdentity,
    receipt: Receipt,
    claims: ClaimAuthority,
    now: number,
  ): Promise<void> {
    if (claims !== this) {
      throw new DpcAdapterError("PostgreSQL atomic recovery writes require the same PostgresExecutionStore as ClaimAuthority");
    }
    await this.transaction(async (client) => {
      await this.lockClaim(client, receipt.identity, now);
      const execution = await this.findExecution(client, expectedIdentity.programId, expectedIdentity.planId, expectedIdentity.eventKey, true);
      if (!execution || !execution.receipt || execution.receipt.businessStatus !== "UNKNOWN") {
        throw new StaleWriteError(`Execution is not recoverable: ${expectedIdentity.eventKey}`);
      }
      if (!this.sameStableIdentity(execution.receipt.identity, expectedIdentity)) {
        throw new StaleWriteError(`Recovery identity is stale: ${expectedIdentity.eventKey}`);
      }
      await this.insertReceipt(client, execution.execution_id, receipt, "RECOVERY_READBACK");
      await this.updateExecution(client, execution.execution_id, receipt);
      await this.insertOutbox(client, `recovery:${receipt.identity.programId}:${receipt.identity.planId}:${receipt.identity.eventKey}:${receipt.identity.runGeneration}`, "RECOVERY_RESOLVED", execution.execution_id, receipt);
      await this.deleteClaim(client, receipt.identity);
    });
  }

  public async findByEventKey(programId: ProgramId, planId: PlanId, eventKey: EventKey): Promise<ExecutionRecord | undefined> {
    return this.findExecution(this.pool, programId, planId, eventKey);
  }

  public async findLatestForAction(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<ExecutionRecord | undefined> {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT e.*, r.receipt_json
       FROM dpc_action_executions e
       LEFT JOIN dpc_action_receipts r ON r.receipt_id = e.current_receipt_id
       WHERE e.program_id = $1 AND e.plan_id = $2 AND e.action_id = $3
       ORDER BY e.run_generation DESC, e.created_at DESC
       LIMIT 1`,
      [programId, planId, actionId],
    );
    return result.rows[0] ? this.mapExecution(result.rows[0]) : undefined;
  }

  public async hasBusinessCompletion(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<boolean> {
    return (await this.findLatestForAction(programId, planId, actionId))?.lifecycle === "COMPLETED";
  }

  public async claim(identity: ExecutionIdentity, ownerId: string, now: number): Promise<ExecutionIdentity> {
    return this.transaction(async (client) => {
      const key = [identity.programId, identity.planId, identity.actionId];
      const current = await client.query<{
        claim_fence: number;
        lease_until: Date;
        owner_id: string;
      }>(
        `SELECT claim_fence, lease_until, owner_id
         FROM dpc_claims
         WHERE program_id = $1 AND plan_id = $2 AND action_id = $3
         FOR UPDATE`,
        key,
      );
      const currentRow = current.rows[0];
      if (currentRow && currentRow.lease_until.getTime() > now) {
        throw new ClaimConflictError(`Action ${identity.actionId} is claimed by ${currentRow.owner_id}`);
      }
      const fence = (currentRow?.claim_fence ?? 0) + 1;
      await client.query(
        `INSERT INTO dpc_claims
          (program_id, plan_id, action_id, owner_id, claim_fence, event_key, run_generation, lease_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (program_id, plan_id, action_id)
         DO UPDATE SET owner_id = EXCLUDED.owner_id,
                       claim_fence = EXCLUDED.claim_fence,
                       event_key = EXCLUDED.event_key,
                       run_generation = EXCLUDED.run_generation,
                       lease_until = EXCLUDED.lease_until,
                       updated_at = now()`,
        [
          ...key,
          ownerId,
          fence,
          identity.eventKey,
          identity.runGeneration,
          new Date(now + this.leaseDurationMs),
        ],
      );
      return { ...identity, claimFence: fence };
    });
  }

  public async assertValid(identity: ExecutionIdentity, now: number): Promise<void> {
    const result = await this.pool.query<{
      claim_fence: number;
      event_key: string;
      run_generation: number;
      lease_until: Date;
    }>(
      `SELECT claim_fence, event_key, run_generation, lease_until
       FROM dpc_claims
       WHERE program_id = $1 AND plan_id = $2 AND action_id = $3`,
      [identity.programId, identity.planId, identity.actionId],
    );
    const row = result.rows[0];
    if (!row
      || row.claim_fence !== identity.claimFence
      || row.event_key !== identity.eventKey
      || row.run_generation !== identity.runGeneration
      || row.lease_until.getTime() <= now) {
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
    await this.pool.query(
      `DELETE FROM dpc_claims
       WHERE program_id = $1 AND plan_id = $2 AND action_id = $3
         AND event_key = $4 AND claim_fence = $5`,
      [identity.programId, identity.planId, identity.actionId, identity.eventKey, identity.claimFence],
    );
  }

  public async pendingOutbox(): Promise<readonly Record<string, unknown>[]> {
    const result = await this.pool.query(
      `SELECT outbox_id, dedupe_key, event_type, aggregate_id, status, attempts
       FROM dpc_outbox_events ORDER BY created_at`,
    );
    return result.rows;
  }

  public async listReconciliationCandidates(now: number): Promise<readonly ReconciliationCandidate[]> {
    const result = await this.pool.query<{
      execution_id: string;
      program_id: string;
      plan_id: string;
      plan_revision: string;
      action_id: string;
      event_key: string;
      kind: ReconciliationCandidate["kind"];
    }>(
      `SELECT execution_id, program_id, plan_id, plan_revision, action_id, event_key,
              'UNKNOWN_RECEIPT' AS kind
       FROM dpc_action_executions
       WHERE lifecycle = 'UNKNOWN'
       UNION ALL
       SELECT execution_id, program_id, plan_id, plan_revision, action_id, event_key,
              'STARTED_WITHOUT_RECEIPT' AS kind
       FROM dpc_action_executions
       WHERE lifecycle = 'STARTED' AND current_receipt_id IS NULL
       UNION ALL
       SELECT e.execution_id, e.program_id, e.plan_id, e.plan_revision, e.action_id, e.event_key,
              'EXPIRED_CLAIM' AS kind
       FROM dpc_claims c
       JOIN dpc_action_executions e
         ON e.program_id = c.program_id
        AND e.plan_id = c.plan_id
        AND e.action_id = c.action_id
        AND e.event_key = c.event_key
       WHERE c.lease_until <= $1
       ORDER BY execution_id, kind`,
      [new Date(now)],
    );
    return result.rows.map((row) => ({
      executionId: row.execution_id,
      programId: row.program_id as ReconciliationCandidate["programId"],
      planId: row.plan_id as ReconciliationCandidate["planId"],
      planRevision: row.plan_revision as ReconciliationCandidate["planRevision"],
      actionId: row.action_id as ReconciliationCandidate["actionId"],
      eventKey: row.event_key as ReconciliationCandidate["eventKey"],
      kind: row.kind,
      observedAt: now,
    }));
  }

  private async lockClaim(client: Queryable, identity: ExecutionIdentity, now: number): Promise<void> {
    const result = await client.query<{
      claim_fence: number;
      event_key: string;
      run_generation: number;
      lease_until: Date;
    }>(
      `SELECT claim_fence, event_key, run_generation, lease_until
       FROM dpc_claims
       WHERE program_id = $1 AND plan_id = $2 AND action_id = $3
       FOR UPDATE`,
      [identity.programId, identity.planId, identity.actionId],
    );
    const row = result.rows[0];
    if (!row
      || row.claim_fence !== identity.claimFence
      || row.event_key !== identity.eventKey
      || row.run_generation !== identity.runGeneration
      || row.lease_until.getTime() <= now) {
      throw new StaleWriteError(`Claim fence is stale for ${identity.actionId}`);
    }
  }

  private async deleteClaim(client: Queryable, identity: ExecutionIdentity): Promise<void> {
    await client.query(
      `DELETE FROM dpc_claims
       WHERE program_id = $1 AND plan_id = $2 AND action_id = $3
         AND event_key = $4 AND claim_fence = $5`,
      [identity.programId, identity.planId, identity.actionId, identity.eventKey, identity.claimFence],
    );
  }

  private async insertReceipt(client: Queryable, executionId: string, receipt: Receipt, kind: string): Promise<void> {
    await client.query(
      `INSERT INTO dpc_action_receipts
        (receipt_id, execution_id, program_id, plan_id, plan_revision, action_id,
         event_key, nf_task_id, run_generation, claim_fence, receipt_kind,
         nf_status, business_status, receipt_json, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        randomUUID(),
        executionId,
        receipt.identity.programId,
        receipt.identity.planId,
        receipt.identity.planRevision,
        receipt.identity.actionId,
        receipt.identity.eventKey,
        receipt.identity.nfTaskId,
        receipt.identity.runGeneration,
        receipt.identity.claimFence,
        kind,
        receipt.nfStatus,
        receipt.businessStatus,
        receipt,
        new Date(receipt.recordedAt),
      ],
    );
  }

  private async updateExecution(client: Queryable, executionId: string, receipt: Receipt): Promise<void> {
    await client.query(
      `UPDATE dpc_action_executions
       SET lifecycle = $2,
           claim_fence = $3,
           current_receipt_id = (
             SELECT receipt_id FROM dpc_action_receipts
             WHERE execution_id = $1 ORDER BY recorded_at DESC LIMIT 1
           ),
           updated_at = now()
       WHERE execution_id = $1`,
      [executionId, this.lifecycleFor(receipt), receipt.identity.claimFence],
    );
  }

  private async insertOutbox(client: Queryable, dedupeKey: string, eventType: string, aggregateId: string, payload: unknown): Promise<void> {
    await client.query(
      `INSERT INTO dpc_outbox_events
        (outbox_id, dedupe_key, event_type, aggregate_id, payload_json)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [randomUUID(), dedupeKey, eventType, aggregateId, payload],
    );
  }

  private async findExecution(
    client: Queryable,
    programId: ProgramId,
    planId: PlanId,
    eventKey: EventKey,
    forUpdate = false,
  ): Promise<ExecutionRecord & { readonly execution_id: string } | undefined> {
    const result = await client.query<ExecutionRow>(
      `SELECT e.*, r.receipt_json
       FROM dpc_action_executions e
       LEFT JOIN dpc_action_receipts r ON r.receipt_id = e.current_receipt_id
       WHERE e.program_id = $1 AND e.plan_id = $2 AND e.event_key = $3
       ${forUpdate ? "FOR UPDATE OF e" : ""}`,
      [programId, planId, eventKey],
    );
    const row = result.rows[0];
    return row ? { ...this.mapExecution(row), execution_id: row.execution_id } : undefined;
  }

  private mapExecution(row: ExecutionRow): ExecutionRecord {
    return {
      identity: {
        programId: row.program_id as ExecutionIdentity["programId"],
        planId: row.plan_id as ExecutionIdentity["planId"],
        planRevision: row.plan_revision as ExecutionIdentity["planRevision"],
        actionId: row.action_id as ExecutionIdentity["actionId"],
        eventKey: row.event_key as ExecutionIdentity["eventKey"],
        nfTaskId: row.nf_task_id as ExecutionIdentity["nfTaskId"],
        runGeneration: row.run_generation,
        claimFence: row.claim_fence,
      },
      action: row.action_json,
      lifecycle: row.lifecycle,
      receipt: row.receipt_json,
    };
  }

  private lifecycleFor(receipt: Receipt): ExecutionRecord["lifecycle"] {
    switch (receipt.businessStatus) {
      case "COMPLETED": return "COMPLETED";
      case "WAIT_EXTERNAL": return "WAITING";
      case "FAILED": return "FAILED";
      case "UNKNOWN": return "UNKNOWN";
      case "CONTINUE": return "STARTED";
    }
  }

  private executionId(identity: ExecutionIdentity): string {
    return Buffer.from(JSON.stringify([
      identity.programId,
      identity.planId,
      identity.eventKey,
      identity.runGeneration,
    ])).toString("base64url");
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

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
