import { generateKeyPairSync } from "node:crypto";
import type { IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import { PolicyBundleSigner, type PolicyVerificationKeySet } from "@lemmacomputer/policy-integrity";

export const policyFixture = (
  policy: RuntimePolicy,
  workspaceId: string,
  identity: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" },
) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = new PolicyBundleSigner({
    keyId: "psk_test_policy",
    privateKeyPkcs8Base64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  });
  const keys: PolicyVerificationKeySet = {
    profile: "lemmacomputer-policy-key-set/v1",
    keys: [{ ...signer.verificationKey(), status: "active" }],
  };
  const bundle = signer.issue({
    identity,
    workspaceId,
    policy,
    routes: {
      modelGateway: "http://litellm:4000",
      mcpControl: "http://lemmacomputer-control:4100",
    },
  });
  return { bundle, keys, signer };
};
