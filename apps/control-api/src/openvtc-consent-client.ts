import { LemmaComputerError, type OwnedJson } from "@lemmacomputer/contracts";

export type SignedConsentRequest = {
  document: OwnedJson;
  payloadDigest: string;
  documentHash: string;
  proofHash: string;
  signerDid: string;
  verificationMethod: string;
};

export type VerifiedEnrollment = {
  signerDid: string;
  verificationMethod: string;
  displayName: string;
  documentHash: string;
  proofHash: string;
};

export type VerifiedDecision = {
  signerDid: string;
  verificationMethod: string;
  challenge: string;
  payloadDigest: string;
  decision: "approve" | "deny";
  issuedAt: string;
  documentHash: string;
  proofHash: string;
};

export interface OpenVtcConsentClient {
  readonly executorDid: string;
  readonly verificationMethod: string;
  signRequest(input: Record<string, unknown>): Promise<SignedConsentRequest>;
  verifyEnrollment(input: Record<string, unknown>): Promise<VerifiedEnrollment>;
  verifyDecision(input: Record<string, unknown>): Promise<VerifiedDecision>;
}

type Profile = {
  executorDid: string;
  verificationMethod: string;
};

export class HttpOpenVtcConsentClient implements OpenVtcConsentClient {
  private constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    readonly executorDid: string,
    readonly verificationMethod: string,
  ) {}

  static async connect(baseUrl: string, token: string) {
    if (token.length < 32) throw new Error("OPENVTC_CONSENT_TOKEN must contain at least 32 characters");
    const normalized = baseUrl.replace(/\/+$/, "");
    const profile = await HttpOpenVtcConsentClient.request<Profile>(normalized, token, "/v1/profile");
    if (!profile.executorDid.startsWith("did:key:") || !profile.verificationMethod.startsWith(`${profile.executorDid}#`)) {
      throw new Error("OpenVTC consent service returned an invalid executor profile");
    }
    return new HttpOpenVtcConsentClient(
      normalized,
      token,
      profile.executorDid,
      profile.verificationMethod,
    );
  }

  signRequest(input: Record<string, unknown>) {
    return this.post<SignedConsentRequest>("/v1/task-consent/requests", input);
  }

  verifyEnrollment(input: Record<string, unknown>) {
    return this.post<VerifiedEnrollment>("/v1/enrollments/verify", input);
  }

  verifyDecision(input: Record<string, unknown>) {
    return this.post<VerifiedDecision>("/v1/task-consent/decisions/verify", input);
  }

  private post<T>(path: string, body: Record<string, unknown>) {
    return HttpOpenVtcConsentClient.request<T>(this.baseUrl, this.token, path, body);
  }

  private static async request<T>(
    baseUrl: string,
    token: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new LemmaComputerError(
        "OPENVTC_CONSENT_UNAVAILABLE",
        "The OpenVTC consent verifier is unavailable",
        503,
        true,
      );
    }
    const value = await response.json().catch(() => ({})) as {
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      throw new LemmaComputerError(
        value.error?.code ?? "OPENVTC_CONSENT_REJECTED",
        value.error?.message ?? "The OpenVTC consent verifier rejected the document",
        response.status,
        response.status >= 500,
      );
    }
    return value as T;
  }
}
