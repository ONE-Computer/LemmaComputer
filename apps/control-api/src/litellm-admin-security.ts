export type LiteLlmAdminMutualTls = {
  ca: string;
  clientCertificate: string;
  clientKey: string;
  serverName: string;
};

type HostedLiteLlmAdminSecurityInput = {
  installationKind: "customer-managed" | "hosted" | "worktree";
  adminUrl?: string;
  credentialSecret?: string;
  sessionSecret: string;
  workspaceIngressSecret?: string;
  caBase64?: string;
  clientCertificateBase64?: string;
  clientKeyBase64?: string;
  serverName?: string;
};

const mutualTlsError = "Hosted LiteLLM administration requires HTTPS mutual TLS with a CA and Control client certificate";

const decodePem = (name: string, encoded: string | undefined, marker: string) => {
  if (!encoded) throw new Error(mutualTlsError);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error(`${name} must be base64-encoded PEM material`);
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (!decoded.includes(marker)) throw new Error(`${name} must contain ${marker}`);
  return decoded;
};

/**
 * Hosted installations put the LiteLLM administration API behind a dedicated
 * mutual-TLS listener. Customer-managed and worktree deployments retain their
 * explicit local transport configuration, while hosted startup fails closed.
 */
export const assertHostedLiteLlmAdminSecurity = (input: HostedLiteLlmAdminSecurityInput): LiteLlmAdminMutualTls | undefined => {
  if (input.installationKind !== "hosted") return undefined;
  if (!input.adminUrl || !input.credentialSecret) throw new Error("Hosted LiteLLM administration must be configured");
  if (input.credentialSecret === input.sessionSecret || input.credentialSecret === input.workspaceIngressSecret) {
    throw new Error("LITELLM_CREDENTIAL_SECRET must not equal a session or workspace-ingress secret in hosted installations");
  }

  let adminUrl: URL;
  try {
    adminUrl = new URL(input.adminUrl);
  } catch {
    throw new Error(mutualTlsError);
  }
  if (adminUrl.protocol !== "https:") throw new Error(mutualTlsError);

  return {
    ca: decodePem("LITELLM_ADMIN_TLS_CA_B64", input.caBase64, "-----BEGIN CERTIFICATE-----"),
    clientCertificate: decodePem("LITELLM_ADMIN_TLS_CLIENT_CERT_B64", input.clientCertificateBase64, "-----BEGIN CERTIFICATE-----"),
    clientKey: decodePem("LITELLM_ADMIN_TLS_CLIENT_KEY_B64", input.clientKeyBase64, "-----BEGIN"),
    serverName: input.serverName?.trim() || adminUrl.hostname,
  };
};
