# Demo release runbook

The demo is a protected operational profile even without GitHub branch protection. Its database, Docker context, `.env`, volumes, and running containers are never used by a development worktree.

## Topology

- Reserve Docker context `lemmacomputer-demo` for the demo host/stack.
- Keep its secrets outside the repository and never copy them into a worktree.
- Deploy an immutable `demo-*` Git tag and image digest. Do not run the demo from a dirty checkout, issue branch, or moving `main` filesystem.
- Back up the Control PostgreSQL database, LiteLLM database, workspace volumes, secret versions, and image digests as one restore set.

## Candidate qualification

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
