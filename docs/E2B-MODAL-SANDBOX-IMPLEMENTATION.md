# E2B and Modal sandbox implementation

Status: implemented behind the workspace-controller provider contract for the
durable-provider compatibility path; automated conformance is green. Live cloud
qualification is pending provider credentials, a published image/template, and
a public governed egress endpoint. The lightweight Cowork contract is defined
separately in [COWORK_E2B_ACP_PLAN.md](COWORK_E2B_ACP_PLAN.md).

## Decision

ONEComputer now supports four controller drivers:

- `kasm-local`: durable local Docker/KasmVNC workspaces.
- `kasm`: Kasm Developer API sessions.
- `e2b`: Firecracker microVM sandboxes through the official E2B TypeScript SDK
  for the existing durable-provider compatibility path.
- `modal`: gVisor sandboxes through the official Modal JavaScript SDK.

The existing E2B/Modal adapter tests cover the reviewed workspace contract. They
do **not** define Cowork: Cowork uses a separate minimal image/profile with no
KasmVNC, no desktop launch, and application-scoped browser/document capture.
Kasm remains the full Computer visual surface.

## Contract parity

| Capability | Kasm local | E2B | Modal |
|---|---:|---:|---:|
| Create, status, open, destroy | Yes | Yes | Yes |
| Retry-safe create/destroy | Yes | Yes, workspace metadata | Yes, named sandbox |
| Persistent `/home/kasm-user` | Docker volume | E2B Volume | Modal Volume |
| Explicit storage purge | Yes | Yes | Yes |
| Signed policy projection | Yes | Yes | Yes |
| Scoped model/control grants | Yes | Yes | Yes |
| Restricted/full-web policy proxy | Local sidecar | External TLS proxy | External TLS proxy |
| Live egress grant rotation | Yes | Yes | Yes |
| Native provider egress backstop | Docker networks | E2B `allowOut` | Modal domain allowlist |
| Full desktop/VCR | Private relay | Computer-only compatibility path | Computer-only compatibility path |
| Clipboard policy | Yes | Yes | Yes |
| Idle suspension | Container stop | Firecracker pause/auto-resume | Timeout/recreate |
| Nested KVM/Cowork | Optional local KVM | No | No |

Nested KVM is an explicit routing constraint, not a silently degraded feature.
Cowork sessions do not remain on a Kasm-capable node. They use the
`cowork-e2b-ephemeral-v1` profile and are parity targets for ACP, browser
evidence, policy, egress, artifacts, budgets, and cleanup—not desktop login,
clipboard, or durable office state.

## Security behavior

The managed drivers fail closed unless all of the following are true:

1. The signed runtime policy and verification key set are present.
2. Model and Control routes are credential-free, provider-reachable HTTPS
   URLs. Loopback, Docker DNS names, `.local`, and private IPv4 routes are
   rejected.
3. A public TLS egress proxy origin is configured. It receives the
   workspace-bound signed grant as proxy authentication and remains the exact
   HTTP/HTTPS policy authority.
4. Provider-native egress permits only that proxy and the signed model/Control
   hosts. It is a second isolation layer, not the policy authority.
5. Credentials are injected through E2B's sandbox environment or a Modal
   ephemeral Secret. They are never written to the persistent workspace.

The workspace image copies the proxy grant into a root-only `/run` file, then
replaces all descendant proxy variables with the loopback broker address.
Policy updates replace that file through the provider filesystem API and
restart the broker without placing the new grant in a shell command. This also
terminates existing proxy tunnels so a narrowed policy takes effect.

Modal issues a short-lived Sandbox Connect Token for port 6901 and places it in
the provider-supported query parameter. E2B's traffic token is header-only and
cannot be supplied by a browser navigation, so E2B keeps the provider URL
reachable but enables KasmVNC HTTPS Basic Authentication with a random
per-sandbox password. Controller logs redact launch URLs.

## Provisioning prerequisites

The following resources must exist before a real qualification run:

1. Publish `docker/Dockerfile.workspace` as a `linux/amd64` OCI image pinned by
   digest. Modal consumes this digest directly.
2. Build the E2B template from that exact image:

   ```bash
   ONECOMPUTER_WORKSPACE_IMAGE_REF=ghcr.io/onecomputer/workspace@sha256:... \
   E2B_TEMPLATE_NAME=onecomputer-workspace:qualification-2026-08-01 \
   E2B_API_KEY=... \
   npm run sandbox:e2b:template
   ```

   Store the returned template identifier as `E2B_TEMPLATE_ID` and retain the
   build identifier in the release record. Template names must carry an
   immutable tag; do not qualify a mutable `default` tag.
3. Provision a provider-reachable HTTPS model gateway and Control route. The
   current Docker-only `litellm:4000` and `onecomputer-control` routes are
   intentionally rejected.
4. Provision a TLS endpoint for the ONEComputer egress proxy. It must validate
   the workspace grant and enforce the exact signed security-group revision.
   Configure its origin in `MANAGED_SANDBOX_EGRESS_PROXY_URL_TEMPLATE`.
5. Set E2B or Modal credentials only in the workspace-controller secret store:
   `E2B_API_KEY`, or `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`.
6. Confirm E2B/Modal quotas for four CPUs, 8 GiB image builds, 4 GiB runtime
   memory, one persistent volume per workspace, one-hour default runtime, and
   the expected concurrent-conversation count.

## Qualification gates

Automated tests cover policy/grant projection, provider network controls,
persistent volumes and purge, authenticated launch generation, route rejection,
idempotency, live egress rotation, and secret non-disclosure.

A provider is production-qualified only after a live run proves:

- cold create and retry of the same create;
- browser launch, KasmVNC WebSocket, clipboard directions, and VCR capture;
- Chrome/Firefox browsing through restricted and full-web policies;
- live allow-to-deny egress change with the existing tunnel terminated;
- Claude/Codex/Hermes chat streaming through the scoped public gateway;
- office document manipulation and persistent state after destroy/recreate;
- explicit storage purge;
- provider pause/timeout/recovery behavior;
- zero secrets in controller, provider, workspace, and proxy logs.

The live gate cannot be executed from a developer machine with only local
Docker routes. That is an infrastructure prerequisite, not a reason to weaken
the route or egress checks.
