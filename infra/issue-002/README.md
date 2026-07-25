# Issue 002 local gateway slice

This stack extends the completed Kasm lifecycle with a pinned LiteLLM data
plane, LiteLLM PostgreSQL, and a private model/MCP fixture. Its running Docker
resources use stable service names such as `onecomputer-web`,
`onecomputer-control-api`, and `onecomputer-litellm`; no branch or issue number
is part of the runtime name.

The database began as disposable qualification storage; Issue 008 moved it to
the named `onecomputer-v4-litellm-postgres-data` volume because per-user OAuth
credentials must survive service replacement and restart. That legacy volume
name is intentionally retained during the runtime-name migration so local
credentials and data are not silently replaced.

The browser reaches only the Web proxy. Control owns the LiteLLM master key and
derives a renewable short-lived key for each persistent workspace. A workspace
key is restricted to
the `onecomputer-assistant` model alias, the `onecomputer_fixture` MCP server,
and its `search_files` tool. The unassigned destructive `delete_file` tool is
used for negative verification.

The workspace network contains LiteLLM but not the fixture or either database.
LiteLLM reaches the fixture over the separate private gateway network.

## Stable workspace ingress

The browser now reaches one fixed edge service on `127.0.0.1:4174`. That
service forwards ordinary HTTP and WebSocket traffic to `onecomputer-web`, and
routes `/workspaces/<workspace-id>/...` to the selected private KasmVNC relay.
The per-workspace relay ports remain loopback-only and are never published
through ngrok, an AWS load balancer, or a Kubernetes ingress.

Control returns the workspace route only after its existing tenant, subject,
and policy checks pass. It replaces the local controller URL with a five-minute
signed launch URL on `ONECOMPUTER_PUBLIC_WEB_URL`. The edge exchanges that
one-time-style launch credential for an HTTP-only, path-scoped session cookie,
then proxies both KasmVNC assets and WebSocket traffic. Browser authorization
headers and application cookies are not forwarded into the sandbox.

`ONECOMPUTER_WORKSPACE_INGRESS_SECRET` should be an independently managed
32-byte-or-longer secret in production. Compose falls back to
`ONECOMPUTER_SESSION_SECRET` only so existing local environments can adopt the
ingress without an immediate secret migration. Launch and session TTLs default
to 300 and 28,800 seconds and can be overridden with
`ONECOMPUTER_WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS` and
`ONECOMPUTER_WORKSPACE_INGRESS_SESSION_TTL_SECONDS`.

The local KasmVNC relay uses a self-signed certificate on its isolated Docker
network, so Compose explicitly sets `WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS` to
`false`. ECS/EKS service targets should use certificates issued by a trusted
private CA and leave verification enabled (the service default).

For the static development tunnel, point ngrok at the fixed ingress:

```bash
ngrok http --domain=YOUR_STATIC_DOMAIN.ngrok-free.dev 4174
```

The same boundary maps to an AWS ALB target or Kubernetes Service in
production. The load balancer discovers only the replicated ingress service;
the signed controller response supplies the session-specific private target.
When `SANDBOX_DRIVER=kasm` returns a Kasm-managed public URL without an internal
ingress target, Control leaves that URL unchanged so the official Kasm proxy
continues to own session routing.

For temporary local administration during this prototype, LiteLLM's Admin UI is
available at `http://127.0.0.1:4000/ui` and linked from ONEComputer's **Gateway**
navigation item. The binding is loopback-only and uses LiteLLM's own login. This
host exposure is a development exception and must be removed or replaced by an
authenticated ONEComputer admin route before production deployment.

Unless overridden with `ONECOMPUTER_LITELLM_UI_USERNAME` and
`ONECOMPUTER_LITELLM_UI_PASSWORD`, the temporary local login is `admin` /
`onecomputer-local-admin`. These development defaults are not production
credentials.

LiteLLM is pinned to `v1.93.0` and OCI index digest
`sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e`.
Its database now requires a dedicated stable `LITELLM_SALT_KEY` supplied by
`ONECOMPUTER_LITELLM_SALT_KEY`. The salt and persistent volume are part of the
Issue 008 OAuth custody boundary and are not optional in that deployment.

## Governed operation extension

The same local stack now carries the Gate C fixture flow. `POST
/v1/operations/delete-file` persists an approval-required operation in owned
PostgreSQL before any MCP call. The temporary fixture decision endpoint signs
and verifies a bound decision inside Control, issues one compare-and-swap lease,
and uses a 60-second LiteLLM key limited to `delete_file`. The UI shows the
pending request, local-fixture approve/deny controls, and the durable receipt.

This fixture is not the production approval channel. It exists to prove the
operation binding and exactly-once path before OpenVTC/VTA integration.
