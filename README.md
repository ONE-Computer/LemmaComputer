# LemmaComputer

LemmaComputer gives employees persistent AI workspaces while keeping provider
keys, enterprise connector credentials, policy decisions, and protected
actions outside user-controlled sandboxes. One tenant-scoped codebase supports
customer-managed single-tenant installations and LemmaComputer-operated
multi-organization hosting.

Employees use managed desktop applications and Chat. Administrators govern
workspace access, connectors, AI providers, usage, and budgets. Members choose
**Lite**, **Balanced**, or **Pro** model classes; the gateway's
`lemmacomputer-auto` alias is internal and is not a member-facing choice.

## Run locally

The complete reference stack needs Linux x86_64, Node.js 22 or later, Docker
Engine, and Docker Compose v2.30.0 or later. In a **dedicated disposable
clone**:

```bash
git clone https://github.com/ONE-Computer/LemmaComputer.git lemmacomputer-eval
cd lemmacomputer-eval
npm ci
npm run env:init -- --profile=worktree
npm run env:check
npm run compose:up
```

This uses the root `compose.yaml` and selects the required Dockerfiles for you.
See the [Docker file map](docker/README.md) for what each image contains.

Open the URL in the generated `.env`:

```bash
grep '^LEMMACOMPUTER_PUBLIC_WEB_URL=' .env
```

Choose **Create account**, then **Open local verification email** to verify
your account in the browser. No existing admin account or email service is
needed for local evaluation.

To open a desktop, first build its image in the same checkout:

```bash
npm run image:workspace
```

Then choose **Workspace → Create workspace**, leave optional applications and
AI agents unselected, wait for it to become ready, and open the desktop.
The [first-run guide](docs/guides/development-workflow.md#evaluate-a-single-checkout)
explains prerequisites, these steps, and how to stop and resume without losing data.

To use AI, configure a provider and its prices and class mappings through
**AI control plane → Models & routing**, then set the appropriate Team budget
and routing policy. Follow the [model-routing contract](docs/product/model-routing.md)
for the exact readiness and rollout steps.

## Start with your task

| Goal | Read |
| --- | --- |
| Explore the product locally | [Evaluation workflow](docs/guides/development-workflow.md#evaluate-a-single-checkout) |
| Change code or documentation | [Task worktree workflow](docs/guides/development-workflow.md#develop-in-an-isolated-task-worktree) and [Contributing](CONTRIBUTING.md) |
| Update the running demo or make a release | [Demo and release guide](docs/guides/demo-release.md) |
| Plan an AWS deployment | [AWS go-live path](docs/guides/aws-go-live.md) |
| Understand boundaries or services | [Architecture overview](docs/architecture/overview.md) and [service reference](docs/reference/services.md) |
| Find a focused document | [Documentation map](docs/README.md) |

The [development workflow](docs/guides/development-workflow.md) is the setup
authority. Use a disposable evaluation clone to explore the product and an
isolated task worktree to change it. The primary `main` checkout is for
integration.

## How it is organized

- **Workspace ingress** serves the one browser origin and checks workspace
  launch sessions.
- **Web** serves the interface and forwards API calls; **Control** owns
  authentication integration, product authorization, policy, orchestration,
  audit, and routing decisions.
- **Workspace nodes** run isolated desktops. The controller, rather than
  Control, holds the node-local Docker authority.
- **LiteLLM and scoped brokers** route model and connector requests without
  giving provider or enterprise credentials to a user process.
- **PostgreSQL** holds separate product, customer-auth, platform-auth, and
  LiteLLM logical databases. Schema changes use explicit migration jobs.

See the [architecture overview](docs/architecture/overview.md) for trust and
network boundaries, [authentication](docs/architecture/authentication.md) for
identity and organization access, and [deployment profiles](docs/guides/deployment-profiles.md)
for profile-specific behavior. The [service reference](docs/reference/services.md)
identifies the owner of each process and state store.

For changes, use [Contributing](CONTRIBUTING.md) to choose verification
commands and browser suites. The [security policy](docs/SECURITY.md) explains
private vulnerability reporting.
