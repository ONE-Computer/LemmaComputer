import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import {
  createInMemoryPlatformAuthenticationDatabase,
  createPlatformAuthentication,
  registerPlatformAuthenticationRoutes,
} from "../apps/control-api/src/platform-better-authentication.js";

const options = (overrides = {}) => ({
  database: createInMemoryPlatformAuthenticationDatabase(),
  baseUrl: "http://localhost:4174",
  trustedOrigins: ["http://localhost:4174"],
  versionedSecrets: [{ version: 1, value: "platform-authentication-test-secret-0000000001" }],
  installationKind: "worktree" as const,
  passkey: { rpId: "localhost", origin: "http://localhost:4174" },
  ...overrides,
});

test("platform Better Auth uses a separate strict passkey realm", () => {
  const authentication = createPlatformAuthentication(options());
  assert.equal(authentication.options.basePath, "/api/v1/auth/platform");
  assert.equal(authentication.options.advanced?.cookiePrefix, "lemmacomputer-platform");
  assert.equal(authentication.options.advanced?.crossSubDomainCookies?.enabled, false);
  assert.equal(authentication.options.session?.cookieCache?.enabled, false);
  assert.equal(authentication.options.rateLimit?.storage, "database");
  assert.equal(authentication.options.emailAndPassword?.enabled, true);
});

test("platform Better Auth rejects insecure or mismatched origins", () => {
  assert.throws(
    () => createPlatformAuthentication(options({ installationKind: "hosted" })),
    /requires HTTPS/i,
  );
  assert.throws(
    () => createPlatformAuthentication(options({ passkey: { rpId: "example.test", origin: "http://example.test" } })),
    /must match/i,
  );
});

test("the public platform authentication surface exposes passkeys but not credentials", async () => {
  const app = Fastify();
  const authentication = createPlatformAuthentication(options());
  const service = {
    assertDevelopmentOrigin: () => undefined,
    developmentBootstrap: async () => ({ enrolled: false, cookies: [] }),
    finalizeDevelopmentBootstrap: async () => ({ enrolled: true }),
  };
  registerPlatformAuthenticationRoutes(app, authentication, service as never, "worktree");

  const capabilities = await app.inject({ method: "GET", url: "/v1/auth/platform/capabilities" });
  assert.equal(capabilities.statusCode, 200);
  assert.deepEqual(capabilities.json(), { passkey: true, developmentBootstrap: true });

  for (const path of ["/sign-up/email", "/sign-in/email", "/change-password", "/delete-user"]) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/auth/platform${path}`,
      headers: { origin: "http://localhost:4174" },
      payload: {},
    });
    assert.equal(response.statusCode, 404, path);
  }
  await app.close();
});
