# Issue 011 upstream Rust consent qualification

Checked: 2026-07-25

## Conclusion

The server-side migration is not blocked on the JavaScript SDK. Published Rust
crates provide the required Task Consent types, schema validation, VTA wire
digest, and Affinidi Data Integrity proof implementation.

The correct boundary is:

- Rust for Task Consent documents, request signing, digest calculation, and
  proof verification;
- the published browser SDK for approver DID generation and decision signing;
- a small owned browser platform adapter for WebAuthn PRF and IndexedDB; and
- ONEComputer Control for identity, policy, enrollment, action binding,
  execution leases, Microsoft execution, and receipts.

This does not add a VTA task handler or make the VTA an action executor.

## Exact Rust artifacts

| Crate | Version | crates.io checksum | Published source revision | Role |
| --- | --- | --- | --- | --- |
| `trust-tasks-rs` | `0.2.37` | `59e5187b4117f0c19968d7f2bfed89378a61cffcb1959ebaef256ce0b9734b1e` | `59c98fea1e358edd1691fcbac3d0c6dec829cd63` | Generated Task Consent types and embedded-schema validation |
| `trust-tasks-proof` | `0.2.1` | `c0138696d9a4d052ee0c7d780a7ba28d469c41dc3157312ae222c9e54d484fe9` | `385a8fc496eb88945c350890aa4288f4ace7d2bc` | Affinidi-backed Trust Task proof verifier |
| `affinidi-data-integrity` | `0.7.7` | `2ab562d8232a2837c8fd23c06688ac5dc3ed2f8fdf5b503344b50677d3ef2a38` | `852ca5d54fd5753d81e781ba93a73f539857a4c6` | `eddsa-jcs-2022` signing and verification |
| `vta-policy` | `0.1.0` | `c00c6d258da36c45de52ec16c97f375433e7d316c30ac66ba6c3de31c82b2aed` | `65373a60c6754a50ea1ea766fa9d1e5a70eea6d4` | Public VTA `consent::payload_digest` and `consent::wire_digest` |

All four crates declare Apache-2.0 and require Rust 1.95.

`trust-tasks-rs` intentionally models proof structure but delegates
cryptographic verification through its `ProofVerifier` trait.
`trust-tasks-proof` supplies the default `affinidi` backend and exposes
`trust_tasks_proof::affinidi::Verifier::for_did_key`.

The OpenVTC VTI crate `vta-policy` publicly exports the exact domain-separated,
type-bound, length-prefixed, RFC 8785 JCS and SHA-256 digest implementation used
by the VTA. ONEComputer should call `consent::wire_digest`; it should not copy
that algorithm.

## Exact browser artifact

| Package | Version | npm integrity | Published source revision |
| --- | --- | --- | --- |
| `@openvtc/pnm-core` | `0.2.0` | `sha512-94yw8UziLsZNamq1dKnAudcFbS8cJMy1BR9wOvdfwSMzBu1XsT/6i79o7pKvxLJAVDW+oXa7UWPGrMKvtkEFyw==` | `a21d84311940e1cc873ca4e827692e459079543d` |

The package declares Apache-2.0. Its published surface includes
`generateSigningIdentity`, `signingIdentityFromSecret`, `signTrustTask`,
base64url helpers, `SecretWrap`, `wrapSecret`, and `unwrapSecret`.

The package deliberately leaves concrete WebAuthn PRF wrapping to the browser
host through `SecretWrap`. ONEComputer may therefore keep a narrow platform
adapter for the WebAuthn ceremony and IndexedDB while deleting its duplicated
Ed25519, DID, multibase, JCS, and Data Integrity implementation.

## JavaScript release findings

The following findings remain true but do not block the revised architecture:

- `@openvtc/pnm-core@0.2.0` does not publish its newer Task Consent parser,
  generic proof verifier, approver identity helper, or approver PRF wrapper.
  Those were added to browser-plugin source after the package's published
  revision.
- `@openvtc/trust-tasks@0.2.37` root import fails under Node ESM because its
  generated internal imports omit file extensions.
- `@openvtc/rp-sdk@0.2.0` verifies SIOPv2 login tokens, not Task Consent
  documents.

The revised design does not depend on any of those missing JavaScript runtime
surfaces. Rust validates requests before Control delivers them and verifies
decisions before Control records them.

## VTA boundary

The complete VTA remains out of process and out of scope. Its fixed dispatcher,
policy engine, pending-consent store, and single-use grants apply to tasks that
the VTA itself executes.

ONEComputer imports only published libraries for protocol mechanics:

- `vta-policy::consent::wire_digest` does not dispatch or execute a task;
- `trust-tasks-rs` models and validates documents;
- `trust-tasks-proof` verifies proofs; and
- `affinidi-data-integrity` signs and verifies bytes.

