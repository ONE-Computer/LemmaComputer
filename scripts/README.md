# Repository tools

Use `npm run …` from the repository root. Start with the
[setup guide](../docs/guides/development-workflow.md).

| Folder | Responsibility |
| --- | --- |
| `setup/` | Generate, validate, and project environment configuration. |
| `development/` | Initialize worktrees, check isolation, manage local Compose and remote workspace development. |
| `database/` | Create migrations and run the explicit organization RBAC backfill. |
| `release/` | Update the demo, verify releases, validate reasoning evidence, and create immutable tags. |

Integration checks live beside their fixtures in `tests/integration/`;
performance tools live in `tests/performance/`. Use [Contributing](../CONTRIBUTING.md)
to select a check. These are not required startup steps.
