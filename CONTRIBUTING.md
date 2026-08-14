# Contributing to LemmaComputer

Thank you for helping improve LemmaComputer. This repository contains
security-sensitive control-plane, credential, sandbox, and consent code, so
changes should be small enough to review and explicit about the trust boundary
they affect.

## Development setup

Start with the canonical [development workflow](docs/guides/development-workflow.md).
It covers a fresh clone, the required task worktree, agent bootstrap, host
support, environment ownership, and verification gates. Do not develop directly
in the primary `main` checkout.

From an initialized task worktree:

```bash
npm run dev:doctor
npm run verify:quick
```

For a complete local product instance, follow the ordered
[local deployment runbook](docs/guides/local-deployment.md). `npm run worktree:init`
already creates the worktree's `.env`; do not replace it with another
checkout's environment.

Build the managed workspace image only when working on its packaged software or
runtime:

```bash
npm run image:workspace
```

## Pull requests

Describe:

- the user or operator problem;
- the services and trust boundaries affected;
- new credentials, network routes, scopes, or persisted data;
- compatibility or migration behavior;
- how the failure path remains closed;
- tests and manual verification performed.

Keep generated credentials, provider keys, OAuth tokens, database dumps, logs,
and workspace home data out of commits.

## Code and contract conventions

- Put shared wire schemas and stable identifiers in
  `packages/contracts`.
- Keep policy and normalization decisions pure where possible.
- Keep HTTP handlers thin and derive identity from authentication, never from
  client-supplied ownership fields.
- Use append-only numbered PostgreSQL migrations.
- Prefer stable policy aliases over provider-specific deployment names.
- Redact bodies, tokens, tool arguments, launch URLs, and OAuth callbacks.
- Pin runtime dependencies and downloaded workspace artifacts.
- Update technical documentation when a service contract or extension path
  changes.

See [Extending LemmaComputer](docs/guides/extending.md) for component-specific
checklists.

## Tests

Every change should keep the full suite passing:

```bash
npm run build
npm test
```

Boundary changes should add negative coverage for missing authentication,
cross-tenant access, signature alteration, expiry, replay, malformed schemas,
and dependency outages as applicable.

Do not make real provider credentials a prerequisite for the default unit test
suite. Put live integration checks behind an explicit operator action and
ensure their output contains no secrets or protected content.

## Reporting vulnerabilities

Do not open a public issue for a suspected vulnerability. Follow
[the security policy](docs/SECURITY.md).
