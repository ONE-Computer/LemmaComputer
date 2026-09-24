# Demo updates and full releases

**Use this page for the existing `onecomputer-demo` installation or to create
an immutable release candidate.** The demo runs a persistent `worktree` /
`development` stack on EC2; it is not hosted production. Its `.env`, Docker
volumes, workspace homes, and running containers are separate from task
worktrees. Creating a release tag does not deploy AWS infrastructure.

## Routine client-demo updates

Use this for ordinary application or documentation changes that the planner
accepts. From a clean, committed task worktree on a machine with Git, Node.js,
Docker, OpenSSH, and the required test tools:

```bash
npm run demo:update -- status --host=ubuntu@demo-host.example
npm run demo:update -- plan --host=ubuntu@demo-host.example
npm run demo:update -- apply --host=ubuntu@demo-host.example
```

Replace the example SSH target with the actual user and host. `plan` compares
the exact committed candidate with the deployed baseline without changing the
server. `apply` requires that candidate checked out cleanly. It runs
`verify:quick` and, for Web changes, relevant Playwright tests. Use repeated
`--browser-test=tests/ui/<relevant>.spec.ts` options to select meaningful
coverage; without them, a Web change runs all browser tests.

The planner **refuses** schema, dependency, Compose, environment-contract,
authentication/provider, shared-package, and workspace-runtime changes. There
is no force/skip switch; use the full release path for those changes. A routine
update preserves the server `.env` byte-for-byte, uses its existing volumes
and service projections, runs no migration, and retains the previous image and
release directory. A metadata-only update needs no container restart. An
application update restarts shared Node services, even for a Web-only edit, so
expect a brief interruption. Afterward, exercise the changed authenticated
flow; generic health is not enough.

The demo host uses `/opt/onecomputer` and the target identity in
[`config/demo-target.json`](../../config/demo-target.json). Changing those
identities is a separate state handover. Do not run plain `compose:up` on the
managed demo: it omits recorded image/operator overrides and may trigger
migration dependencies. The host needs Python 3.12+, Docker Compose, outbound
HTTPS for its public health check, and passwordless sudo. The update tool uses
strict SSH host-key checking and never transfers a developer `.env`.

### Rollback and interrupted updates

```bash
npm run demo:update -- rollback --host=ubuntu@demo-host.example
```

Rollback restores only the immediately preceding application image and
release directory. It does not undo database writes, restore old secrets, or
replace volumes. It refuses an unexpected environment or source change. If a
cutover is interrupted, `status` reports its pending journal; inspect it and
use the rollback command before another update. The host-side tool can also
run `sudo python3 /opt/onecomputer/current/scripts/demo-update-host.py status`
or `rollback`. Retain the prior image; global Docker pruning can remove the
rollback path.

Routine updates do not create an EBS snapshot or database dump. Periodic
backups and their retention remain a separate operational duty.

## Full release path

Use this for production qualification or any change the routine demo planner
refuses. Start from a clean, already-pushed `main` commit, or a pushed
`release/*` branch when stabilization must continue separately. Preserve all
existing deployed secret values; review only new required settings. Run:

```bash
git pull --ff-only
npm run verify:release
npm run release:tag
npm run release:tag -- --push
```

`verify:release` runs the quick and database gates, provider/OAuth checks,
workspace-image build, isolated Compose health, and a real Hermes workspace
readiness smoke. It writes a checksummed attestation under
`.artifacts/release-verification/<sha>.json`. The first `release:tag` previews
the immutable tag; the final command creates and pushes only that tag. Neither
command moves a branch or deploys a server. Promote the qualified first-party
images to the target registry, record their repository digests, and deploy
only the exact tag and digests through the target's reviewed operator
procedure. For AWS, follow the [go-live path](aws-go-live.md).

The workspace smoke needs the installed
[Electron sandbox profile](operations.md#workspace-node-runtime) and its
qualification-worktree setting when Chrome is selected. A healthy control
stack without workspace readiness is not a qualified release.

## Database promotion and recovery

Before applying a release with migrations, review the manifest for locks,
tenant scope, and rollback compatibility. Capture and restore-test a
coordinated set of all **four logical databases**, workspace homes, artifacts,
matching secret versions, and image digests. Run explicit migration jobs
before starting new application containers; application startup never
migrates. Confirm the migration ledger and schema check, then test sign-in,
workspace, chat, approval, and connector flows on the target environment.
See [database migrations](database-migrations.md) and
[backup and restore](operations.md#backup-and-restore).

Rollback an image only while the previous application remains compatible with
the expanded schema. Do not reverse applied migration files. After an
irreversible contraction or incompatible provider-data change, recovery needs
a coordinated restore and forward repair, not an image-only rollback. Model
provider keys and routes are managed through the product; do not restore
retired static provider YAML or place provider keys in `.env`.
