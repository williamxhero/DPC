import type {
  ActionLifecycle,
  BusinessStatus,
  ExecutionIdentity,
  ExecutionRecord,
  Receipt,
} from "./types.js";
import {
  sameExecutionIdentity,
  sameStableExecutionIdentity,
  toStableExecutionIdentity,
} from "./identity.js";
import { StaleWriteError } from "./types.js";

/**
 * The only receipt transitions currently owned by the execution lifecycle.
 * Persistence and claim validation remain outside this policy module.
 */
export type ReceiptTransitionKind = "FIRST_APPEND" | "UNKNOWN_REPLACEMENT";

export interface ReceiptTransitionRequest {
  readonly kind: ReceiptTransitionKind;
  readonly execution: Pick<ExecutionRecord, "identity" | "receipt">;
  readonly expectedIdentity?: ExecutionIdentity;
  readonly receipt: Receipt;
}

export interface ReceiptTransitionResult {
  readonly lifecycle: ActionLifecycle;
}

const ACTION_LIFECYCLE_BY_BUSINESS_STATUS: Readonly<Record<BusinessStatus, ActionLifecycle>> = {
  CONTINUE: "STARTED",
  COMPLETED: "COMPLETED",
  WAIT_EXTERNAL: "WAITING",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN",
};

/**
 * Map a business interpretation to the action lifecycle persisted by stores.
 */
export function mapBusinessStatusToActionLifecycle(status: BusinessStatus): ActionLifecycle {
  return ACTION_LIFECYCLE_BY_BUSINESS_STATUS[status];
}

/**
 * Validate a receipt transition and return the lifecycle pointer that stores
 * must persist. This policy deliberately has no persistence or claim side
 * effects: adapters perform those operations in their existing transactions.
 */
export function evaluateReceiptTransition(
  request: ReceiptTransitionRequest,
): ReceiptTransitionResult {
  if (request.kind === "FIRST_APPEND") {
    if (request.execution.receipt) {
      throw new StaleWriteError(`Receipt already exists: ${request.receipt.identity.eventKey}`);
    }
    if (!sameExecutionIdentity(request.execution.identity, request.receipt.identity)) {
      throw new StaleWriteError(`Receipt identity is stale: ${request.receipt.identity.eventKey}`);
    }
    return { lifecycle: mapBusinessStatusToActionLifecycle(request.receipt.businessStatus) };
  }

  const expectedIdentity = request.expectedIdentity;
  const currentReceipt = request.execution.receipt;
  if (!expectedIdentity
    || !currentReceipt
    || currentReceipt.businessStatus !== "UNKNOWN") {
    throw new StaleWriteError(`Execution is not recoverable: ${expectedIdentity?.eventKey ?? request.receipt.identity.eventKey}`);
  }

  if (!sameExecutionIdentity(request.execution.identity, expectedIdentity)) {
    throw new StaleWriteError(`Recovery identity is stale: ${expectedIdentity.eventKey}`);
  }
  if (!sameStableExecutionIdentity(
    toStableExecutionIdentity(currentReceipt.identity),
    toStableExecutionIdentity(expectedIdentity),
  )) {
    throw new StaleWriteError(`Recovery receipt identity is stale: ${expectedIdentity.eventKey}`);
  }
  if (!sameStableExecutionIdentity(
    toStableExecutionIdentity(expectedIdentity),
    toStableExecutionIdentity(request.receipt.identity),
  )) {
    throw new StaleWriteError(`Recovery receipt identity is stale: ${expectedIdentity.eventKey}`);
  }

  return { lifecycle: mapBusinessStatusToActionLifecycle(request.receipt.businessStatus) };
}
