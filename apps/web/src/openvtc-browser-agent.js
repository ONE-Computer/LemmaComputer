import {
  base64urlToBytes,
  bytesToBase64url,
  generateSigningIdentity,
  signTrustTask,
  signingIdentityFromSecret,
  unwrapSecret,
  wrapSecret,
} from "@openvtc/pnm-core";

const STORE_NAME = "lemmacomputer-openvtc";
const RECORD_KEY = "browser-approver-v2";
const ENROLLMENT_TYPE = "https://lemmacomputer.dev/spec/openvtc/approver-enrollment/0.1";
const REQUEST_TYPE = "https://trusttasks.org/spec/task-consent/request/0.1";
const DECISION_TYPE = "https://trusttasks.org/spec/task-consent/decision/0.1";
const WRAP_ALGORITHM = "lemmacomputer-webauthn-prf-aes-gcm-v1";
const WRAP_INFO = new TextEncoder().encode("pnm/approver-secret/aes-gcm/v1");
const WRAP_AAD = new TextEncoder().encode("lemmacomputer/openvtc/browser-approver/v2");

const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(STORE_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("records");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const databaseOperation = async (mode, operation) => {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("records", mode);
      const request = operation(transaction.objectStore("records"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
};

const readRecord = () => databaseOperation("readonly", (store) => store.get(RECORD_KEY));
const writeRecord = (record) => databaseOperation("readwrite", (store) => store.put(record, RECORD_KEY));

export const clearBrowserApprover = async (expectedDid) => {
  const record = await readRecord();
  if (!record || (expectedDid && record.did !== expectedDid)) return false;
  await databaseOperation("readwrite", (store) => store.delete(RECORD_KEY));
  return true;
};

export const hasBrowserApprover = async (expectedDid) => {
  const record = await readRecord();
  return Boolean(record && (!expectedDid || record.did === expectedDid));
};

export const getBrowserApproverIdentity = async () => {
  const record = await readRecord();
  if (!record) return null;
  return {
    did: record.did,
    verificationMethod: record.verificationMethod,
    installationId: record.installationId,
  };
};

const prfOutput = (credential) => {
  const output = credential?.getClientExtensionResults?.()?.prf?.results?.first;
  if (!output) {
    throw new Error("This browser or device did not return a WebAuthn PRF. Use current Chrome with Windows Hello, Touch ID, or a compatible security key.");
  }
  return new Uint8Array(output);
};

const createPrfCredential = async () => {
  if (!window.PublicKeyCredential) throw new Error("This browser does not support device-verified approval.");
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: "LemmaComputer" },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "lemmacomputer-approver",
        displayName: "LemmaComputer approval device",
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -8 }, { type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  if (!credential) throw new Error("Device enrollment was cancelled.");
  return {
    credentialId: new Uint8Array(credential.rawId),
    salt,
    output: prfOutput(credential),
  };
};

const deriveWrapKey = async (output) => {
  const material = await crypto.subtle.importKey("raw", output, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(),
    info: WRAP_INFO,
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
};

class WebAuthnPrfWrap {
  algorithm = WRAP_ALGORITHM;

  constructor({ credentialId, salt, output, challenge }) {
    this.credentialId = credentialId;
    this.salt = salt;
    this.output = output;
    this.challenge = challenge;
  }

  async wrap(secret) {
    if (!this.output) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveWrapKey(this.output);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: WRAP_AAD },
      key,
      secret,
    );
    return {
      algorithm: this.algorithm,
      ciphertextB64u: bytesToBase64url(new Uint8Array(ciphertext)),
      ivB64u: bytesToBase64url(iv),
      params: {
        credentialId: bytesToBase64url(this.credentialId),
        prfSalt: bytesToBase64url(this.salt),
      },
    };
  }

  async unwrap(wrapped) {
    const assertion = await navigator.credentials.get({
      publicKey: {
        rpId: location.hostname,
        challenge: this.challenge,
        allowCredentials: [{
          type: "public-key",
          id: base64urlToBytes(wrapped.params.credentialId),
        }],
        userVerification: "required",
        extensions: {
          prf: { eval: { first: base64urlToBytes(wrapped.params.prfSalt) } },
        },
      },
    });
    if (!assertion) return null;
    const key = await deriveWrapKey(prfOutput(assertion));
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: base64urlToBytes(wrapped.ivB64u),
      additionalData: WRAP_AAD,
    }, key, base64urlToBytes(wrapped.ciphertextB64u));
    return new Uint8Array(plaintext);
  }
}

const encodeBundle = (identity, transportToken, executorDid) => new TextEncoder().encode(JSON.stringify({
  privateKey: bytesToBase64url(identity.privateKey),
  transportToken,
  executorDid,
}));

