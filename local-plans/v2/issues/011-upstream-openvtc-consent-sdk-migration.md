# 011: replace custom OpenVTC consent crypto with upstream Rust and browser components

Status: `verification`

Priority: P1
Depends on: 003
Supersedes: the custom OpenVTC protocol boundary introduced by 004
Unblocks: a truthful, independently verifiable action-consent claim

## Outcome

For every protected ONEComputer operation, an enrolled approver DID signs an
OpenVTC Task Consent decision bound to the exact canonical action digest after
a fresh passkey user-verification ceremony. A small native Rust consent service
uses pinned upstream Trust Tasks, OpenVTC VTA digest, and Affinidi Data
Integrity crates to verify the document and proof before Control permits one
execution of the unchanged action.

This remains a consent integration. The Rust service is a protocol signer and
verifier, not a VTA task handler, policy engine, grant owner, or Microsoft
executor.

## Product and trust decisions

- Microsoft Entra remains the ONEComputer account identity and sign-in system.
  OpenVTC is used for action consent, not login.
- Every employee authorized to approve protected operations enrolls one
  approval device. The device holds a distinct approver DID signing key
  protected at rest by a passkey-derived key.
- Control remains authoritative for tenant and employee identity, agent and
  workspace identity, policy, operation construction, live approver
  enrollment, execution leases, Microsoft execution, and receipts.
- The signed evidence proves that a particular enrolled approver DID signed
  approve or deny for a particular action digest. It does not make a VTA the
  action executor.
- Do not add a ONEComputer Microsoft task handler to the VTA, run the full VTA
  service, fork its dispatcher, create an external-executor protocol, or add a
  VTA-owned commit callback.
- The passkey performs fresh local user verification and releases the
  approver DID key. The DID key signs the decision. Do not call this a
  passkey-signed action.
- Make one clean cutover. There are no compatibility routes, legacy readers,
  dual writes, fallback verifiers, feature flags, or browser-storage migration.
- Web Push remains a contentless wake hint. It carries no task, decision,
  digest, credential, or approval authority.
- The existing same-origin HTTPS inbox and submission routes remain transport
  plumbing. Transport authentication never substitutes for the signed
  decision.
- Call the result verifiable action-consent evidence. PostgreSQL is not
  deletion-resistant immutable storage; external anchoring or WORM storage is
  a separate issue.

## Pinned upstream boundary

Use exact versions and commit their lockfiles and checksums:

| Component | Exact pin | Role |
| --- | --- | --- |
| `trust-tasks-rs` | `=0.2.37` | Typed Task Consent envelopes and payload schema validation |
| `trust-tasks-proof` | `=0.2.1`, `affinidi` backend | Trust Task `eddsa-jcs-2022` proof verification |
| `affinidi-data-integrity` | `=0.7.7` | Data Integrity request signing and generic proof verification |
| `vta-policy` | `=0.1.0` | Upstream `consent::wire_digest` implementation |
| `@openvtc/pnm-core` | `0.2.0` | Browser DID generation/reconstruction, proof signing, encoding, and secret-wrap interfaces |

The qualification record, registry checksums, package integrity, source
revisions, and known browser release gap are recorded in
[`../evidence/011-upstream-rust-consent-qualification.md`](../evidence/011-upstream-rust-consent-qualification.md).

Do not use `@openvtc/trust-tasks` at runtime. Rust owns the generated types and
runtime schemas. Do not use `@openvtc/rp-sdk`; it is an SIOPv2 login verifier
and is unrelated to action consent.

## Architecture

```text
Entra-authenticated user
        |
        v
ONEComputer Control
  operation + canonical action digest
        |
        | sign/verify only
        v
native Rust consent service
  trust-tasks-rs
  trust-tasks-proof
  affinidi-data-integrity
  vta-policy::consent::wire_digest
        |
        v
same-origin HTTPS inbox
        |
        v
browser approval device
  @openvtc/pnm-core
  WebAuthn PRF platform adapter
  approver DID signs approve/deny
        |
        v
Control checks live enrollment and exact bindings
        |
        v
existing atomic lease -> exact Microsoft connector call -> receipt
```

The Rust service never reads Microsoft credentials, calls a connector, decides
policy, mutates an operation, records an approval, or issues an execution
lease.

## In scope

### Native Rust consent service

- Add one small internal-only Rust service built with a pinned Rust 1.95
  toolchain. It is reachable only by Control on the trusted control-plane
  network and requires a scoped service credential.
