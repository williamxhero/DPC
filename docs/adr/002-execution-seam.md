# ADR-002: Lease-oriented execution seam

- Status: Accepted
- Date: 2026-11-14

## Context

Issue #10 introduced a combined durable Adapter, but the Core still normalized it into the legacy `ActionLedger` and `ClaimAuthority` roles. Atomic receipt methods consequently accepted a caller-supplied claim authority even though PostgreSQL requires that authority to be the same Adapter instance that owns the transaction.

The durable behavior is correct, but the public seam makes the caller understand an implementation split that the durable Adapter must not have.

## Decision

Add a Core-facing `ExecutionStore` interface and an `ExecutionLease` value. The store owns acquiring, validating, and releasing the lease, as well as starting execution and writing receipts. Core-facing receipt methods receive the lease and never receive a separate `ClaimAuthority`.

`DpcCore` stores one normalized `ExecutionStore` dependency. The existing `{ ledger, claims }` constructor form remains supported through a private compatibility Adapter, so older non-durable implementations do not need an immediate migration.

The existing `ActionLedger` and `ClaimAuthority` interfaces and methods remain available as compatibility surface. They are not the primary dependency seam used by the durable Core path.

Operational reads are narrower capabilities: receipt history, outbox inspection, and reconciliation discovery may be implemented by the same durable Adapter but are not required by Core dispatch/recovery.

## Consequences

- Claim fencing and atomic receipt/lifecycle/outbox transitions have better locality inside the durable Adapter.
- `DpcCore` no longer needs to know that the durable implementation is composed of ledger and claim roles.
- No PostgreSQL schema migration is required; `lease_until` and claim fences already exist.
- The compatibility Adapter adds a small amount of code, but keeps the older construction path stable.
- `ExecutionLease` is an execution coordination capability, not a replacement for the stable `ExecutionIdentity` stored in NF requests and receipts.
- UNKNOWN recovery remains readback-only, and external NF execution remains outside database transactions.
