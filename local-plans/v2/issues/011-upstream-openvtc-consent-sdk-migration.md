# 011: replace custom OpenVTC proof code with the upstream consent SDK

Status: `ready`

Priority: P1
Depends on: 003
Supersedes: the custom OpenVTC protocol boundary introduced by 004
Unblocks: a truthful, independently verifiable action-consent claim

## Outcome

For every protected ONEComputer operation, an enrolled approver DID signs an
OpenVTC Task Consent decision bound to the exact canonical action digest after
a fresh passkey user-verification ceremony. Control verifies that proof before
allowing one execution of the unchanged action.

The browser and Control use exact-pinned upstream OpenVTC SDK components and
generated Trust Tasks bindings for supported protocol, proof, passkey, and
wire-format behavior. ONEComputer retains its canonical action model, policy
decision, operation store, execution lease, Microsoft connector, and receipt.

## Product decisions

- Microsoft Entra remains the ONEComputer sign-in system. OpenVTC is used for
  action consent, not login.
- Control remains authoritative for tenant and employee identity, agent and
  workspace identity, policy, action construction, execution, leases, and
  receipts.
- The OpenVTC evidence proves that a particular enrolled approver DID signed a
  decision over a particular action digest. It does not make the upstream VTA
  the Microsoft-operation executor or grant owner.
- Do not add a VTA product-task handler, VTA fork, private external-executor
  protocol, or VTA-owned commit callback.
- Use exact pins of `@openvtc/pnm-core` and the generated
  `@openvtc/trust-tasks` bindings. Use upstream proof, canonicalization,
  multibase, DID, Task Consent, and passkey helpers wherever those packages
  expose the required operation.
- Keep only a small owned adapter that maps the canonical ONEComputer operation
  to upstream Task Consent inputs and maps a verified decision back to the
  governed-operation state machine. It must contain no duplicate cryptographic
  or wire-protocol implementation.
- Make a clean cutover. There are no compatibility routes, legacy readers,
  dual writes, fallback verifiers, or migrations for disposable development
  approval data.
- Preserve Web Push only as a contentless wake hint. Push does not carry a
  task, decision, digest, credential, or authority.
- Keep one owned HTTPS task-delivery boundary between Control and the browser.
  It is transport plumbing, not an OpenVTC conformance claim or approval
  authority.
- Call the result verifiable action-consent evidence. PostgreSQL persistence is
  not deletion-resistant immutable storage; external anchoring or WORM storage
  requires a separate issue.

## In scope

- Qualify and exact-pin the upstream browser SDK and generated Trust Tasks
  bindings, including package integrity, source revision, supported protocol
  versions, licenses, and security-sensitive transitive dependencies.
- Preserve the existing `GovernedOperationEnvelope` and its canonical digest
  over tenant, employee, workspace, agent, audience, capability, server, tool,
  schema, arguments, policy binding, nonce, and expiry.
- Build the Task Consent payload from that stored operation. The signed
  `payloadDigest` must bind the task type, canonical task payload, fresh
  challenge, operation digest, and all immutable execution inputs.
- Replace handwritten browser request verification, effect/consequence
  rendering input, decision construction, signing, passkey interaction, and
  secure storage code with supported `@openvtc/pnm-core` APIs. Keep only a
  small owned fetch adapter for the Control inbox and decision routes.
- Replace local Task Consent schemas and proof verification with upstream
  generated bindings and SDK verification APIs.
- Keep the owned Control task queue, approver enrollment association, delivery
  state, signed evidence storage, operation state machine, execution lease, and
  connector receipt.
- Require fresh passkey user verification before every approval or denial.
  State precisely whether the authenticator signs the decision or unlocks a
  DID signing key; do not conflate those mechanisms.
- Verify the request before rendering any actionable approval UI. Render every
  verified effect and consequence, including the explicit unknown-consequences
  state when applicable.
- Verify the decision's type, version, issuer, recipient, verification method,
  proof, challenge, payload digest, decision, request lifetime, current
  enrollment, and requester exclusion before changing operation state.
- Recompute and compare the canonical operation and Task Consent bindings
  before execution. Execute only through the existing atomic lease and exact
  tool-dispatch boundary.
- Persist the canonical operation envelope, request document, decision
  document, their hashes, signer DID and verification method, execution
  receipt hash, timestamps, and correlation identifiers without storing
  credentials or sensitive raw content.
- Update Companion, Trail, Activity, and Chat projections to consume only the
  cut-over state and evidence.

## Out of scope

- OpenVTC login, replacement of Microsoft Entra, or identity federation.
- Making the VTA understand, plan, dispatch, grant, or execute a ONEComputer
  Microsoft operation.
- A VTA handler extension, maintained VTA fork, or claim that the upstream VTA
  enforced the external action.
- A blockchain, transparency service, external timestamp, hash-chain anchor,
  WORM store, or claim of deletion-resistant immutable audit.
- Compatibility adapters, old route aliases, dual protocol versions, dual
  storage, browser-storage migration, database data migration, or preservation
  of pending approvals across the cutover.
- Native mobile agents, multiple simultaneous transports, generic support for
  every Trust Task family, or unrelated Microsoft connector work.
- “Full OpenVTC conformance” or “passkey-signed action” claims not established
  by the exact pinned profile and ceremony.

