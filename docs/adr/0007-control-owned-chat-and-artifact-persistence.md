# ADR 0007: Control-owned chat and artifact persistence

- Status: Accepted
- Date: 2026-08-16
- Issue: [#80](https://github.com/ONE-Computer/LemmaComputer/issues/80)

## Decision

Control PostgreSQL is the system of record for conversations, normalized user and assistant messages, effective-agent runs, vendor session bindings, artifact metadata, revisions, and message-to-artifact bindings. Artifact bytes use the `ArtifactStore` interface: a Control-owned filesystem for worktree and ordinary customer-managed deployments, or an S3-compatible bucket for hosted deployments.

Workspace files are execution caches only. The native-agent runtime receives normalized history from Control and may temporarily stage attachments and Outbox results, but it exposes no session-list, session-create, or transcript-read API and does not write `structured-sessions.json`.

One deployment uses one configured artifact store. Tenant isolation is enforced in PostgreSQL authorization and in opaque object locators:

```text
tenants/<tenant-id>/artifacts/<artifact-id>/revisions/<revision-id>/source
```

Tenant, user, workspace, and filenames are metadata, never authorization derived from an object key. Browser and channel downloads resolve an opaque artifact and revision through Control before reading bytes.

Conversations are unified across agents. Each run records its effective agent, policy snapshot, workspace node, and access generation. Vendor session IDs remain per conversation and agent. Continuing an existing transcript with another agent creates an explicit fork and copies normalized history; it never reuses the prior vendor session.

Artifact ingestion is stage, verify, finalize, then metadata commit. Before object promotion, Control records the intended opaque artifact ID, revision ID, and final locator on the staging row. Control verifies byte length and SHA-256 and, for hosted deployments, requires the request's workspace node and access generation to match persisted placement. If Control stops during promotion, reconciliation deletes both the staging locator and any partially promoted final locator before marking the upload abandoned; deletion failures remain retryable.

## Security and operations

- Every customer-owned row carries `tenant_id`; user reads also require the owning subject.
- Hosted storage requires S3 with explicit server-side encryption on every write: SSE-S3 by default or SSE-KMS when a KMS key ID is configured. A custom S3 endpoint is rejected in hosted configuration.
- Filesystem storage rejects traversal and symlink targets, opens files without following symlinks, and atomically finalizes staged files.
- S3 writes carry checksum metadata and explicitly use SSE-S3, or SSE-KMS when configured.
- Retention state is explicit (`saved`, `temporary`, `legal_hold`, `export`, `staged_delete`, or `purged`). This change creates the lifecycle boundary but does not invent a legal retention duration.
- PostgreSQL and the artifact store must be backed up and restored to a mutually consistent point. Restored metadata without matching bytes, or bytes without committed metadata, fails closed.

## Clean cutover

There is no legacy importer and no dual-write period. Existing `structured-sessions.json` files are unsupported after deployment. Internal or demo data worth keeping must be exported manually before cutover. Old workspace files may be retained temporarily as rollback material and then removed deliberately.

## Qualification

Run `npm run qualify:artifact-store`. It exercises a temporary filesystem root and a disposable, digest-pinned MinIO container with a unique bucket; it does not need AWS credentials or a shared test bucket. Hosted production qualification must separately prove the real bucket policy, workload-role permissions, configured server-side encryption, backup/restore, lifecycle, and alarms.