- Keep its API narrow:
  - sign and self-verify one Task Consent request;
  - verify one approver-enrollment proof;
  - verify one Task Consent decision; and
  - report health and exact dependency/profile versions.
- Load the executor signing key only in the Rust service. Remove Node-side
  Ed25519 key parsing and signing.
- Build request and decision payloads with the generated
  `trust-tasks-rs::specs::task_consent` types and validate their embedded
  schemas with the `validate` feature.
- Compute the signed salted Task Consent digest only with
  `vta_policy::consent::wire_digest`. The digest input is the strict product
  task type and canonical ONEComputer task payload.
- Sign executor request documents with `affinidi-data-integrity` using
  `eddsa-jcs-2022`.
- Verify enrollment documents with `affinidi-data-integrity`, resolving only
  the supported `did:key` profile.
- Verify decision documents through
  `trust_tasks_proof::affinidi::Verifier::for_did_key`.
- Return only a typed verification result: proven signer DID, verification
  method, decision, challenge, payload digest, timestamps, proof hash, and
  document hash. Never return “authorized” or “execute”.
- Reject unknown fields, types, versions, proof suites, proof purposes, DID
  methods, and non-canonical encodings before returning a verified result.

### Control integration

- Preserve `GovernedOperationEnvelope` and its canonical digest over tenant,
  employee, workspace, agent, audience, capability, server, tool, schema,
  arguments, policy binding, nonce, and expiry.
- Keep the smallest typed client for the internal Rust service. It contains no
  canonicalization, multibase, DID, signature, proof, or Task Consent schema
  implementation.
- Build the strict ONEComputer task payload from the stored operation. It
  includes the operation digest and every immutable execution input but no
  Microsoft credential, raw document body, reusable authority, or secret.
- Before task delivery, require the Rust service to sign and successfully
  round-trip verify the request. Serve only the verified stored request.
- After decision verification, independently check recipient, live task,
  challenge, payload digest, request lifetime, current enrollment, requester
  exclusion, operation ownership, operation digest, policy binding, and
  current resource guard before changing state.
- Preserve the database transaction that records one decision and advances one
  operation, plus the existing atomic execution lease and exact connector
  dispatch guard.
- Persist the operation envelope, signed request and decision, their hashes,
  signer DID and verification method, execution receipt hash, timestamps, and
  correlation identifiers.

### Browser approval device

- Exact-pin `@openvtc/pnm-core@0.2.0`.
- Replace local Ed25519 generation, DID derivation, base58/multibase,
  canonicalization, Data Integrity proof construction, and decision signing
  with upstream `generateSigningIdentity`, `signingIdentityFromSecret`,
  `signTrustTask`, base64url helpers, and secret-wrap interfaces.
- Keep only the browser platform adapter that the SDK intentionally leaves to
  the host:
  - IndexedDB record storage;
  - `navigator.credentials.create` enrollment;
  - `navigator.credentials.get` for every approve and deny;
  - `userVerification: "required"`;
  - exact RP ID and origin;
  - PRF output retrieval; and
  - injection of that output into an SDK `SecretWrap`.
- Bind each assertion challenge to `SHA-256(payloadDigest)`. Do not cache the
  derived approver key-encryption key across decisions.
- Render only the typed request returned by Control after Rust verification.
  Render every effect and consequence, including an explicit unknown-effects
  state.
- Keep the existing fetch adapter for inbox and decision submission; it has no
  proof or decision logic.

### Clean deletion

- Delete `packages/openvtc-adapter` after its final caller moves to the Rust
  service or published browser SDK.
- Delete local JCS, length-prefix digest, base58/multibase, DID-key, Ed25519,
  Data Integrity, proof verification, Task Consent schema, and document-signing
  helpers.
- Delete obsolete tests, scripts, dependency declarations, environment
  variables, and built browser assets in the same cutover.
- Preserve only the product mapping, platform WebAuthn/IndexedDB adapter,
  Control-to-Rust client, HTTPS delivery adapter, persistence state machine,
  and exact-once execution boundary.

## Out of scope

- OpenVTC login, replacement of Microsoft Entra, or identity federation.
- A task-level VTA handler for a ONEComputer or Microsoft operation.
- Running or forking the complete VTA service.
- VTA-owned policy, grants, execution, Microsoft credentials, leases, or
  receipts.
