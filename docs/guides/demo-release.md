# Demo updates and full releases

The demo is a protected operational profile even without GitHub branch protection. Its database, Docker context, `.env`, volumes, and running containers are never used by a development worktree.

## Routine client-demo updates

The `onecomputer-demo` EC2 installation is a persistent client demo using
`worktree` / `development`. Routine application edits do not require production
release qualification. `/opt/onecomputer` remains its deployment location; the
location itself does not make an installation production.

From an initialized task worktree on the computer with Git, Node.js, Docker,
OpenSSH, and the required test tools:

```bash
npm run demo:update -- status --host=ubuntu@demo-host.example
npm run demo:update -- plan --host=ubuntu@demo-host.example
npm run demo:update -- apply --host=ubuntu@demo-host.example
```

Replace `ubuntu@demo-host.example` with your SSH user and host. The host is
supplied through `--host`; no host address is stored in the repository.

`plan` defaults to committed `HEAD`; `--ref=<commit>` can inspect another
candidate. It never builds images or changes the running demo. `apply` requires
that exact candidate checked out in a clean task worktree, runs `verify:quick`,
and runs Playwright when Web files changed. Use
`--browser-test=tests/e2e/<relevant>.spec.ts` (repeatable) to select the relevant
suite; without a selection, all browser tests run for a Web change. Operator
judgment is still required to select meaningful coverage. Existing branch and
worktree development rules continue to apply.

The persisted host root, Compose project and Control container identity live in
`config/demo-target.json`. These deliberately preserve the existing demo names;
changing them is a state handover, not a routine update.

SSH uses strict host-key checking. On Linux the existing default key works;
`--identity=/absolute/path/to/key` selects a different key. A candidate and its
baseline source archive are transferred, **never the local environment**. The
host requires Python 3.12+, Docker Compose, outbound HTTPS for its public health
check, and passwordless sudo. Node.js need not be installed on the host. Once this tooling is deployed, Codex
on the EC2 can also run:

```bash
sudo python3 /opt/onecomputer/current/scripts/demo-update-host.py status
# Same safeguards and immediate-previous-release recovery:
sudo python3 /opt/onecomputer/current/scripts/demo-update-host.py rollback
```

The routine path:

1. Resolves the deployed commit and compares its tracked files with the baseline
   Git archive. Manual source drift or a concurrent deployment causes refusal.
2. Allows ordinary Web and Control/channel/scheduler source changes plus
   documentation and tests. Schema, dependency, Compose, environment-contract,
   authentication/provider, shared-package and workspace-runtime changes are
   conservatively refused. The `blocked` list identifies paths requiring a full
   release; there is no force/skip switch. Source classification is a guard, not
   a substitute for reviewing data-format compatibility and security impact.
3. Builds only the shared Node application image when needed, from a pristine
   source archive without the server `.env` or service secrets. Metadata-only
   updates need no build or container restart. Existing workspace, LiteLLM and
   connector images are retained.
4. Stages `/opt/onecomputer/releases/<commit>`, copies the existing server `.env`
   **byte-for-byte**, retains its runtime projections and operator overrides,
   and writes a separate Compose image override. It never runs `env:init` or
   `env:update`, generates credentials, or silently supplies new environment
   variables. Environment-contract changes use the reviewed full release path.
5. Verifies that the resolved Compose model differs only in application images
   and release-directory paths. It starts the nine shared Node application
   services with `--no-deps --no-build --pull never`; it runs no migration/init
   jobs, restarts no database or existing workspace container, and removes no
   containers, volumes, images, snapshots, or databases.
6. Checks Compose health, public product health, environment equality and
   container/volume continuity before switching `current`. The deployment
   record is `demo-update.json`; `compose.demo-update.json` pins the exact local
   image ID. Retain these files and the previous release/image.

A shared Node image means even a Web-only edit currently restarts the Node
application services. Brief application interruption is possible. The generic
health check does not prove an authenticated chat, provider or connector flow;
exercise the changed demo flow after deployment. Do not edit the active archive
with Codex and expect Docker to use those edits. Codex on the EC2 can inspect the
installation and invoke the host tool, but development still belongs in a task
worktree. Do not use plain `compose:up` on this managed deployment: it would omit
recorded operator/image overrides and can run migration dependencies.

### Rollback and interrupted updates

```bash
npm run demo:update -- rollback --host=ubuntu@demo-host.example
```

Rollback restores the immediately preceding application's images and directory,
using its recorded Compose files. It never restores a database or stale secrets.
It refuses rollback if source, configuration, runtime projections, or `.env`
changed since deployment. Failure during a cutover automatically attempts this
application rollback. A persistent `.demo-update-pending.json` journal identifies
an interrupted cutover; `status` reports it and `rollback` recovers it before
another update. Inspect a failed staged release rather than overwriting it.

Database transactions made by users or by application code are not undone by
application rollback. Changes that require data transformation must use the full
release procedure. Keep prior local image IDs available; global Docker pruning
can destroy the rollback path. If rollback health fails, the journal remains
for operator recovery; do not report successful rollback.

### Snapshots and retained settings

Routine updates create **no EBS snapshot and no database dump**. They reuse the
existing EBS storage and Docker volumes and retain the previous application
image instead. Existing snapshots/backups are not deleted by this workflow.
This removes snapshot creation/waiting from routine updates, but does not remove
storage charges for backups that already exist. Periodic data backups and their
retention are a separate operational decision.

