# E2B preflight evidence — 2026-08-01

This is a read-only account preflight for the live ONEComputer Cowork E2B
qualification gate. The temporary API credential was supplied out-of-band and
was not written to this repository, an environment file, or this evidence.

## Result

Command:

```text
E2B_API_KEY=… npm run preflight:e2b
```

Observed response:

```json
{
  "e2bApi": "reachable",
  "templateCount": 0,
  "configuredTemplate": null,
  "configuredTemplateState": null,
  "ready": false
}
```

The preflight also reported all seven governed qualification routes as
unconfigured:

- `ONECOMPUTER_CONTROL_URL`
- `ONECOMPUTER_PROXY_TOKEN`
- `ONECOMPUTER_SESSION_COOKIE`
- `ONECOMPUTER_CONTROLLER_URL`
- `ONECOMPUTER_CONTROLLER_INTERNAL_TOKEN`
- `ONECOMPUTER_E2B_DENY_HOST`
- `MANAGED_SANDBOX_EGRESS_PROXY_URL_TEMPLATE`

No sandbox or template build was created. A generic public image would not be
valid evidence; the next artifact must be the immutable **minimal Cowork**
image containing the pinned ACP runtimes, Playwright/browser capture, gateway,
policy, and artifact hooks. The durable Kasm workspace image is not a
substitute. The next authorized provisioning step is to publish that Cowork
image and set the governed routes before running `npm run qualify:e2b:cowork`.

This result is an infrastructure prerequisite failure, not an application
test failure. It does not authorize bypassing the live gate with fixtures.

## Durable Computer image build attempt

The actual multi-stage `docker/Dockerfile.workspace` was then built locally
with the pinned `linux/amd64` target. Docker downloaded the large Kasm base
layers, but BuildKit failed before producing an image:

```text
mount callback failed ... input/output error
unable to sync new file ... Input/output error
failed to compute cache key ... metadata_v2.db: input/output error
```

After the failure, Docker Desktop reported that it was unable to start and the
macOS data volume had approximately 136 MiB free. No image digest or E2B
template ID exists, and no E2B sandbox was created. The user then explicitly
authorized removal of Docker images/cache and Podman state. Docker Desktop was
stopped and its exact VM data directory was removed; the Podman machine and
storage/config directories were removed as well. This recovered approximately
23 GiB on the host while preserving repositories, research, and application
data outside those container stores. A subsequent amd64 retry reached the
Hermes build stage but failed again with a Docker BuildKit metadata I/O error
after exhausting the Docker VM. The next build must use a remote/relocated
builder or a deliberately bounded local cache; no image digest or E2B template
ID exists yet.

## Repeat preflight after temporary credential rotation

After the user supplied a replacement temporary R&D credential, the key was
stored only in the ignored, mode-0600 local file `.env.e2b.local`. A second
non-mutating preflight reached the E2B API successfully and again reported
`templateCount: 0`; no sandbox, template, or provider state was created.
