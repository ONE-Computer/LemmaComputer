# ADR 0001: Local release gates and one product codebase

- Status: accepted
- Date: 2026-07-27

## Context

`main` must remain available for unscheduled demos. The repository intentionally does not rely on GitHub Actions, paid branch protection, or a GitHub Team upgrade. Development must support several agents in parallel worktrees, including concurrent schema work. The product must support ONEComputer-hosted multi-organization SaaS and customer-managed single-tenant installations without security fixes or migrations drifting between editions.

## Decision

Use one codebase and one forward migration stream with explicit `hosted` and `customer-managed` deployment profiles. Preserve tenant scoping in both profiles.

Treat GitHub issue `blocked by` relationships as the parallel scheduler. Each runnable issue receives one branch and isolated worktree. Local bootstrap assigns unique secrets, ports, Compose project/container/network/image names, volumes, and databases.

Replace startup-time replay of every SQL file with an advisory-lock serialized, dependency-aware, checksummed migration ledger. A one-shot deployment job migrates; applications only assert compatibility. Pre-ledger databases are baselined only after structural verification.

Replace hosted CI/protection with three local gates: quick, database, and release. A pre-push hook prevents accidental direct main updates. A promotion command accepts only a clean, recently attested, fast-forward SHA and atomically pushes `main` with an immutable demo tag.

## Consequences

Local enforcement is bypassable, so promotion output and attestations are operational evidence and the release operator remains accountable. Full release qualification costs more local compute than unit tests. Worktree isolation consumes additional Docker volumes and ports. In exchange, demos no longer depend on in-progress branches, schema changes are deterministic, parallel work is safer, and hosted/self-hosted releases cannot silently diverge.

A separate self-hosted repository is rejected for now because it would duplicate fixes, migration history, test qualification, and release coordination. Revisit only with a new ADR and evidence that configuration/interface separation is insufficient.