## Required implementation

- Record the chosen package versions, npm tarball integrity, upstream source
  commits, supported Task Consent versions, browser/platform requirements, and
  license notices before changing production dependencies.
- Create a current-to-upstream mapping for every exported function in
  `packages/openvtc-adapter` and every protocol or cryptographic helper in
  `apps/web/src/openvtc-browser-agent.js`.
- Delete each local JCS, length-prefix digest, base58/multibase, DID-key,
  Data Integrity, proof, Task Consent schema, and passkey helper as its
  upstream replacement is connected. Do not wrap copied upstream algorithms.
- If an upstream package does not expose a needed non-cryptographic product
  mapping, keep the smallest typed ONEComputer function for that mapping. A
  missing upstream cryptographic or proof primitive is a stop condition, not
  permission to retain the local implementation.
- Keep one strict product task type. Its payload includes the canonical
  operation digest and immutable execution inputs but excludes Microsoft
  credentials, raw document bodies, reusable Control authority, and secrets.
- The decision signed by the approver contains at least the fresh challenge,
  exact payload digest, and approve/deny value. Control accepts it only for the
  matching live task and enrolled DID.
- The delivery credential authenticates polling/submission only. Possession of
  that credential cannot create, alter, or substitute for an approver proof.
- Store the complete signed request and decision documents so an independent
  verifier can reproduce the action digest, Task Consent payload digest, proof
  verification, and execution correlation.
- Preserve the database transaction that records one decision and advances one
  operation, plus the atomic execution lease and exact dispatch guard. Do not
  move these controls into the SDK.
- Delete obsolete local exports, browser bundles, tests, environment variables,
  scripts, schema fields, and documentation in the same cutover. Do not leave
  deprecated paths or feature flags.
- Keep one owned HTTPS polling/submission adapter with no protocol,
  cryptographic, or decision logic. Retain Web Push only as an optional wake
  hint around that transport.

## Required verification

- [ ] Dependency inspection proves the exact-pinned upstream packages are used
      and no local OpenVTC cryptographic or wire-protocol duplicate remains.
- [ ] An independent verifier can start from the stored operation envelope,
      request, decision, and public verification material and prove that the
      enrolled approver DID signed approve or deny for the exact action digest.
- [ ] Mutation of tenant, employee, workspace, agent, audience, capability,
      server, tool, schema, arguments, policy, nonce, expiry, task type,
      challenge, payload digest, decision, issuer, recipient, verification
      method, or proof fails before an execution lease is issued.
- [ ] A physical authenticator completes fresh user verification for each
      decision. Wrong RP ID, origin, credential, challenge, user verification,
      cancellation, and replay fail closed.
- [ ] Approval executes the exact stored Microsoft operation once. Concurrent
      submissions, duplicate decisions, repeated dispatch, restart, reconnect,
      and an expired or abandoned lease produce at most one legal execution.
- [ ] Denial, expiry, dismissal, silence, revoked enrollment, unsupported
      version, unknown consequence, unavailable transport, and failed proof
      issue zero execution leases.
- [ ] Policy or remote-resource changes that invalidate the stored operation
      fail before commit according to the existing Control and connector
      guards.
- [ ] The browser never renders unverified material as actionable and renders
      every verified effect, consequence, and explicit unknown state.
- [ ] Web Push, logs, browser caches, IndexedDB, API responses, and evidence
      contain no credentials, private keys, raw sensitive task bodies, reusable
      authority, or notification approval data.
- [ ] Full automated tests, upstream SDK interoperability tests, production
      builds, clean dependency inspection, and one deployed physical-passkey
      run pass.

## Evidence required

Include:

- exact dependency and source pins, integrity hashes, licenses, and the
  current-to-upstream deletion map;
- a redacted canonical operation envelope and independently recomputed digest;
- the corresponding signed request and signed approve and deny decisions;
- independent proof-verification output and signer/enrollment resolution;
- negative mutation, expiry, replay, revocation, concurrency, restart, and
  transport matrices;
- exact-once correlation from operation through lease, dispatch, and receipt;
- source, dependency, built-asset, browser-storage, route, schema, and log
  inspection proving the retired implementation is absent; and
- the exact final claim language.

The completion claim is:

> For the pinned OpenVTC Task Consent and browser profile, ONEComputer verifies
> that an enrolled approver DID signed a decision bound to the exact canonical
> action digest after fresh passkey user verification, before permitting one
> execution.

Do not call the evidence deletion-resistant, immutable, VTA-executed, or fully
OpenVTC-conformant.

## Stop conditions

- The pinned upstream SDK cannot verify the request and construct or verify the
  exact Task Consent decision profile required by the completion claim.
- The supported passkey path cannot require fresh user verification for every
  decision on the target browser/platform matrix.
- Replacing local protocol code would weaken action binding, independent proof
  verification, requester exclusion, expiry, revocation, or exact-once
  execution.
- A required cryptographic or wire-format primitive has no upstream-supported
  implementation and would need to remain handwritten.
- The selected integration would require the VTA to execute the ONEComputer
  action. That is a separate upstream-extension decision, not part of this
  issue.
- Supporting the cutover would require retaining a legacy route, verifier,
  key format, enrollment record, or compatibility branch.

## Completion record

Not complete.
