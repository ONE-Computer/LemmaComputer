import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";

const client = createAuthClient({
  basePath: "/api/v1/auth/customer",
  plugins: [passkeyClient()],
});

const requireResult = async (operation) => {
  const result = await operation;
  if (result?.error) {
    const error = new Error(result.error.message ?? "Passkey verification was not completed.");
    error.code = result.error.code ?? "PASSKEY_FAILED";
    throw error;
  }
  return result?.data ?? null;
};

export const customerPasskeyApi = {
  signIn: () => requireResult(client.signIn.passkey()),
  add: (name = "This device") => requireResult(client.passkey.addPasskey({ name })),
};
