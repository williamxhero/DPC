import type {
  PlanChangeProposal,
  PlanChangeRequest,
  PlanRevisionRecord,
  RevisionActionState,
  TacticalRoute,
} from "./types.js";

/**
 * Pure plan-evolution rules. It creates advisory data and classifications; it
 * never writes a plan, changes authorization, or changes scheduler state.
 */
export function revisionCanAffectAction(
  revision: PlanRevisionRecord,
  action: RevisionActionState,
  now: number,
): boolean {
  return now >= revision.effectiveAt
    && revision.scope.actionIds.includes(action.actionId)
    && action.lifecycle === "NOT_STARTED"
    && !action.frozen
    && !action.hasExternalEffect;
}

export function createAdvisoryPlanChange(
  request: PlanChangeRequest,
  createdAt: number,
): PlanChangeProposal {
  if (request.evidenceReferences.length === 0) {
    throw new Error("A plan change proposal requires evidence references");
  }
  if (request.requestedChanges.length === 0) {
    throw new Error("A plan change proposal requires requested changes");
  }
  return Object.freeze({
    ...request,
    proposalId: `proposal:${request.planId}:${request.baseRevision}:${request.requestedChanges.join("|")}`,
    status: "ADVISORY" as const,
    createdAt,
    effectiveAt: request.effectiveAt ?? createdAt,
    evidenceReferences: [...request.evidenceReferences],
    requestedChanges: [...request.requestedChanges],
    impactedActionIds: [...request.impactedActionIds],
  });
}

export type TacticalRouteAssessment =
  | { readonly status: "NEW"; readonly route: TacticalRoute }
  | { readonly status: "NO_PROGRESS"; readonly route: TacticalRoute };

export function assessTacticalRoute(
  route: TacticalRoute,
  priorRouteKeys: ReadonlySet<string>,
): TacticalRouteAssessment {
  return priorRouteKeys.has(route.routeKey)
    ? { status: "NO_PROGRESS", route }
    : { status: "NEW", route };
}
