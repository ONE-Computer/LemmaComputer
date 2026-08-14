# Database migrations

Schema changes are an explicit deployment step, not an application-startup side effect. `control-api` refuses to start when the database is uninitialized, behind, unknown, or has a changed historical checksum. Compose runs the one-shot `db-migrate` service after PostgreSQL is healthy and starts `control-api` only after that job succeeds.

## Ledger and serialization

`lemmacomputer_schema_migrations` records each migration ID, name, SHA-256 checksum, declared dependencies, application time, duration, app version, and installation kind. The runner holds a PostgreSQL advisory lock for the entire plan. Each migration and ledger insert share one transaction with bounded lock and statement timeouts. A failed transaction leaves no applied ledger row; a second successful run applies zero migrations.

Existing pre-ledger installations are not blindly marked current. The first runner transaction verifies the complete migration-028 table set, recent critical columns, removed legacy objects, and the `security_group_id NOT NULL` invariant. Only the immutable IDs `001` through `028` of an exact compatible shape receive 28 `verified-legacy-baseline` ledger rows. Later migrations, including generated ULID migrations, are never baselined: after that transaction, the same locked run validates dependencies and executes their SQL normally. Any discrepancy rolls back ledger creation and reports every observed mismatch.

## Creating a migration

```bash
npm run db:migration:new -- add_organization_slug
```

The generator creates a lexically sortable ULID filename and metadata:

```sql
-- id: 01...
-- depends-on: <current-tip-id>
```

Keep the file forward-only. Once a migration reaches any shared, demo, hosted, or customer-managed installation, its ID, filename, SQL, checksum, and dependencies are immutable. A correction is a new migration.

## Expand, migrate, contract

Use at least two releases for incompatible changes:

1. Expand: add nullable columns/tables/indexes; deploy code that reads both old and new forms and writes the new form safely.
2. Migrate: run a resumable, observable data backfill outside the schema transaction; verify counts and tenant boundaries.
3. Contract: after rollback compatibility expires, remove old reads and only then drop obsolete schema in a dedicated release.

Before a contraction, record expected row count, lock behavior, backup identifier, restore command, rollback application SHA, and the irreversible point. Prefer `CREATE INDEX CONCURRENTLY` as a separately managed operation when table size makes a transactional build unsafe.

## Required tests

`npm run verify:db` owns an isolated PostgreSQL 18 container and proves:

- all migrations apply to an empty database;
- the ledger contains the complete ordered plan;
- a second run is a no-op;
- two simultaneous runners serialize and apply each migration once;
- a raw legacy migration-028 schema receives exactly 28 baseline rows, then every later migration is executed normally;
- an incompatible legacy schema is rejected without creating the ledger;
- changed historical SQL/checksum and invalid forward dependencies are rejected.

Feature-specific PostgreSQL tests may use additional databases inside the disposable test container. A skipped required database test is not success.

## Deployment profiles

Hosted and customer-managed installations use the identical runner and migration stream. `installation_kind` is operational evidence, not a schema fork. Hosted migrations are performed tenant-safe even when a table is physically shared; customer-managed installations retain tenant keys so backups, restores, support tooling, and future profile changes use the same contracts.
