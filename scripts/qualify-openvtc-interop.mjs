import assert from "node:assert/strict";
import { generateSigningIdentity, signTrustTask } from "@openvtc/pnm-core";
import { validateRequest } from "../apps/web/src/openvtc-browser-agent.js";

const baseUrl = (process.env.OPENVTC_CONSENT_URL ?? "http://127.0.0.1:18788").replace(/\/+$/, "");
const token = process.env.OPENVTC_CONSENT_TOKEN;
assert.ok(token?.length >= 32, "OPENVTC_CONSENT_TOKEN must contain at least 32 characters");

const request = async (path, body, expectedStatus = 200, authorization = token) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${authorization}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(value));
  return value;
};

await request("/v1/profile", undefined, 401, "invalid");
const profile = await request("/v1/profile");
const identity = generateSigningIdentity();
const issuedAt = new Date();
const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
const challenge = crypto.randomUUID();

const signedRequest = await request("/v1/task-consent/requests", {
  id: `urn:uuid:${crypto.randomUUID()}`,
  recipientDid: identity.did,
  issuedAt: issuedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
  challenge,
  taskType: "https://onecomputer.dev/spec/microsoft365/tool-call/0.1",
  taskPayload: {
    operationDigest: "a".repeat(64),
    arguments: { itemId: "qualification-item", private: "must-not-cross-consent-boundary" },
  },
  requesterDid: "did:onecomputer:agent:qualification",
  approverSet: "onecomputer-workspace-owners",
  minApprovals: 1,
  excludeRequester: true,
  sideEffects: "destructive",
  exposure: { discloses: "none", actsAsSubject: true },
  effects: [{ kind: "delete", summary: "Delete the qualification item." }],
  consequences: ["The qualification item is removed."],
  subject: "urn:onecomputer:operation:qualification",
  origin: "ONEComputer Control",
  statePin: { resource: "qualification-item", version: "etag-1" },
});
assert.equal(signedRequest.document.issuer, profile.executorDid);
assert.equal(signedRequest.document.recipient, identity.did);
assert.equal(signedRequest.document.payload.payloadDigest, signedRequest.payloadDigest);
assert.ok(!JSON.stringify(signedRequest.document).includes("must-not-cross-consent-boundary"));
assert.equal(
  validateRequest(signedRequest.document, { did: identity.did }, profile.executorDid),
  signedRequest.document,
);

const enrollmentChallenge = crypto.randomUUID();
const enrollment = await signTrustTask({
  envelope: {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: "https://onecomputer.dev/spec/openvtc/approver-enrollment/0.1",
    issuer: identity.did,
    recipient: profile.executorDid,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
    payload: {
      challenge: enrollmentChallenge,
      tenantId: "qualification-tenant",
      subjectId: "qualification-subject",
      verificationMethod: identity.kid,
      displayName: "SDK qualification browser",
    },
  },
  signing: identity,
});
const verifiedEnrollment = await request("/v1/enrollments/verify", {
  document: enrollment,
  expected: {
    recipientDid: profile.executorDid,
    challenge: enrollmentChallenge,
    tenantId: "qualification-tenant",
    subjectId: "qualification-subject",
  },
  now: new Date().toISOString(),
});
assert.equal(verifiedEnrollment.signerDid, identity.did);
assert.equal(verifiedEnrollment.verificationMethod, identity.kid);

const signDecision = (decision) => signTrustTask({
  envelope: {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: "https://trusttasks.org/spec/task-consent/decision/0.1",
    issuer: identity.did,
    recipient: profile.executorDid,
    issuedAt: new Date().toISOString(),
    payload: { challenge, payloadDigest: signedRequest.payloadDigest, decision },
  },
  signing: identity,
});
const expected = {
  recipientDid: profile.executorDid,
  challenge,
  payloadDigest: signedRequest.payloadDigest,
  enrolledApprovers: [{ signerDid: identity.did, verificationMethod: identity.kid }],
  requestIssuedAt: signedRequest.document.issuedAt,
  requestExpiresAt: signedRequest.document.expiresAt,
  requesterDid: signedRequest.document.payload.requester,
  excludeRequester: true,
};

for (const decision of ["approve", "deny"]) {
  const document = await signDecision(decision);
  const verified = await request("/v1/task-consent/decisions/verify", {
    document,
    expected,
    now: new Date().toISOString(),
  });
  assert.equal(verified.signerDid, identity.did);
  assert.equal(verified.decision, decision);
}

await request("/v1/task-consent/decisions/verify", {
  document: await signDecision("approve"),
  expected: {
    ...expected,
    enrolledApprovers: [{ signerDid: identity.did, verificationMethod: "did:key:zWrong#zWrong" }],
  },
  now: new Date().toISOString(),
}, 403);

const tampered = structuredClone(await signDecision("approve"));
tampered.payload.payloadDigest = "b".repeat(64);
await request("/v1/task-consent/decisions/verify", {
  document: tampered,
  expected,
  now: new Date().toISOString(),
}, 403);

const extended = structuredClone(await signDecision("approve"));
extended.proof.unexpected = true;
await request("/v1/task-consent/decisions/verify", {
  document: extended,
  expected,
  now: new Date().toISOString(),
}, 400);

console.log(JSON.stringify({
  ok: true,
  executorDid: profile.executorDid,
  approverDid: identity.did,
  requestDigest: signedRequest.payloadDigest,
  verified: [
    "enrollment",
    "approve",
    "deny",
    "wrong-enrolled-key-rejection",
    "tamper-rejection",
    "unknown-field-rejection",
  ],
}));
