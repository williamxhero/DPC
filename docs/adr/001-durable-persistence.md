# ADR-001: PostgreSQL durable execution store

- Status: Accepted
- Date: 2026-11-14

## Context

DPC must retain execution identities, claims, receipts, transactional outbox events, wake state, handoffs, inbox occurrences, and reconciliation facts across process restarts. External NF invocation must remain outside database transactions, while the receipt/lifecycle/outbox transition must commit atomically.

## Decision

Use PostgreSQL as the first durable execution adapter behind `DurableExecutionStore`. `PostgresExecutionStore` owns the transaction boundary for claim-aware receipt writes, appends receipts to `dpc_action_receipts`, updates the execution's current-receipt pointer, inserts a deduplicated outbox event, and releases the claim in one transaction. Core receives one combined durable store for this path; legacy independent ledger/claim dependencies remain available only for older non-durable adapters.

Migrations are repeat-safe and run inside the store transaction. Each transaction applies configurable local `lock_timeout` and `statement_timeout` values. The initial schema records version 1 in `dpc_schema_migrations` and uses additive `IF NOT EXISTS` changes for claim identity columns.

Inbox processing accepts a structural transaction client so an existing execution transaction can include the conditional inbox status update. The in-memory adapter remains the reference behavior adapter and retains receipt history and pending outbox observations for contract tests.

## Consequences

PostgreSQL remains an adapter, not a replacement for GitHub plan authority or an external scheduler. Production database operations, backup, failover, and capacity planning remain outside this ADR. PostgreSQL integration tests still require a disposable database supplied through `DPC_POSTGRES_URL`.