- DIDComm, TSP, a mediator, native mobile agents, or multiple transports.
- A blockchain, transparency service, external timestamp, hash-chain anchor,
  WORM store, or immutable-audit claim.
- Compatibility adapters, old route aliases, dual protocol versions, dual
  storage, or preservation of pending approvals and browser keys across the
  cutover.
- “Full OpenVTC conformance” or “passkey-signed action” claims.

## Required verification

- [x] Cargo and npm lockfiles prove every exact pin and checksum; licenses and
      security-sensitive transitive dependencies are recorded.
- [x] Source and built-asset inspection proves no local OpenVTC
      canonicalization, digest, multibase, DID, signing, proof, or Task Consent
      schema duplicate remains.
- [x] Rust verifies an upstream browser-SDK signed approval and denial, and the
      browser accepts a Rust-signed request.
- [x] An independent Rust verifier can reproduce the action digest binding and
      prove the signer and decision from the stored operation, request,
      decision, and public key material.
- [x] Mutation of tenant, employee, workspace, agent, audience, capability,
      server, tool, schema, arguments, policy, nonce, expiry, task type,
      challenge, payload digest, decision, issuer, recipient, verification
      method, or proof fails before an execution lease.
- [ ] Wrong RP ID, origin, credential, assertion challenge, user-verification
      result, cancellation, PRF output, and replay fail closed.
- [x] Approval executes the exact stored Microsoft operation once. Concurrent
      submissions, duplicate decisions, repeated dispatch, restart, reconnect,
      and abandoned leases produce at most one legal execution.
- [x] Denial, expiry, dismissal, silence, revoked enrollment, unsupported
      version, unknown effects, unavailable transport, Rust-service failure,
      and failed proof issue zero execution leases.
- [x] The Rust service cannot reach Microsoft endpoints or the operation
      database and cannot issue a lease.
- [x] Web Push, logs, browser caches, IndexedDB, API responses, and evidence
      contain no credentials, raw sensitive task bodies, private keys, or
      reusable authority.
- [ ] Full automated tests, Rust unit/integration tests, cross-language
      interoperability vectors, production builds, dependency audits, and one
      deployed physical-passkey run pass.

## Evidence required

Include:

- exact Cargo/npm pins, registry checksums, source revisions, licenses, and the
  current-to-upstream deletion map;
- a redacted operation envelope and independently recomputed digest;
- corresponding Rust-signed request and browser-SDK signed approve and deny
  decisions;
- independent Rust proof-verification output and signer/enrollment resolution;
- negative mutation, expiry, replay, revocation, concurrency, restart, browser,
  and transport matrices;
- exact-once correlation from operation through lease, dispatch, and receipt;
- source, dependency, built-asset, browser-storage, route, schema, network, and
  log inspection proving the retired implementation is absent and the Rust
  service has no execution authority; and
- the exact final claim language.

The completion claim is:

> For the pinned OpenVTC Task Consent and browser profile, ONEComputer verifies
> with the upstream Rust Trust Tasks and Affinidi Data Integrity stack that an
> enrolled approver DID signed a decision bound to the exact canonical action
> digest after fresh passkey user verification, before permitting one
> execution.

Do not call the evidence deletion-resistant, immutable, VTA-executed,
passkey-signed, or fully OpenVTC-conformant.

## Stop conditions

- A pinned Rust crate cannot construct, validate, sign, or verify the exact
  Task Consent profile required by the completion claim.
- `vta_policy::consent::wire_digest` is unavailable or differs from the VTA
  interoperability vectors.
- The browser SDK path would require retaining local Ed25519, DID, multibase,
  JCS, Data Integrity, or decision-signing code.
- The supported passkey path cannot require fresh user verification for every
  approve and deny on the target browser/platform matrix.
- Replacing local code would weaken action binding, independent proof
  verification, requester exclusion, expiry, revocation, or exact-once
  execution.
- The selected integration would require the VTA to understand or execute the
  ONEComputer action.
- Supporting the cutover would require a legacy route, verifier, key format,
  enrollment record, or compatibility branch.

## Completion record

Implementation and automated qualification completed on 2026-07-25. The clean
cutover is active in source: the custom adapter is deleted, Control uses the
internal Rust signer/verifier, the browser uses the pinned published SDK, and
the request and decision evidence retain document and proof hashes.

The issue remains in `verification` until the unchecked physical-browser items
and one deployed physical-passkey run are completed. Automated results and
dependency-audit qualifications are recorded in the linked evidence file.
