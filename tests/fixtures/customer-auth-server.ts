import { MemoryWorkspaceStore, type CustomerProductSessionStore } from "@lemmacomputer/workspace-store";

import {
  createCustomerAuthentication,
  createInMemoryCustomerAuthenticationDatabase,
  customerAuthenticationBasePath,
} from "../../apps/control-api/src/customer-authentication.js";
import {
  createBetterAuthSessionReader,
  CustomerProductAuthenticationService,
} from "../../apps/control-api/src/customer-product-authentication.js";
import { createControlServer } from "../../apps/control-api/src/server.js";
import type { ControllerClient } from "../../apps/control-api/src/service.js";
import { CaptureTransactionalEmailAdapter } from "../../apps/control-api/src/transactional-email.js";

const host = "127.0.0.1";
const port = Number(process.env.CUSTOMER_AUTH_FIXTURE_PORT ?? 4_409);
const webOrigin = process.env.CUSTOMER_AUTH_FIXTURE_WEB_ORIGIN ?? "http://localhost:24975";
const proxyToken = "customer-auth-browser-fixture-proxy-token";
const emailAddress = "passkey@example.test";
const password = "correct horse battery staple";
const email = new CaptureTransactionalEmailAdapter();
const authentication = createCustomerAuthentication({
  database: createInMemoryCustomerAuthenticationDatabase(),
  baseUrl: webOrigin,
  trustedOrigins: [webOrigin],
  versionedSecrets: [{ version: 1, value: "customer-auth-browser-fixture-secret-32-characters" }],
  installationKind: "customer-managed",
  email,
  passkey: { rpId: new URL(webOrigin).hostname, origin: webOrigin },
});

const authRequest = (path: string, body: Record<string, unknown>) => new Request(
  `${webOrigin}${customerAuthenticationBasePath}${path}`,
  {
    method: "POST",
    headers: { origin: webOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  },
);

await authentication.handler(authRequest("/sign-up/email", {
  name: "Passkey Tester",
  email: emailAddress,
  password,
}));
const verificationUrl = email.take(emailAddress, "email-verification")?.text.match(/https?:\/\/\S+/)?.[0];
if (!verificationUrl) throw new Error("Customer authentication fixture did not capture its verification URL");
const verified = await authentication.handler(new Request(verificationUrl, { headers: { origin: webOrigin } }));
if (verified.status !== 302) throw new Error(`Customer authentication fixture verification failed with ${verified.status}`);

const productStore: CustomerProductSessionStore = {
  ensureCustomerAccount: async (input) => ({ accountUserId: input.accountUserId, status: "active" }),
  listCustomerMemberships: async () => [],
  getCustomerProductSession: async () => null,
  selectCustomerProductSession: async () => { throw new Error("The passkey browser fixture has no tenant memberships"); },
  revokeCustomerProductSession: async () => {},
  clearCustomerProductSession: async () => {},
};
const productAuthentication = new CustomerProductAuthenticationService(
  createBetterAuthSessionReader(authentication),
  productStore,
);
const app = createControlServer(
  new MemoryWorkspaceStore(),
  {} as ControllerClient,
  proxyToken,
  undefined,
  undefined,
  { installationKind: "customer-managed", publicWebUrl: webOrigin },
  {
    customerAuthentication: authentication,
    customerProductAuthentication: productAuthentication,
    agentBridgeSecret: "customer-auth-browser-fixture-agent-secret-32-characters",
  },
);

await app.listen({ host, port });
const shutdown = () => app.close().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
