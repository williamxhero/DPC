import type { Pool, PoolClient } from "pg";
import { StaleWriteError } from "../../core/types.js";
import type { HandoffBundle, HandoffStore } from "../../core/handoff.js";

interface HandoffRow {
  handoff_id: string;
  program_id: string;
  plan_id: string;
  plan_revision: string;
  action_id: string;
  event_key: string;
  bundle_json: HandoffBundle;
  status: HandoffBundle["status"];
  accepted_by?: string;
  created_at: Date;
  accepted_at?: Date;
}

export interface PostgresHandoffStoreConfig {
  readonly pool: Pool;
}

export class PostgresHandoffStore implements HandoffStore {
  private readonly pool: Pool;

  public constructor(config: PostgresHandoffStoreConfig) {
    this.pool = config.pool;
  }

  public async putOrGet(bundle: HandoffBundle): Promise<{ readonly created: boolean; readonly bundle: HandoffBundle }> {
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO dpc_handoff_bundles
          (handoff_id, program_id, plan_id, plan_revision, action_id, event_key,
           source_harness, source_run, status, bundle_json, accepted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (handoff_id) DO NOTHING
         RETURNING handoff_id`,
        [
          bundle.handoffId,
          bundle.programId,
          bundle.planId,
          bundle.planRevision,
          bundle.actionId,
          bundle.eventKey,
          bundle.sourceHarness,
          bundle.sourceRun,
          bundle.status,
          bundle,
          bundle.acceptedBy ?? null,
        ],
      );
      const row = await this.requireRow(client, bundle.handoffId);
      this.assertIdentity(row, bundle);
      return { created: inserted.rowCount === 1, bundle: this.map(row) };
    });
  }

  public async get(handoffId: string): Promise<HandoffBundle | undefined> {
    const result = await this.pool.query<HandoffRow>("SELECT * FROM dpc_handoff_bundles WHERE handoff_id = $1", [handoffId]);
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  public async accept(handoffId: string, targetHarness: string, expected: HandoffBundle): Promise<HandoffBundle> {
    return this.transaction(async (client) => {
      const row = await this.requireRow(client, handoffId, true);
      this.assertIdentity(row, expected);
      if (row.status !== "READY" && row.status !== "ACCEPTED") {
        throw new StaleWriteError(`Handoff changed before acceptance: ${handoffId}`);
      }
      const accepted: HandoffBundle = {
        ...this.map(row),
        status: "ACCEPTED",
        acceptedBy: targetHarness,
      };
      await client.query(
        `UPDATE dpc_handoff_bundles
         SET status = 'ACCEPTED', accepted_by = $2, accepted_at = now(), bundle_json = $3
         WHERE handoff_id = $1`,
        [handoffId, targetHarness, accepted],
      );
      return accepted;
    });
  }

  private async requireRow(client: Pick<PoolClient, "query">, handoffId: string, forUpdate = false): Promise<HandoffRow> {
    const result = await client.query<HandoffRow>(`SELECT * FROM dpc_handoff_bundles WHERE handoff_id = $1 ${forUpdate ? "FOR UPDATE" : ""}`, [handoffId]);
    if (!result.rows[0]) throw new StaleWriteError(`Handoff not found: ${handoffId}`);
    return result.rows[0];
  }

  private assertIdentity(row: HandoffRow, expected: HandoffBundle): void {
    if (row.program_id !== expected.programId
      || row.plan_id !== expected.planId
      || row.plan_revision !== expected.planRevision
      || row.action_id !== expected.actionId
      || row.event_key !== expected.eventKey) {
      throw new StaleWriteError(`Handoff identity conflicts: ${row.handoff_id}`);
    }
  }

  private map(row: HandoffRow): HandoffBundle {
    return {
      ...row.bundle_json,
      status: row.status,
      acceptedBy: row.accepted_by ?? row.bundle_json.acceptedBy,
      createdAt: row.created_at.getTime(),
    };
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
