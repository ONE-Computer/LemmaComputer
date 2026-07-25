# Greenfield V2 polishing plan

Status: `active`

Branch: `mike/greenfield-v2`
Base: `mike/greenfield-v1` at `37b9f50cb7f79481868be5129147fcbad51c4ae6`

## Intent

V2 polishes the accepted greenfield V1 product without weakening its trust
model. It fixes the blocking Kasm clipboard experience, turns the workspace
network boundary into an explicit egress-firewall product capability, adds
Hermes Claw as a policy-selected default agent, makes OpenVTC approval practical
for headless workspaces through a push-capable companion web app, makes policy
projection tamper-evident and externally enforced, and then refines the whole
UI. Issue 011 then replaces duplicated OpenVTC protocol and cryptographic code
with the upstream consent SDK while retaining ONEComputer's exact action-digest
and execution boundary. Issue 012 adds an agent-agnostic channel broker outside
the workspace, with Telegram as its first official adapter and without
projecting the bot token into any agent. The native Hermes, Claude, and Codex
adapter baseline produced by cancelled Issue 009 is retained, while Issue 010
replaces its final-only Chat surface with AI SDK structured streaming. ACP is
explicitly deferred.

The archived V1 plan is historical evidence, not an active issue dependency.
Every V2 issue must inspect the real V1 implementation and carry forward only
behavior that it re-verifies.

## Priority model

- `P0`: blocking product defect; complete before other V2 implementation.
- `P1`: high-priority security or capability expansion.
- `P2`: important companion experience.
- `P3`: planned hardening or polish after the higher-priority path works.

The proxy egress-firewall issue is P1 because it is the enforcement boundary
for an untrusted workspace and should be established before adding another
default agent. The remaining priorities come directly from the V2 scope.

## Trust invariants

1. The Kasm workspace, its applications, and every file projected into it are
   untrusted and user-modifiable.
2. Policy and network enforcement live outside the workspace. Environment
   variables, application settings, a policy signature, or cooperative client
   behavior alone are never an enforcement boundary.
3. Public internet access is deny by default and granted only through an
   authenticated, workspace-bound, externally enforced egress policy.
4. Direct model-provider, Microsoft Graph, upstream MCP, metadata/link-local,
   host-control, database, Docker, cross-workspace, and alternate tunnel paths
   remain unavailable unless an issue explicitly introduces a bounded route.
5. ONEComputer Control remains the source of truth for ONEComputer identity,
   effective operation policy, governed operations, Microsoft execution,
   execution leases, and receipts. A signed OpenVTC decision is consent
   evidence only after its approver DID, proof, challenge, expiry, and exact
   action digest have been verified; it does not transfer execution authority
   to the browser or VTA.
6. A push notification is only a delivery hint. It cannot approve an
   operation, carry approval authority, or replace verification of the exact
   device-signed decision.
7. Signing projected policy makes tampering detectable; privileged consumers
   must also verify the signature and independently enforce the verified
   values.
8. Unknown identity, policy, signature, key, destination, schema, state, or
   dependency result fails closed.
9. Credentials, private keys, raw sensitive task content, clipboard contents,
   and unrestricted request/response bodies do not enter source, images,
   notifications, logs, screenshots, or evidence.
10. Security claims must be bounded to the inspected Kasm/container and proxy
    topology; V2 does not claim VM-grade hostile multi-tenant isolation.
11. External-channel credentials stay in trusted ONEComputer middleware and
    never enter a workspace, agent process, prompt, model context, or MCP
    gateway. A channel is transport only and cannot grant tool or approval
    authority.

## Execution rules

1. Work only on the first `ready` issue. Do not implement its successor in the
   same task unless explicitly authorized.
2. Before editing, record the repository, branch, status, expected files,
   external systems, secrets, destructive fixtures, and exact dependency/image
   pins.
3. Read the V1 implementation and deployed topology before designing from the
   issue prose.
4. Begin security-relevant changes with a failing contract or regression.
5. Preserve owned adapters around Kasm, the egress proxy, LiteLLM, Web Push
   providers, and agent distributions. Issue 011 keeps only a small owned
   OpenVTC product-mapping adapter and deletes duplicate protocol,
   cryptographic, and passkey implementations in favor of pinned upstream SDK
   components.
6. Do not weaken deny-by-default behavior to make a positive journey pass.
7. Run the issue's negative, tamper, tenant, expiry, replay, concurrency,
   reconnect, restart, and bypass cases where applicable.
8. A change outside the current issue needs a written issue amendment or a new
   issue.
9. Human browser or authenticator gestures may be requested only for a
   prepared, bounded verification case. Never request a credential, device
   private key, recovery secret, or raw sensitive task body.
10. An issue with incomplete proof stays in `verification` or
    `decision_required`; it is not marked complete on happy-path evidence.

## Common evidence protocol

Write a redacted bundle under:

```text
.artifacts/v2/issues/<issue-id>/<UTC timestamp>/
```

Each bundle contains:

- `manifest.json`: issue, revision, branch, dirty files, dependency evidence,
  version/image pins, timestamps, commands, and result;
- `tests.log`: exact commands and exit codes, redacted;
- `probes.json`: machine-readable positive and negative results;
- `inspection.json`: relevant runtime, configuration, network, data, and log
  inspection;
- `residual-risks.md`: limitations and the exact boundary of any security
  claim;
- `recovery.md`: safe cleanup/recovery procedure and result.

An issue is complete only when its behavior exists, all checked acceptance
cases pass, deployed claims are inspected, the evidence is internally
consistent, and the completion record points to the bundle.

## Issue index

| ID | Priority | Status | Outcome | Depends on |
| --- | --- | --- | --- | --- |
| 001 | P0 | complete | Make Kasm clipboard use native copy/paste | — |
| 002 | P1 | complete | Enforce a workspace egress firewall at the proxy/network boundary | 001 |
| 003 | P1 | complete | Ship Hermes Claw and Claude Desktop as policy-selected default agents | 002 |
| 004 | P2 | verification | Add a push-capable OpenVTC companion web app | 003 |
| 005 | P3 | complete | Sign projected policy and verify it at enforcement points | 004 |
| 006 | P3 | verification | Refine the complete V2 UI and accessibility | 005 |
| 007 | P1 | verification | Chat with Hermes inside the assigned sandbox | 003 |
| 008 | P1 | planned (deferred) | Extend egress firewall to FQDN and CIDR L3/L4 rules | 002 |
| 009 | P1 | cancelled | Chat with any policy-selected agent through one owned interface | 003, 007 |
| 010 | P1 | verification | Replace the bespoke Chat surface with AI SDK structured streaming | 003, 007 |
| 011 | P1 | verification | Replace custom OpenVTC consent crypto with upstream Rust and browser components | 003 |
| 012 | P1 | verification | Add an agent-agnostic channel broker with Telegram as the first adapter | 002, 003, 010 |

## Assignment template

```text
Implement only local-plans/v2/issues/NNN-....md on mike/greenfield-v2.
Follow local-plans/v2/README.md and preserve the V2 trust invariants.
Do not start the next issue. Report preflight and expected files before edits.
If required proof is unavailable, leave the issue in verification or
decision_required rather than weakening acceptance.
```
