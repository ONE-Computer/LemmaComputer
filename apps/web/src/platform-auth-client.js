import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";

const client = createAuthClient({
  basePath: "/api/v1/auth/platform",
  plugins: [passkeyClient()],
});

const requireResult = async (operation) => {
  const result = await operation;
  if (result?.error) {
    const error = new Error(result.error.message ?? "Platform passkey verification was not completed.");
    error.code = result.error.code ?? "PLATFORM_PASSKEY_FAILED";
    throw error;
  }
  return result?.data ?? null;
};

const request = async (path, options = {}) => {
  const response = await fetch(`/api/v1/auth/platform${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? payload?.message ?? "Platform authentication was not completed.");
  return payload;
};

export const platformPasskeyApi = {
  capabilities: () => request("/capabilities"),
  signIn: () => requireResult(client.signIn.passkey()),
  add: (name = "Platform security key") => requireResult(client.passkey.addPasskey({ name })),
  beginBootstrap: (secret) => request("/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(secret ? { secret } : {}),
  }),
  finalizeBootstrap: () => request("/bootstrap/finalize", { method: "POST" }),
};