const decodeBundle = (bytes) => {
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value.privateKey !== "string" || typeof value.transportToken !== "string"
    || typeof value.executorDid !== "string") {
    throw new Error("The protected approval identity is invalid.");
  }
  return {
    identity: signingIdentityFromSecret(base64urlToBytes(value.privateKey)),
    transportToken: value.transportToken,
    executorDid: value.executorDid,
  };
};

const unlock = async (record, payloadDigest) => {
  const challenge = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payloadDigest),
  ));
  const wrap = new WebAuthnPrfWrap({ challenge });
  return decodeBundle(await unwrapSecret(record.wrappedSecret, wrap));
};

export async function enrollBrowserApprover(challenge, displayName, enroll, rollback) {
  const credential = await createPrfCredential();
  const identity = generateSigningIdentity();
  const unsigned = {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ENROLLMENT_TYPE,
    issuer: identity.did,
    recipient: challenge.recipientDid,
    issuedAt: new Date().toISOString(),
    expiresAt: challenge.expiresAt,
    payload: {
      challenge: challenge.challenge,
      tenantId: challenge.tenantId,
      subjectId: challenge.subjectId,
      verificationMethod: identity.kid,
      displayName,
    },
  };
  const document = await signTrustTask({ envelope: unsigned, signing: identity });
  const response = await enroll(document);
  const wrap = new WebAuthnPrfWrap(credential);
  const wrappedSecret = await wrapSecret(
    encodeBundle(identity, response.transportToken, challenge.recipientDid),
    wrap,
  );
  try {
    await writeRecord({
      version: 2,
      installationId: crypto.randomUUID(),
      did: identity.did,
      verificationMethod: identity.kid,
      wrappedSecret,
    });
  } catch (error) {
    await rollback?.(identity.did).catch(() => undefined);
    throw new Error("The device key could not be saved in this browser profile. The incomplete enrollment was removed; check that persistent site storage is enabled and try again.", { cause: error });
  }
  return { did: identity.did, displayName, ...(await getBrowserApproverIdentity()) };
}

export const validateRequest = (request, record, executorDid) => {
  const payload = request?.payload;
  const proof = request?.proof;
  if (!request || request.type !== REQUEST_TYPE || request.issuer !== executorDid
    || request.recipient !== record.did || !payload || typeof payload !== "object") {
    throw new Error("The approval request is not addressed by the enrolled LemmaComputer executor to this browser.");
  }
  if (request.expiresAt !== payload.expiresAt || Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error("This approval request has expired.");
  }
  if (typeof payload.payloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(payload.payloadDigest)
    || typeof payload.challenge !== "string" || payload.challenge.length < 16
    || !Array.isArray(payload.effects)
    || payload.effects.some((effect) => !effect || typeof effect.summary !== "string" || !effect.summary)) {
    throw new Error("The approval request does not match the Task Consent schema.");
  }
  const multikey = executorDid.slice("did:key:".length);
  if (!proof || proof.type !== "DataIntegrityProof" || proof.cryptosuite !== "eddsa-jcs-2022"
    || proof.proofPurpose !== "assertionMethod"
    || proof.verificationMethod !== `${executorDid}#${multikey}`
    || typeof proof.proofValue !== "string") {
    throw new Error("The approval request does not carry the pinned executor proof profile.");
  }
  return request;
};

export async function loadPendingApproval(fetchInbox, executorDid) {
  const record = await readRecord();
  if (!record) throw new Error("This browser is not enrolled as an approval device.");
  const request = await fetchInbox();
  return request ? validateRequest(request, record, executorDid) : null;
}

export async function signApprovalDecision(request, decision) {
  const payloadDigest = request?.payload?.payloadDigest;
  if (typeof payloadDigest !== "string") throw new Error("The pending request does not contain an operation digest.");
  if (decision !== "approve" && decision !== "deny") throw new Error("The approval decision is invalid.");
  const record = await readRecord();
  if (!record) throw new Error("This browser is not enrolled as an approval device.");
  const bundle = await unlock(record, payloadDigest);
  validateRequest(request, record, bundle.executorDid);
  const document = {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: DECISION_TYPE,
    issuer: bundle.identity.did,
    recipient: request.issuer,
    issuedAt: new Date().toISOString(),
    payload: {
      challenge: request.payload.challenge,
      payloadDigest,
      decision,
      reason: decision === "approve"
        ? "The user verified the signed effects."
        : "The user rejected this operation.",
    },
  };
  await signTrustTask({ envelope: document, signing: bundle.identity });
  return { transportToken: bundle.transportToken, document };
}
