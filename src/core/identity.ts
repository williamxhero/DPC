import type { ExecutionIdentity } from "./types.js";

type StableExecutionIdentityFields = Omit<ExecutionIdentity, "claimFence">;

declare const stableExecutionIdentityBrand: unique symbol;

/**
 * The stable portion of an execution identity.
 *
 * The brand keeps a complete fenced identity from being passed to stable-only
 * APIs without an explicit projection. It has no runtime representation, so
 * serialized marker fields remain unchanged.
 */
export type StableExecutionIdentity = StableExecutionIdentityFields & {
  readonly [stableExecutionIdentityBrand]: "StableExecutionIdentity";
};

/**
 * Projects a complete fenced identity into the stable identity used by
 * external effects, readback, and cleanup. Claim ownership is deliberately
 * not copied into the result.
 */
export function toStableExecutionIdentity(identity: ExecutionIdentity): StableExecutionIdentity {
  const stable: StableExecutionIdentityFields = {
    programId: identity.programId,
    planId: identity.planId,
    planRevision: identity.planRevision,
    actionId: identity.actionId,
    eventKey: identity.eventKey,
    nfTaskId: identity.nfTaskId,
    runGeneration: identity.runGeneration,
  };
  return stable as StableExecutionIdentity;
}

/**
 * Decodes the stable fields from a persisted marker or provider envelope.
 * Extra fields, including a legacy claimFence, are ignored so existing marker
 * formats remain readable while comparisons still use the stable contract.
 */
export function readStableExecutionIdentity(value: unknown): StableExecutionIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.programId !== "string"
    || typeof candidate.planId !== "string"
    || typeof candidate.planRevision !== "string"
    || typeof candidate.actionId !== "string"
    || typeof candidate.eventKey !== "string"
    || typeof candidate.nfTaskId !== "string"
    || typeof candidate.runGeneration !== "number"
    || !Number.isInteger(candidate.runGeneration)) {
    return undefined;
  }
  const stable: StableExecutionIdentityFields = {
    programId: candidate.programId as StableExecutionIdentityFields["programId"],
    planId: candidate.planId as StableExecutionIdentityFields["planId"],
    planRevision: candidate.planRevision as StableExecutionIdentityFields["planRevision"],
    actionId: candidate.actionId as StableExecutionIdentityFields["actionId"],
    eventKey: candidate.eventKey as StableExecutionIdentityFields["eventKey"],
    nfTaskId: candidate.nfTaskId as StableExecutionIdentityFields["nfTaskId"],
    runGeneration: candidate.runGeneration,
  };
  return stable as StableExecutionIdentity;
}

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
 * Compares two stable execution identities. Claim fence is coordination state,
 * not part of effect identity, and therefore cannot influence this comparison.
 */
export function sameStableExecutionIdentity(
  left: StableExecutionIdentity,
  right: StableExecutionIdentity,
): boolean {
  return left.programId === right.programId
    && left.planId === right.planId
    && left.planRevision === right.planRevision
    && left.actionId === right.actionId
    && left.eventKey === right.eventKey
    && left.nfTaskId === right.nfTaskId
    && left.runGeneration === right.runGeneration;
}
