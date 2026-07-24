# Issue 010 governed Claude Desktop workspace

Issue 010 replaces the qualification CLI as the primary workspace experience
with Anthropic's supported Claude Desktop Linux client. ONEComputer owns the
sandbox selection and lifecycle; Claude Desktop is a managed client of the
workspace-scoped LiteLLM gateway.

## Packaged software catalog

- Claude Desktop Linux `1.22209.3` (`amd64` Debian package)
- package SHA-256:
  `d427f46ac9233dbc4d8a441a602f09f750b8a5f05d1fc7a00285d7a6ce07655c`
- Claude Code engine `2.1.215` (the version pinned by this Desktop build)
- engine archive SHA-256:
  `7ff9594e53cd89d1af9ceb3c18d3d70be1a5c6d27475e31ee2bed65d748f18c0`
- Firefox ESR `140.12.0esr` (`linux-x86_64`, English US)
- Firefox archive SHA-256:
  `3323ee13ac6fe4877fa2e1f4a3aa6b8009f65a620c7bbca96fe86f1a6f433d92`
- Google Chrome Stable `150.0.7871.186-1` (`amd64` Debian package)
- Chrome package SHA-256:
  `4193e00b6d5d5969ee63f7a69596868f546aa0e8cb077b3e0bf9cc1e2c719d00`
- Hermes Agent `v2026.7.20`, providing Hermes Agent CLI `0.19.0` and Hermes Agent
  Desktop `0.17.0`
- Hermes source archive SHA-256:
  `285f3fc134ff466a90065e1517801a68993733b807158ee8f32aa01613786990`
- Kasm Ubuntu Jammy base:
  `sha256:58b0710b320b99ab7e352342d7ec3a25b09740c523b75d794c5f7476910da580`
- resulting local workspace image is printed by `build-workspace.sh` and pinned
  in the ignored local `.env`.

The reviewed image contains the complete catalog so a saved sandbox can change
its selection without rebuilding. Launchers, executable permissions, loopback
brokers, and agent grants are exposed only for the selected entries. Firefox,
Claude Desktop, and Hermes Agent CLI remain the initial defaults; Chrome, Claude
CLI, and Hermes Agent Desktop are opt-in.

This follows Anthropic's supported Linux and gateway paths:

- <https://code.claude.com/docs/en/desktop-linux>
- <https://code.claude.com/docs/en/llm-gateway-connect>
- <https://claude.com/docs/third-party/claude-desktop/gateway>
- <https://claude.com/docs/third-party/claude-desktop/configuration>

Desktop does not consume Claude Code's user `settings.json`. The image writes
the organization-owned policy to
`/etc/claude-desktop/managed-settings.json` at launch.

The Desktop shell launches its matching Claude Code engine for Chat sessions.
That engine is checksum-pinned and preinstalled in the image, then seeded into
Desktop's generated cache at startup. It is not downloaded from Anthropic at
runtime because the workspace has no direct provider/CDN egress.

## Runtime boundary

Control and policy retain one provider-accurate model alias:

- `onecomputer-claude` -> `anthropic/claude-sonnet-4-6`
- `onecomputer-openai` -> `openai/gpt-5.6-luna`
- `onecomputer-glm` -> `zai/glm-5`

Claude Desktop validates gateway model identifiers before making a request.
For this client only, Control projects the selected policy alias to a
Claude-compatible transport alias:

- `onecomputer-claude` -> `claude-sonnet-4-6`
- `onecomputer-openai` -> `claude-opus-4-6`
- `onecomputer-glm` -> `claude-sonnet-4-5`

Desktop `1.22209.3` requires these transport identifiers to be members of its
built-in Anthropic model catalog; an arbitrary `claude-*` prefix is rejected
before any gateway call. Each catalog-valid identifier maps to the pinned
LiteLLM deployment shown above. LiteLLM key metadata records both names, so
policy and audit surfaces continue to identify the actual selected provider
route rather than treating GLM or OpenAI as Anthropic models.

Only LiteLLM contains provider API keys. Control mints one expiring key bound
to the workspace, agent, user, model alias, policy hash, budget, and limits.
A root-owned loopback broker holds that scoped key and forwards only
`/v1/messages` and `/v1/models`. Claude Desktop receives a meaningless local
broker key. The user process receives no provider key, LiteLLM master key, or
Control credential.

The workspace network is an internal Docker network containing only the
workspace, LiteLLM, and a root-owned loopback broker. Direct provider, Graph,
PostgreSQL, Docker, Control, and OpenVTC routes therefore have no user-process
path. Claude Desktop receives only the policy-scoped Microsoft 365 MCP tools;
the broker submits protected actions to Control and waits for the signed
OpenVTC decision without exposing gateway or provider credentials.

## Managed profile

`claude-desktop-standard-v1`:

- Chat enabled; Code and Cowork disabled.
- Deployment/model chooser disabled.
- Exactly one assigned model alias declared explicitly.
- User MCP, development MCP, extensions, automatic mode, tool search, and
  bundled skills disabled.
- Persistent `/home/kasm-user` volume retained across UI stop/start and service
  restart.
- Claude Desktop auto-starts when it is selected.
- Firefox ESR and Google Chrome appear on the desktop only when selected.
  Enterprise policy locks both browsers to a loopback-only credential broker,
  which authenticates to the external egress proxy sidecar. The sidecar remains
  the enforcement point for default-deny domain, protocol, and port policy.
  In-place updates, telemetry, sync, and saved logins are disabled.
- Claude CLI, Hermes Agent CLI, and Hermes Agent Desktop each receive a distinct
  workspace-scoped identity and root-owned loopback broker when selected.

The Sandbox page persists the approved profile, application, agent, and model
choices per user and grant. Changes are rejected while the workspace is running
and any choice outside the user's immutable policy assignment fails closed.
After a successful save, the UI explains that a restart is required. The saved
configuration is used when that sandbox next launches.

## Build and start

```bash
./infra/issue-010/build-workspace.sh

docker compose \
  --env-file .env \
  -f infra/issue-002/compose.yml \
  -f infra/issue-008/compose.yml \
  up -d --build
```

Set `ONECOMPUTER_WORKSPACE_IMAGE` in the ignored `.env` to the image digest
printed by the build script. Never commit provider keys or workspace grants.
Generate the dedicated workspace-bound Hermes API derivation secret once with:

```bash
npm run key:hermes -- --write-env .env
```

The live qualification record is
`qualification-2026-07-21.md`.
