import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OwnedJson } from "@onecomputer/contracts";
import type {
  OpenVtcConsentClient,
  SignedConsentRequest,
  VerifiedDecision,
  VerifiedEnrollment,
} from "../../apps/control-api/src/openvtc-consent-client.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class TestDidSigner {
  readonly did = `did:key:zTest${randomBytes(24).toString("hex")}`;
  readonly verificationMethod = `${this.did}#${this.did.slice("did:key:".length)}`;

  constructor(private readonly secret = randomBytes(32).toString("hex")) {}

  sign(document: Record<string, unknown>) {
    const unsigned = structuredClone(document);
    delete unsigned.proof;
    return {
      ...unsigned,
      proof: {
        type: "DataIntegrityProof",
        cryptosuite: "eddsa-jcs-2022",
        verificationMethod: this.verificationMethod,
        created: unsigned.issuedAt,
        proofPurpose: "assertionMethod",
        proofValue: hash({ unsigned, secret: this.secret }),
      },
    };
  }

  verifies(document: Record<string, unknown>) {
    const proof = document.proof as Record<string, unknown> | undefined;
    const unsigned = structuredClone(document);
    delete unsigned.proof;
    return proof?.verificationMethod === this.verificationMethod
      && proof.proofValue === hash({ unsigned, secret: this.secret });
  }
}

export class TestOpenVtcConsentClient implements OpenVtcConsentClient {
  private readonly executor = new TestDidSigner();
  private readonly approvers = new Map<string, TestDidSigner>();
  readonly executorDid = this.executor.did;
  readonly verificationMethod = this.executor.verificationMethod;

  createApprover() {
    const signer = new TestDidSigner();
    this.approvers.set(signer.did, signer);
    return signer;
  }

  async signRequest(input: Record<string, unknown>): Promise<SignedConsentRequest> {
    const payloadDigest = hash({
      type: input.taskType,
      payload: input.taskPayload,
      challenge: input.challenge,
    });
    const document = this.executor.sign({
      id: input.id,
      type: "https://trusttasks.org/spec/task-consent/request/0.1",
      issuer: this.executorDid,
      recipient: input.recipientDid,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      payload: {
        challenge: input.challenge,
        taskType: input.taskType,
        payloadDigest,
        sideEffects: input.sideEffects,
        exposure: input.exposure,
        effects: input.effects,
        consequences: input.consequences,
        requester: input.requesterDid,
        approverSet: input.approverSet,
        minApprovals: input.minApprovals,
        excludeRequester: input.excludeRequester,
        expiresAt: input.expiresAt,
        subject: input.subject,
        origin: input.origin,
        statePin: input.statePin,
      },
    }) as OwnedJson;
    return {
      document,
      payloadDigest,
      documentHash: hash(document),
      proofHash: hash((document as Record<string, OwnedJson>).proof),
      signerDid: this.executorDid,
      verificationMethod: this.verificationMethod,
    };
  }

  async verifyEnrollment(input: Record<string, unknown>): Promise<VerifiedEnrollment> {
    const document = input.document as Record<string, unknown>;
    const expected = input.expected as Record<string, unknown>;
    const payload = document.payload as Record<string, unknown>;
    const signer = this.approvers.get(String(document.issuer));
    if (!signer?.verifies(document)
      || document.recipient !== expected.recipientDid
      || payload.challenge !== expected.challenge
      || payload.tenantId !== expected.tenantId
      || payload.subjectId !== expected.subjectId) {
      throw Object.assign(new Error("invalid enrollment"), { code: "OPENVTC_ENROLLMENT_PROOF_INVALID" });
    }
    return {
      signerDid: signer.did,
      verificationMethod: signer.verificationMethod,
      displayName: String(payload.displayName),
      documentHash: hash(document),
      proofHash: hash(document.proof),
    };
  }

  async verifyDecision(input: Record<string, unknown>): Promise<VerifiedDecision> {
    const document = input.document as Record<string, unknown>;
    const expected = input.expected as Record<string, unknown>;
    const payload = document.payload as Record<string, unknown>;
    const signer = this.approvers.get(String(document.issuer));
    const enrolled = (expected.enrolledApprovers as Array<Record<string, unknown>>)
      .some((approver) => approver.signerDid === signer?.did
        && approver.verificationMethod === signer?.verificationMethod);
    if (!signer?.verifies(document)
      || document.recipient !== expected.recipientDid
      || payload.challenge !== expected.challenge
      || payload.payloadDigest !== expected.payloadDigest
      || !enrolled) {
      throw Object.assign(new Error("invalid decision"), { code: "OPENVTC_DECISION_INVALID" });
    }
    return {
      signerDid: signer.did,
      verificationMethod: signer.verificationMethod,
      challenge: String(payload.challenge),
      payloadDigest: String(payload.payloadDigest),
      decision: payload.decision as "approve" | "deny",
      issuedAt: String(document.issuedAt),
      documentHash: hash(document),
      proofHash: hash(document.proof),
    };
  }

  enrollmentDocument(
    signer: TestDidSigner,
    challenge: Record<string, unknown>,
    tenantId: string,
    subjectId: string,
    displayName: string,
  ) {
    const issuedAt = new Date().toISOString();
    return signer.sign({
      id: `urn:uuid:${randomUUID()}`,
      type: "https://onecomputer.dev/spec/openvtc/approver-enrollment/0.1",
      issuer: signer.did,
      recipient: challenge.recipientDid,
      issuedAt,
      expiresAt: challenge.expiresAt,
      payload: {
        challenge: challenge.challenge,
        tenantId,
        subjectId,
        verificationMethod: signer.verificationMethod,
        displayName,
      },
    });
  }

  decisionDocument(signer: TestDidSigner, request: Record<string, unknown>, decision: "approve" | "deny") {
    const payload = request.payload as Record<string, unknown>;
    return signer.sign({
      id: `urn:uuid:${randomUUID()}`,
      type: "https://trusttasks.org/spec/task-consent/decision/0.1",
      issuer: signer.did,
      recipient: request.issuer,
      issuedAt: new Date().toISOString(),
      payload: {
        challenge: payload.challenge,
        payloadDigest: payload.payloadDigest,
        decision,
        reason: decision === "approve" ? "Approved." : "Denied.",
      },
    });
  }
}
