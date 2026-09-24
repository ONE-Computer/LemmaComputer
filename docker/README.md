# Docker files

**For local use, run `npm run compose:up` from the repository root.**
First initialize your checkout using the [setup workflow](../docs/guides/development-workflow.md).
The command renders service configuration, builds the application images, and
starts the root [`compose.yaml`](../compose.yaml). You do not choose among Dockerfiles.

| Task | Command |
| --- | --- |
| Check configuration without starting containers | `npm run compose:config` |
| Start or resume this checkout's application stack | `npm run compose:up` |
| Build the desktop image before creating a workspace | `npm run image:workspace` |
| Stop the stack, retaining data | `npm run compose:down` |

## Why five Dockerfiles?

Each file builds a different image used by the same product:

| Recipe | What it builds |
| --- | --- |
| [Dockerfile.services](Dockerfile.services) | One shared Node.js image for Web, Control, ingress, controller, brokers, proxies, scheduler, and migration jobs. Compose supplies each process's command. |
| [Dockerfile.litellm](Dockerfile.litellm) | The model/MCP gateway with our egress and catalog adapters. |
| [Dockerfile.ms365-mcp](Dockerfile.ms365-mcp) | The private Microsoft 365 tool server and its separate dependencies. |
| [Dockerfile.openvtc-consent](Dockerfile.openvtc-consent) | The Rust approval-protocol service. |
| [Dockerfile.workspace](Dockerfile.workspace) | The managed Linux desktop with applications and AI agents. The workspace controller starts individual containers from this image. |

The first four build through `compose:up`. The desktop builds separately through
`image:workspace`; its applications are installed at build time, while policy
controls which applications a workspace may use. PostgreSQL uses an upstream
image, so it needs no Dockerfile here.

## Test stacks and production

[`qualification/compose.oauth.yaml`](qualification/compose.oauth.yaml) and
[`qualification/compose.providers.yaml`](qualification/compose.providers.yaml)
are isolated integration-test stacks. Run them through `npm run qualify:oauth`
and `npm run qualify:providers`; the runners allocate their own configuration
and clean up their test resources. They are not application startup options.

For remote workspace-node tests, use the [remote qualifier](../docs/guides/development-workflow.md#remote-workspace-node-and-cowork-qualification).
It generates its own temporary Compose definitions. For hosted production, use
the [AWS go-live guide](../docs/guides/aws-go-live.md); there is no hosted Compose overlay.
