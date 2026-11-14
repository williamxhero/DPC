import type { ExecutionIdentity } from "./types.js";

type StableExecutionIdentityFields = {
  readonly programId: string;
  readonly planId: string;
  readonly planRevision: string;
  readonly actionId: string;
  readonly eventKey: string;
  readonly nfTaskId: string;
  readonly runGeneration: number;
};

/**
 * Compares the complete fenced execution identity, including claim ownership.
 */
export function sameExecutionIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return left.programId === right.programId
    && left.planId === right.planId
    && left.planRevision === right.planRevision
    && left.actionId === right.actionId
    && left.eventKey === right.eventKey
    && left.nfTaskId === right.nfTaskId
    && left.runGeneration === right.runGeneration
    && left.claimFence === right.claimFence;
}

/**
 * Compares the stable execution identity used by external effects and recovery.
 * The claim fence is coordination state, not part of effect identity.
 */
export function sameStableExecutionIdentity(
  left: StableExecutionIdentityFields,
  right: StableExecutionIdentityFields,
): boolean {
  return left.programId === right.programId
    && left.planId === right.planId
    && left.planRevision === right.planRevision
    && left.actionId === right.actionId
    && left.eventKey === right.eventKey
    && left.nfTaskId === right.nfTaskId
    && left.runGeneration === right.runGeneration;
}
