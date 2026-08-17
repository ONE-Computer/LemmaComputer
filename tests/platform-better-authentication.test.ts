import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import {
  BetterAuthPlatformOperatorAuthenticationService,
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
    bootstrapCapability: async () => ({ mode: "worktree" as const }),
    beginBootstrap: async () => ({ cookies: [] }),
    finalizeBootstrap: async () => undefined,
  };
  registerPlatformAuthenticationRoutes(app, authentication, service as never, "worktree");

  const capabilities = await app.inject({ method: "GET", url: "/v1/auth/platform/capabilities" });
  assert.equal(capabilities.statusCode, 200);
  assert.deepEqual(capabilities.json(), { passkey: true, bootstrap: { mode: "worktree" } });

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

test("hosted bootstrap requires the one-time secret without exposing credential endpoints", async () => {
  const app = Fastify();
  const authentication = createPlatformAuthentication(options({
    baseUrl: "https://platform.example.test",
    trustedOrigins: ["https://platform.example.test"],
    installationKind: "hosted",
    passkey: { rpId: "platform.example.test", origin: "https://platform.example.test" },
  }));
  let receivedSecret = "";
  const service = {
    bootstrapCapability: async () => ({ mode: "hosted" as const }),
    assertBootstrapOrigin: (origin: string | undefined) => assert.equal(origin, "https://platform.example.test"),
    beginBootstrap: async ({ secret }: { secret?: string }) => {
      receivedSecret = secret ?? "";
      return { cookies: [] };
    },
    finalizeBootstrap: async () => ({ enrolled: true }),
  };
  registerPlatformAuthenticationRoutes(app, authentication, service as never, "hosted");

  const rejected = await app.inject({
    method: "POST",
    url: "/v1/auth/platform/bootstrap",
    headers: { origin: "https://platform.example.test" },
    payload: {},
  });
  assert.equal(rejected.statusCode, 401);

  const accepted = await app.inject({
    method: "POST",
    url: "/v1/auth/platform/bootstrap",
    headers: { origin: "https://platform.example.test" },
    payload: { secret: "hosted-bootstrap-secret-at-least-32-characters" },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(receivedSecret, "hosted-bootstrap-secret-at-least-32-characters");

  const credentialRoute = await app.inject({
    method: "POST",
    url: "/v1/auth/platform/sign-in/email",
    headers: { origin: "https://platform.example.test" },
    payload: {},
  });
  assert.equal(credentialRoute.statusCode, 404);
  await app.close();
});

test("finishing enrollment permanently removes the bootstrap credential and temporary sessions", async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined,
  };
  const authentication = {
    api: {
      getSession: async () => ({
        user: { id: "operator-1", email: "operator@example.test" },
        session: {
          id: "temporary-session",
          createdAt: new Date("2026-08-17T00:00:00Z"),
          expiresAt: new Date("2026-08-17T01:00:00Z"),
        },
      }),
    },
  };
  const pool = {
    query: async () => ({ rows: [{ passkeys: 1, has_credential: true }], rowCount: 1 }),
    connect: async () => client,
  };
  const service = new BetterAuthPlatformOperatorAuthenticationService(
    authentication as never,
    pool as never,
    {} as never,
    "https://platform.example.test",
    {
      mode: "hosted",
      email: "operator@example.test",
      displayName: "Platform operator",
      secret: "one-time-bootstrap-secret-at-least-32-characters",
    },
  );

  assert.deepEqual(await service.finalizeBootstrap("session=temporary"), { enrolled: true });
  assert.deepEqual(statements, [
    "BEGIN",
    `DELETE FROM "account" WHERE "userId"=$1 AND "providerId"='credential'`,
    `DELETE FROM "session" WHERE "userId"=$1`,
    "COMMIT",
  ]);
});
