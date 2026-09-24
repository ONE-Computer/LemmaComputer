# Repository scripts

Run commands through `npm run …` from the repository root. For first setup,
follow the [setup guide](../docs/guides/development-workflow.md); you do not need
to choose or run individual script files.

| Folder | Purpose | Main commands |
| --- | --- | --- |
| `setup/` | Environment contract, initialization, validation, and service configuration | `env:init`, `env:check`, `env:update`, `env:render` |
| `development/` | Worktree isolation, local safety checks, shutdown, and host setup | `worktree:init`, `dev:doctor`, `compose:down`, `verify:quick` |
| `database/` | Migration creation, explicit legacy backfill, and disposable database verification | `db:migration:new`, `db:backfill:organization-rbac`, `verify:db` |
| `release/` | Demo updates, release verification, attestations, and tags | `demo:update`, `verify:release`, `release:tag` |
| `qualification/` | Focused integration and runtime checks, with their fixtures/helpers | `qualify:*`, `fixtures:office-regression` |
| `benchmark/` | Workspace and browser performance measurements | `benchmark:workspace`, `benchmark:kasm-browser` |

`env:init` and `worktree:init` already generate the local keys and secrets.
The old `key:*` commands have been removed; no separate key-generation step is
needed. Keep an existing installation's secrets when resuming or updating it.

See [Contributing](../CONTRIBUTING.md) for which checks a change requires.
Qualification and benchmark tools are optional tasks with their own runtime
requirements, not steps to run during normal startup. The OpenVTC interop probe
is a manual check against a separately configured consent service.
