# 0009. Repository interfaces, a file-backed store, PostgreSQL and R2

## Status

Accepted.

## Context

The vertical slice must run end to end without a database or a cloud account.
Production needs relational integrity for the ledger, jobs and keys, plus
full-text and vector search, and it needs large binaries stored outside the
database.

## Decision

- The engine depends only on repository interfaces, defined in
  `packages/database`.
- There are two implementations:
  - a **file-backed store**, for local use and the slice, which writes JSON
    under a git-ignored data directory;
  - **PostgreSQL through drizzle**, for production, with pgvector for search.
- Artifacts use a storage interface in `packages/storage` with two drivers: a
  **local-disk driver**, and **Cloudflare R2 through the S3 API**.
- Large binaries never go into the database; rows reference them by
  `storage_key`.
- The model is in [ARCHITECTURE.md](../ARCHITECTURE.md#data-model). It uses
  normalized columns for what is queried or summed, and JSONB for versioned
  documents.

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| PostgreSQL from day one | It blocks the slice on infrastructure. Tests become slower and need services. |
| SQLite for local use | Would be a second SQL dialect to keep in sync with PostgreSQL. The file store is simpler for the slice's volume. |
| A document database | The ledger needs transactions and constraints, and search needs `tsvector` and pgvector. |
| Binaries in the database | Bloats backups and slows queries. |

## Reason

The interfaces keep the engine runnable anywhere. PostgreSQL covers ledger
integrity and search in a single system, and R2 has no egress fees for serving
renders.

## Trade-offs

- There are two implementations to keep behaviorally equal. Shared contract
  tests run against both.
- The file store is single-node and has no transactions.

## Migration strategy

Drizzle migrations own the schema. A one-off importer moves file-store data
into PostgreSQL. Storage keys are driver-independent, so artifacts move to R2
by copying them.
