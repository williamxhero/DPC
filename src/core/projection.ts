import type { PlanId, PlanRevision } from "./types.js";

export interface ReadOnlyProjection {
  readonly planId: PlanId;
  readonly revision: PlanRevision;
  readonly authoritativeDigest: string;
  readonly actionSummaries: readonly string[];
  readonly evidenceReferences: readonly string[];
}

export interface ProjectionDrift {
  readonly planId: PlanId;
  readonly drifted: boolean;
  readonly fields: readonly string[];
}

/** The projection seam can publish/read a view, but has no authority write API. */
export interface ProjectionAdapter {
  publish(projection: ReadOnlyProjection): Promise<ReadOnlyProjection>;
  read(planId: PlanId): Promise<ReadOnlyProjection | undefined>;
  compare(authoritative: ReadOnlyProjection): Promise<ProjectionDrift>;
}

export class InMemoryProjectionAdapter implements ProjectionAdapter {
  private readonly projections = new Map<PlanId, ReadOnlyProjection>();

  public async publish(projection: ReadOnlyProjection): Promise<ReadOnlyProjection> {
    this.projections.set(projection.planId, projection);
    return projection;
  }

  public async read(planId: PlanId): Promise<ReadOnlyProjection | undefined> {
    return this.projections.get(planId);
  }

  public async compare(authoritative: ReadOnlyProjection): Promise<ProjectionDrift> {
    const current = this.projections.get(authoritative.planId);
    if (!current) {
      return { planId: authoritative.planId, drifted: true, fields: ["missing"] };
    }
    const fields: string[] = [];
    if (current.revision !== authoritative.revision) fields.push("revision");
    if (current.authoritativeDigest !== authoritative.authoritativeDigest) fields.push("authoritativeDigest");
    if (current.actionSummaries.join("\u0000") !== authoritative.actionSummaries.join("\u0000")) fields.push("actionSummaries");
    if (current.evidenceReferences.join("\u0000") !== authoritative.evidenceReferences.join("\u0000")) fields.push("evidenceReferences");
    return { planId: authoritative.planId, drifted: fields.length > 0, fields };
  }
}
