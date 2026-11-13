import type { Pool, PoolClient } from "pg";
import {
  ClaimConflictError,
  StaleWriteError,
  type ActionId,
  type PlanId,
  type PlanRevision,
  type ProgramId,
} from "../../core/types.js";
import type {
  DedupeKey,
  WakeClaim,
  WakeDeliveryAcknowledgement,
  WakeId,
  WakeIntent,
  WakeResultWrite,
  WakeStore,
} from "../../core/wake.js";

interface WakeRow {
  wake_id: string;
  dedupe_key: string;
  program_id: string;
  plan_id: string;
  action_id?: string;
  plan_revision: string;
  trigger_type: WakeIntent["triggerType"];
  not_before: Date;
  preferred_harness?: string;
  fallback_policy: string;
  attempt: number;
  status: WakeIntent["status"];
  claim_fence: number;
  owner_id?: string;
  lease_until?: Date;
}

export interface PostgresWakeStoreConfig {
  readonly pool: Pool;
  readonly leaseDurationMs?: number;
  readonly clock?: () => number;
}

export class PostgresWakeStore implements WakeStore {
  private readonly pool: Pool;
  private readonly leaseDurationMs: number;
  private readonly clock: () => number;

  public constructor(config: PostgresWakeStoreConfig) {
    this.pool = config.pool;
    this.leaseDurationMs = config.leaseDurationMs ?? 30_000;
    this.clock = config.clock ?? (() => Date.now());
  }

  public async putOrGet(intent: WakeIntent): Promise<{ readonly created: boolean; readonly intent: WakeIntent }> {
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO dpc_wake_intents
          (wake_id, dedupe_key, program_id, plan_id, action_id, plan_revision,
           trigger_type, not_before, preferred_harness, fallback_policy, attempt, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING wake_id`,
        [
          intent.wakeId,
          intent.dedupeKey,
          intent.programId,
          intent.planId,
          intent.actionId ?? null,
          intent.planRevision,
          intent.triggerType,
          new Date(intent.notBefore),
          intent.preferredHarness ?? null,
          intent.fallbackPolicy,
          intent.attempt,
          intent.status,
        ],
      );
      const row = await this.requireRow(client, intent.wakeId);
      if (!this.sameImmutableFields(row, intent)) {
        throw new ClaimConflictError(`Wake dedupe key conflicts: ${intent.dedupeKey}`);
      }
      return { created: inserted.rowCount === 1, intent: this.map(row) };
    });
  }

  public async listReady(now: number): Promise<readonly WakeIntent[]> {
    const result = await this.pool.query<WakeRow>(
      `SELECT * FROM dpc_wake_intents
       WHERE not_before <= $1
         AND (status IN ('PENDING','UNKNOWN') OR (status = 'CLAIMED' AND lease_until <= $1))
       ORDER BY not_before, wake_id`,
      [new Date(now)],
    );
    return result.rows.map((row) => this.map(row));
  }

  public async claim(wakeId: WakeId, ownerId: string, now: number): Promise<WakeClaim> {
    return this.transaction(async (client) => {
      const row = await this.requireRow(client, wakeId, true);
      if (row.lease_until && row.lease_until.getTime() > now) {
        throw new ClaimConflictError(`Wake ${wakeId} is claimed by ${row.owner_id}`);
      }
      if (row.not_before.getTime() > now || !["PENDING", "UNKNOWN", "CLAIMED"].includes(row.status)) {
        throw new ClaimConflictError(`Wake ${wakeId} is not claimable in ${row.status}`);
      }
      const fence = row.claim_fence + 1;
      await client.query(
        `UPDATE dpc_wake_intents
         SET status = 'CLAIMED', attempt = attempt + 1, claim_fence = $2,
             owner_id = $3, lease_until = $4, updated_at = now()
         WHERE wake_id = $1`,
        [wakeId, fence, ownerId, new Date(now + this.leaseDurationMs)],
      );
      return { wakeId, fence, ownerId };
    });
  }

  public async acknowledgeDelivery(claim: WakeClaim, acknowledgement: WakeDeliveryAcknowledgement): Promise<WakeIntent> {
    return this.transaction(async (client) => {
      await this.lockClaim(client, claim);
      const status = acknowledgement.status === "ACKNOWLEDGED" ? "DELIVERED" : "UNKNOWN";
      await client.query(
        `UPDATE dpc_wake_intents SET status = $2, updated_at = now() WHERE wake_id = $1`,
        [claim.wakeId, status],
      );
      return this.map(await this.requireRow(client, claim.wakeId));
    });
  }

  public async writeResult(claim: WakeClaim, result: WakeResultWrite): Promise<WakeIntent> {
    return this.transaction(async (client) => {
      await this.lockClaim(client, claim);
      await client.query(
        `UPDATE dpc_wake_intents
         SET status = $2, owner_id = NULL, lease_until = NULL, updated_at = now()
         WHERE wake_id = $1`,
        [claim.wakeId, result.status],
      );
      return this.map(await this.requireRow(client, claim.wakeId));
    });
  }

  public async get(wakeId: WakeId): Promise<WakeIntent | undefined> {
    const result = await this.pool.query<WakeRow>("SELECT * FROM dpc_wake_intents WHERE wake_id = $1", [wakeId]);
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  private async lockClaim(client: PoolClient, claim: WakeClaim): Promise<void> {
    const row = await this.requireRow(client, claim.wakeId, true);
    if (row.claim_fence !== claim.fence || row.owner_id !== claim.ownerId || !row.lease_until || row.lease_until.getTime() <= this.clock()) {
      throw new StaleWriteError(`Wake claim is stale: ${claim.wakeId}`);
    }
  }

  private async requireRow(client: Pick<PoolClient, "query">, wakeId: WakeId, forUpdate = false): Promise<WakeRow> {
    const result = await client.query<WakeRow>(`SELECT * FROM dpc_wake_intents WHERE wake_id = $1 ${forUpdate ? "FOR UPDATE" : ""}`, [wakeId]);
    if (!result.rows[0]) throw new Error(`Wake not found: ${wakeId}`);
    return result.rows[0];
  }

  private map(row: WakeRow): WakeIntent {
    return {
      wakeId: row.wake_id as WakeId,
      dedupeKey: row.dedupe_key as DedupeKey,
      programId: row.program_id as ProgramId,
      planId: row.plan_id as PlanId,
      actionId: row.action_id as ActionId | undefined,
      planRevision: row.plan_revision as PlanRevision,
      triggerType: row.trigger_type,
      notBefore: row.not_before.getTime(),
      preferredHarness: row.preferred_harness,
      fallbackPolicy: row.fallback_policy,
      attempt: row.attempt,
      status: row.status,
    };
  }

  private sameImmutableFields(row: WakeRow, intent: WakeIntent): boolean {
    return row.dedupe_key === intent.dedupeKey
      && row.program_id === intent.programId
      && row.plan_id === intent.planId
      && (row.action_id ?? undefined) === intent.actionId
      && row.plan_revision === intent.planRevision
      && row.trigger_type === intent.triggerType
      && row.not_before.getTime() === intent.notBefore
      && (row.preferred_harness ?? undefined) === intent.preferredHarness
      && row.fallback_policy === intent.fallbackPolicy;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
