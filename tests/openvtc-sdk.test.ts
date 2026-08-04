import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  bytesToBase64url,
  generateSigningIdentity,
  signTrustTask,
  signingIdentityFromSecret,
  unwrapSecret,
  wrapSecret,
} from "@openvtc/pnm-core";

describe("published OpenVTC browser SDK", () => {
  it("mints, restores, and signs with one stable did:key identity", async () => {
    const identity = generateSigningIdentity();
    const restored = signingIdentityFromSecret(identity.privateKey);
    assert.equal(restored.did, identity.did);
    assert.equal(restored.kid, identity.kid);

    const envelope = {
      id: "urn:uuid:7d8cdf9d-f6e7-42e6-9065-ec0c03f33c9f",
      type: "https://trusttasks.org/spec/task-consent/decision/0.1",
      issuer: restored.did,
      recipient: "did:key:z6MkExecutor",
      issuedAt: new Date().toISOString(),
      payload: {
        challenge: "0123456789abcdef",
        payloadDigest: "a".repeat(64),
        decision: "approve",
      },
    };
    const signed = await signTrustTask({ envelope, signing: restored, clockSkewMs: 0 });
    assert.equal(signed, envelope);
    assert.deepEqual(
      {
        type: (signed.proof as Record<string, unknown>).type,
        cryptosuite: (signed.proof as Record<string, unknown>).cryptosuite,
        verificationMethod: (signed.proof as Record<string, unknown>).verificationMethod,
        proofPurpose: (signed.proof as Record<string, unknown>).proofPurpose,
      },
      {
        type: "DataIntegrityProof",
        cryptosuite: "eddsa-jcs-2022",
        verificationMethod: identity.kid,
        proofPurpose: "assertionMethod",
      },
    );
    assert.match(String((signed.proof as Record<string, unknown>).proofValue), /^z/);
  });

  it("uses the SDK SecretWrap boundary without plaintext fallback", async () => {
    const mask = crypto.getRandomValues(new Uint8Array(32));
    const wrapper = {
      algorithm: "test-device-wrap",
      async wrap(secret: Uint8Array) {
        const ciphertext = secret.map((byte, index) => byte ^ mask[index % mask.length]!);
        return {
          algorithm: this.algorithm,
          ciphertextB64u: bytesToBase64url(ciphertext),
          ivB64u: "",
          params: {},
        };
      },
      async unwrap(wrapped: { ciphertextB64u: string }) {
        const encoded = Buffer.from(wrapped.ciphertextB64u, "base64url");
        return Uint8Array.from(encoded, (byte, index) => byte ^ mask[index % mask.length]!);
      },
    };
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapSecret(secret, wrapper);
    assert.equal(wrapped.algorithm, wrapper.algorithm);
    assert.notEqual(wrapped.ciphertextB64u, bytesToBase64url(secret));
    assert.deepEqual(await unwrapSecret(wrapped, wrapper), secret);
  });

  it("keeps only WebAuthn PRF and IndexedDB platform glue in LemmaComputer", async () => {
    const source = await readFile(
      new URL("../apps/web/src/openvtc-browser-agent.js", import.meta.url),
      "utf8",
    );
    assert.match(source, /from "@openvtc\/pnm-core"/);
    assert.match(source, /signTrustTask/);
    assert.match(source, /generateSigningIdentity/);
    assert.match(source, /wrapSecret/);
    assert.match(source, /unwrapSecret/);
    assert.doesNotMatch(source, /base58|canonicalize|subtle\.sign|importKey\("pkcs8"/i);
  });

  it("keeps protocol mechanics in pinned upstream dependencies behind an isolated service", async () => {
    const [control, client, cargo, browserPackage, compose, dockerfile] = await Promise.all([
      readFile(new URL("../apps/control-api/src/openvtc.ts", import.meta.url), "utf8"),
      readFile(new URL("../apps/control-api/src/openvtc-consent-client.ts", import.meta.url), "utf8"),
      readFile(new URL("../apps/openvtc-consent/Cargo.toml", import.meta.url), "utf8"),
      readFile(new URL("../apps/web/package.json", import.meta.url), "utf8"),
      readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
      readFile(new URL("../docker/Dockerfile.openvtc-consent", import.meta.url), "utf8"),
    ]);
    assert.doesNotMatch(`${control}\n${client}`, /base58|canonicalize|DataIntegrityProof|Ed25519/i);
    assert.match(cargo, /trust-tasks-rs = \{ version = "=0\.2\.37"/);
    assert.match(cargo, /trust-tasks-proof = \{ version = "=0\.2\.1"/);
    assert.match(cargo, /affinidi-data-integrity = "=0\.7\.7"/);
    assert.match(cargo, /vta-policy = "=0\.1\.0"/);
    assert.equal(JSON.parse(browserPackage).dependencies["@openvtc/pnm-core"], "0.2.0");
    assert.match(compose, /openvtc-consent:[\s\S]*?networks:\s+- consent-private/);
    assert.match(compose, /consent-private:\n {4}internal: true/);
    assert.match(dockerfile, /FROM rust:1\.95\.0-bookworm@sha256:/);
    await assert.rejects(
      readFile(new URL("../packages/openvtc-adapter/package.json", import.meta.url)),
      { code: "ENOENT" },
    );
  });
});