For schema/data-rewriting changes, use a coordinated logical backup and the
migration checks below. Host/disk replacement or destructive changes may also
need an EBS snapshot and a restore plan. A snapshot is not required merely
because application code changed.

## Full release path

Use the remaining procedure for production qualification or changes refused by
the routine planner. Preserve existing server environment values; review and
add only genuinely new required settings. Never replace the deployed `.env`
with a developer environment or regenerate its encryption/signing credentials.

### Full-release topology

- Reserve Docker context `lemmacomputer-demo` for the demo host/stack.
- Keep its secrets outside the repository and never copy them into a worktree.
- Deploy an immutable Git tag and image digest. `release:tag` generates a `demo-<date>-<sha>`
  name by default; `--tag=` accepts any other immutable name, such as a `v<semver>` milestone. Do not run the demo from a dirty checkout, issue branch, or moving `main` filesystem.
- Back up the Control PostgreSQL database, LiteLLM database, workspace volumes, secret versions, and image digests as one restore set.

### Full candidate qualification

Usually release from a clean, already-pushed `main`. A temporary `release/*` branch is also allowed when the demo needs stabilization while development continues.

```bash
git pull --ff-only
npm run verify:release
npm run release:tag
npm run release:tag -- --push
```

The first command performs the local release checks and records
`.artifacts/release-verification/<sha>.json`, including the built content digest
and any repository digest for the control runtime, OpenVTC consent, Microsoft
365 MCP, and workspace images. Retain that checksummed attestation with the
release evidence. The preview command validates the candidate and prints the
tag without changing GitHub. The final command pushes only the new immutable
tag; it never advances a branch.

The release gate qualifies managed-provider configuration and OAuth renewal,
runs quick and database verification, builds the workspace image, starts an
isolated Compose stack, checks the product origin, and creates, observes, and
destroys a real Hermes workspace. A healthy control stack without a durable
workspace readiness marker is not a releasable candidate.

The workspace smoke creates its own disposable organization and owner using
the current onboarding store API; it does not require a bootstrap user or real
customer credentials. Its Chrome selection requires the installed
[Electron sandbox profile](operations.md#workspace-node-runtime) and
`LEMMACOMPUTER_KASM_LOCAL_ELECTRON_SANDBOX_ENABLED=true` in the qualification
worktree. Hermes runtime readiness is independent of connector availability;
the provider, OAuth, and Microsoft 365 gates qualify those separate contracts.

Promote each recorded first-party build to the deployment registry, record its
resulting repository digest, and set the four image variables to those exact
`repository@sha256:<digest>` references. The deployment-profile preflight
rejects mutable tags whenever production runtime is selected; hosted always
requires production runtime. Deploy the exact Git tag and image digests.
Creating a newer tag is the only way to release a newer commit. Never move or
reuse an existing demo tag.

## Database promotion

1. Confirm the candidate migration manifest and review every new migration for locks, runtime, tenant scope, and rollback compatibility.
2. Capture and restore-test a coordinated backup before any destructive or data-rewriting migration.
3. Run the one-shot migration job once. Do not start new application containers until it succeeds.
4. Confirm the ledger count/checksums and application schema compatibility.
5. Start containers pinned to the promoted tag/digests and run health plus the demo-critical sign-in, workspace, chat, approval, and connector smoke tests.

Application startup never performs a migration. If the migration job fails, retain the previous application deployment, inspect the transaction error, and restore only if an external/nontransactional operation changed state.


## Managed-provider cutover

Use this procedure when promoting the release that replaces static OpenAI and
Anthropic, GLM, and Bedrock routes with Provider settings:

1. Capture a restore-tested, coordinated snapshot of Control PostgreSQL,
   LiteLLM PostgreSQL, workspace volumes, image digests, and the stable
   `LEMMACOMPUTER_LITELLM_SALT_KEY` and
   `LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET` values.
2. Stop active demo workspaces. Their existing scoped model grants are
   intentionally not reused across the route replacement.
3. Run the normal one-shot Control migration, deploy the promoted image and
   static configuration, and restart LiteLLM and Control. Do not preserve the
   retired OpenAI, Anthropic, or GLM static YAML routes.
4. Remove the retired provider-key values from the demo environment only after
   the new stack is healthy. `npm run env:check` reports their names without
   printing values; `env:update` intentionally preserves them.
5. Sign in as a demo administrator, open **AI control plane → Models &
   providers**, add a key for every provider referenced by the demo policy,
   choose its approved models, and run the in-product route test. A
   `PROVIDER_STATIC_CUTOVER_REQUIRED` response means an old static route is
   still present; remove it and restart LiteLLM.
6. Configure complete Pricing, publish the immutable Model routes mapping, and
   verify the demo Team policy and rollout before creating a workspace.
7. Create or restart a workspace and run one harmless prompt through every
   demo-critical model alias. Disabling or deleting a provider must revoke
   affected workspace grants and require a restart.

Rollback is a coordinated restore of both databases and the matching LiteLLM
encryption secrets before starting the older image. Do not roll back the image
alone: it may not understand the managed model records or encrypted credential
state.
## Rollback

Application rollback is permitted only while the previous version is compatible with the expanded schema. Roll back images by immutable digest/tag; do not reverse migration files. After a contract migration crosses the documented irreversible point, recovery is restore plus forward repair, not an ad-hoc down migration.