Control remains the sole authority that associates a verified signer with a
current employee enrollment and permits its own exact Microsoft operation to
execute.

## Qualification caveats

- A physical passkey is still required for the final user-verification run.
- PostgreSQL evidence remains mutable and deletable. This migration proves
  signed consent integrity but does not provide immutable storage.
- The Task Consent specifications remain versioned Draft material. Exact pins
  and rejection of unknown versions are mandatory.

## Implemented boundary

The clean cutover completed on 2026-07-25:

| Previous owned implementation | Replacement |
| --- | --- |
| `packages/openvtc-adapter` JCS, digest, DID-key, multibase, Ed25519, proof, schema, signing, and verification code | Deleted |
| Node executor key parsing and request signing | Internal `onecomputer-openvtc-consent` Rust service |
| Node decision and enrollment verification | `trust-tasks-proof` and Affinidi verification in the Rust service |
| Browser DID generation, key reconstruction, base64url, JCS, Ed25519, and proof construction | `@openvtc/pnm-core@0.2.0` |
| Owned browser secret wrapping protocol | SDK `SecretWrap`, `wrapSecret`, and `unwrapSecret` with the concrete WebAuthn PRF/AES-GCM platform adapter |
| Browser record `browser-approver-v1` | Clean-cutover `browser-approver-v2`; no reader or migration |

Control retains only product mapping, enrollment policy, live binding checks,
evidence persistence, the atomic execution lease, and exact connector
dispatch. The Rust service has no database, Microsoft credential, connector,
operation-state, policy-decision, or lease API.

The request evidence now stores both `request_hash` and
`request_proof_hash`. Decision evidence stores the signed document,
`decision_hash`, `proof_hash`, proven signer DID, verification method,
timestamps, operation digest, nonce, and execution correlation.

## Security-sensitive transitive dependencies

The committed Cargo lock records 618 packages. The security-relevant path
includes `ed25519-dalek 2.2.0`, `serde_json_canonicalizer 0.3.2`,
`rustls 0.23.42`, `affinidi-did-resolver-cache-sdk 0.8.21`, and
`vti-common 0.11.22`. The latter three arrive through the pinned Affinidi and
VTA crates; the service is isolated from external networks and does not invoke
their messaging, keyring, or remote-resolution surfaces.

The browser package's principal security-sensitive transitives are
`@noble/curves 2.2.0`, `@scure/base 2.2.0`, `@hpke/core 1.9.0`,
`@openvtc/vti-didcomm-js 0.5.0`, and `cbor-x 1.6.4`. The production import uses
only the published signing-identity, Trust Task signing, encoding, and
secret-wrap exports.

`cargo audit 0.22.1` loaded 1,169 RustSec advisories and found no
vulnerabilities. It reported four allowed unmaintained warnings:
`proc-macro-error 1.0.4`, `rustls-pemfile 1.0.4`,
`rustls-pemfile 2.2.0`, and `smallstr 0.3.1`, all transitive through the pinned
upstream stack.

`npm audit --omit=dev` found no high or critical vulnerability after
`find-my-way` moved within its allowed range from `9.6.0` to `9.7.0`. Two
moderate findings remain in `@hono/node-server 1.19.14` through the separately
pinned `@modelcontextprotocol/sdk`; the advisory is a Windows static-file path
traversal and does not originate from or execute in the OpenVTC browser or Rust
consent path.

## Automated qualification

The final automated run on 2026-07-25 produced:

- 142 Node tests passed, zero failed;
- all workspace TypeScript builds passed;
- the Vite production browser build passed;
- Rust formatting passed;
- 7 Rust unit/integration tests passed, zero failed;
- the exact Rust 1.95 production image built from digest-pinned base images;
- Compose configuration validation passed;
- the production image stopped cleanly on `SIGTERM`; and
- source inspection found no caller or package-lock reference to the deleted
  `@onecomputer/openvtc-adapter`.

`scripts/qualify-openvtc-interop.mjs` ran the published JavaScript SDK against
the production Rust container. It verified:

- service-token rejection;
- a Rust-signed, self-verified, recipient-bound request accepted by the actual
  browser request validator;
- omission of the raw private task argument from that request;
- SDK-signed approver enrollment verified by Rust;
- SDK-signed `approve` and `deny` decisions verified by Rust;
- valid signatures from a verification method other than the enrolled method
  rejected;
- mutated payload-digest rejection; and
- unknown proof-field rejection.

The final run used executor
`did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp`. Approver identities and
salted request digests are intentionally fresh on each qualification run.

The remaining manual gate is a deployed Chrome/Windows Hello, Touch ID, or
compatible security-key run proving the target authenticator returns the PRF
extension with `userVerification: "required"` on enrollment, approval, and
denial. Until that run is attached, Issue 011 remains `verification`, not
`complete`.
