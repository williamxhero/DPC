import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

const { Pool } = pg;
import type {
  ActionDescriptor,
  ActionId,
  ActionLedger,
  ClaimAuthority,
  DurableExecutionStore,
  ExecutionIdentity,
  ExecutionLease,
  ExecutionRecord,
  EventKey,
  PlanId,
  ProgramId,
  Receipt,
  ReconciliationCandidate,
  OutboxEvent,
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
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
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
 * PostgreSQL durable execution adapter. It implements the Core-facing
 * ExecutionStore plus the legacy ActionLedger and ClaimAuthority interfaces
 * deliberately so atomic claim/receipt transitions stay inside one database
 * transaction while older non-durable callers remain compatible.
 */
export class PostgresExecutionStore implements DurableExecutionStore {
  private readonly pool: PgPool;
  private readonly ownsPool: boolean;
  private readonly clock: () => number;
  private readonly leaseDurationMs: number;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;

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
    this.lockTimeoutMs = this.timeoutValue(config.lockTimeoutMs ?? 5_000, "lockTimeoutMs");
    this.statementTimeoutMs = this.timeoutValue(config.statementTimeoutMs ?? 30_000, "statementTimeoutMs");
  }

  public async migrate(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(INITIAL_SCHEMA_SQL);
      await client.query(
        "INSERT INTO dpc_schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [1],
      );
    });
  }

  public async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  public async acquire(
    identity: ExecutionIdentity,
    ownerId: string,
    now: number,
  ): Promise<ExecutionLease> {
    return { identity: await this.claim(identity, ownerId, now) };
  }

  public startExecution(
    lease: ExecutionLease,
    action: ActionDescriptor,
  ): Promise<{ readonly created: boolean; readonly record: ExecutionRecord }> {
    return this.transaction(async (client) => {
      await this.lockClaim(client, lease.identity, this.clock());
      return this.beginExecutionInTransaction(client, lease.identity, action);
    });
  }

  public withValidLease<T>(lease: ExecutionLease, operation: () => Promise<T>): Promise<T> {
    return this.withValidClaim(lease.identity, operation);
  }

  public appendReceipt(lease: ExecutionLease, receipt: Receipt, now: number): Promise<void> {
    if (!this.sameIdentity(lease.identity, receipt.identity)) {
      return Promise.reject(new StaleWriteError(`Receipt lease is stale: ${receipt.identity.eventKey}`));
    }
    return this.appendReceiptWithClaim(receipt, this, now);
  }

  public replaceUnknownReceipt(
    lease: ExecutionLease,
    expectedIdentity: ExecutionIdentity,
    receipt: Receipt,
    now: number,
  ): Promise<void> {
    if (!this.sameStableIdentity(lease.identity, expectedIdentity)
      || !this.sameIdentity(lease.identity, receipt.identity)) {
      return Promise.reject(new StaleWriteError(`Recovery lease is stale: ${expectedIdentity.eventKey}`));
    }
    return this.replaceReceiptWithClaim(expectedIdentity, receipt, this, now);
  }

  public releaseExecution(lease: ExecutionLease): Promise<void> {
    return this.release(lease.identity);
  }

  public beginExecution(
    identity: ExecutionIdentity,
    action: ActionDescriptor,
  ): Promise<{ readonly created: boolean; readonly record: ExecutionRecord }> {
    return this.transaction((client) => this.beginExecutionInTransaction(client, identity, action));
  }

  private async beginExecutionInTransaction(
    client: Queryable,
    identity: ExecutionIdentity,
    action: ActionDescriptor,
  ): Promise<{ readonly created: boolean; readonly record: ExecutionRecord }> {
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
      if (!this.sameStableIdentity(execution.identity, receipt.identity)) {
        throw new StaleWriteError(`Receipt identity is stale: ${receipt.identity.eventKey}`);
      }
      const receiptId = await this.insertReceipt(client, execution.execution_id, receipt, "EXECUTION_RESULT");
      await this.updateExecution(client, execution.execution_id, receipt, receiptId);
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
      if (!this.sameStableIdentity(expectedIdentity, receipt.identity)) {
        throw new StaleWriteError(`Recovery receipt identity is stale: ${expectedIdentity.eventKey}`);
      }
      const receiptId = await this.insertReceipt(client, execution.execution_id, receipt, "RECOVERY_READBACK");
      await this.updateExecution(client, execution.execution_id, receipt, receiptId);
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

  public async listReceipts(
    programId: ProgramId,
    planId: PlanId,
    eventKey: EventKey,
  ): Promise<readonly Receipt[]> {
    const result = await this.pool.query<{ receipt_json: Receipt }>(
      `SELECT r.receipt_json
       FROM dpc_action_receipts r
       JOIN dpc_action_executions e ON e.execution_id = r.execution_id
       WHERE e.program_id = $1 AND e.plan_id = $2 AND e.event_key = $3
       ORDER BY r.recorded_at ASC, r.receipt_id ASC`,
      [programId, planId, eventKey],
    );
    return result.rows.map((row) => row.receipt_json);
  }

  public async hasBusinessCompletion(programId: ProgramId, planId: PlanId, actionId: ActionId): Promise<boolean> {
    return (await this.findLatestForAction(programId, planId, actionId))?.lifecycle === "COMPLETED";
  }

  public async claim(identity: ExecutionIdentity, ownerId: string, now: number): Promise<ExecutionIdentity> {
    return this.transaction(async (client) => {
      const key = [identity.programId, identity.planId, identity.actionId];

      // Keep the fence high-water mark separately from the active lease row.
      // Releasing a claim removes that row, but must not reset the next fence.
      await client.query(
        `INSERT INTO dpc_claim_fences (program_id, plan_id, action_id, claim_fence)
         SELECT $1, $2, $3, COALESCE(MAX(claim_fence), 0)
         FROM dpc_claims
         WHERE program_id = $1 AND plan_id = $2 AND action_id = $3
         ON CONFLICT (program_id, plan_id, action_id) DO NOTHING`,
        key,
      );
      const fenceRow = await client.query<{ claim_fence: number }>(
        `SELECT claim_fence
         FROM dpc_claim_fences
         WHERE program_id = $1 AND plan_id = $2 AND action_id = $3
         FOR UPDATE`,
        key,
      );
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
      const fence = (fenceRow.rows[0]?.claim_fence ?? currentRow?.claim_fence ?? 0) + 1;
      await client.query(
        `UPDATE dpc_claim_fences
         SET claim_fence = $4
         WHERE program_id = $1 AND plan_id = $2 AND action_id = $3`,
        [...key, fence],
      );
      await client.query(
        `INSERT INTO dpc_claims
          (program_id, plan_id, action_id, owner_id, claim_fence, event_key, plan_revision, nf_task_id, run_generation, lease_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (program_id, plan_id, action_id)
         DO UPDATE SET owner_id = EXCLUDED.owner_id,
                       claim_fence = EXCLUDED.claim_fence,
                       event_key = EXCLUDED.event_key,
                       plan_revision = EXCLUDED.plan_revision,
                       nf_task_id = EXCLUDED.nf_task_id,
                       run_generation = EXCLUDED.run_generation,
                       lease_until = EXCLUDED.lease_until,
                       updated_at = now()`,
        [
          ...key,
          ownerId,
          fence,
          identity.eventKey,
          identity.planRevision,
          identity.nfTaskId,
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
      plan_revision: string;
      nf_task_id: string;
      run_generation: number;
      lease_until: Date;
    }>(
      `SELECT claim_fence, event_key, plan_revision, nf_task_id, run_generation, lease_until
       FROM dpc_claims
       WHERE program_id = $1 AND plan_id = $2 AND action_id = $3`,
      [identity.programId, identity.planId, identity.actionId],
    );
    const row = result.rows[0];
    if (!row
      || row.claim_fence !== identity.claimFence
      || row.event_key !== identity.eventKey
      || row.plan_revision !== identity.planRevision
      || row.nf_task_id !== identity.nfTaskId
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

  public async pendingOutbox(): Promise<readonly OutboxEvent[]> {
    const result = await this.pool.query<OutboxEvent>(
      `SELECT outbox_id AS "outboxId", dedupe_key AS "dedupeKey", event_type AS "eventType",
              aggregate_id AS "aggregateId", status, attempts
       FROM dpc_outbox_events ORDER BY created_at`,
    );
    return result.rows;
  }

  public async listReconciliationCandidates(now: number): Promise<readonly ReconciliationCandidate[]> {
    const result = await this.pool.query<{
      execution_id: string | null;
      program_id: string;
      plan_id: string;
      plan_revision: string;
      action_id: string;
      event_key: string;
      nf_task_id: string;
      run_generation: number;
      claim_fence: number;
      kind: ReconciliationCandidate["kind"];
    }>(
      `SELECT execution_id, program_id, plan_id, plan_revision, action_id, event_key,
              nf_task_id, run_generation, claim_fence, 'UNKNOWN_RECEIPT' AS kind
       FROM dpc_action_executions
       WHERE lifecycle = 'UNKNOWN'
       UNION ALL
       SELECT execution_id, program_id, plan_id, plan_revision, action_id, event_key,
              nf_task_id, run_generation, claim_fence, 'STARTED_WITHOUT_RECEIPT' AS kind
       FROM dpc_action_executions
       WHERE lifecycle = 'STARTED' AND current_receipt_id IS NULL
       UNION ALL
       SELECT e.execution_id, c.program_id, c.plan_id,
              COALESCE(c.plan_revision, e.plan_revision, 'unknown'),
              c.action_id, c.event_key,
              COALESCE(c.nf_task_id, e.nf_task_id, 'unknown'),
              c.run_generation, c.claim_fence, 'EXPIRED_CLAIM' AS kind
       FROM dpc_claims c
       LEFT JOIN dpc_action_executions e
         ON e.program_id = c.program_id
        AND e.plan_id = c.plan_id
        AND e.action_id = c.action_id
        AND e.event_key = c.event_key
       WHERE c.lease_until <= $1
       ORDER BY execution_id NULLS LAST, kind`,
      [new Date(now)],
    );
    return result.rows.map((row) => ({
      executionId: row.execution_id ?? this.executionId({
        programId: row.program_id as ProgramId,
        planId: row.plan_id as PlanId,
        planRevision: row.plan_revision as ExecutionIdentity["planRevision"],
        actionId: row.action_id as ActionId,
        eventKey: row.event_key as EventKey,
        nfTaskId: row.nf_task_id as ExecutionIdentity["nfTaskId"],
        runGeneration: row.run_generation,
        claimFence: row.claim_fence,
      }),
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
      plan_revision: string;
      nf_task_id: string;
      run_generation: number;
      lease_until: Date;
    }>(
      `SELECT claim_fence, event_key, plan_revision, nf_task_id, run_generation, lease_until
       FROM dpc_claims
       WHERE program_id = $1 AND plan_id = $2 AND action_id = $3
       FOR UPDATE`,
      [identity.programId, identity.planId, identity.actionId],
    );
    const row = result.rows[0];
    if (!row
      || row.claim_fence !== identity.claimFence
      || row.event_key !== identity.eventKey
      || row.plan_revision !== identity.planRevision
      || row.nf_task_id !== identity.nfTaskId
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

  private async insertReceipt(client: Queryable, executionId: string, receipt: Receipt, kind: string): Promise<string> {
    const result = await client.query<{ receipt_id: string }>(
      `INSERT INTO dpc_action_receipts
        (receipt_id, execution_id, program_id, plan_id, plan_revision, action_id,
         event_key, nf_task_id, run_generation, claim_fence, receipt_kind,
         nf_status, business_status, receipt_json, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING receipt_id`,
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
    const receiptId = result.rows[0]?.receipt_id;
    if (!receiptId) throw new DpcAdapterError("PostgreSQL receipt insert returned no receipt id");
    return receiptId;
  }

  private async updateExecution(
    client: Queryable,
    executionId: string,
    receipt: Receipt,
    receiptId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE dpc_action_executions
       SET lifecycle = $2,
           claim_fence = $3,
           current_receipt_id = $4,
           updated_at = now()
       WHERE execution_id = $1`,
      [executionId, this.lifecycleFor(receipt), receipt.identity.claimFence, receiptId],
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
      receipt: row.receipt_json ?? undefined,
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

  private sameIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
    return this.sameStableIdentity(left, right) && left.claimFence === right.claimFence;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${this.lockTimeoutMs}ms`]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${this.statementTimeoutMs}ms`]);
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

  private timeoutValue(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 0) {
      throw new DpcAdapterError(`${name} must be a non-negative integer`);
    }
    return value;
  }
}
