-- id: 001
-- Generated from Better Auth 1.6.26 with UUID IDs, email/password, two-factor, and passkey plugins.
-- Reviewed and owned by the LemmaComputer authentication migration stream.

CREATE TABLE "user" ("id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE, "emailVerified" boolean NOT NULL, "image" text, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "twoFactorEnabled" boolean);

CREATE TABLE "session" ("id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY, "expiresAt" timestamptz NOT NULL, "token" text NOT NULL UNIQUE, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz NOT NULL, "ipAddress" text, "userAgent" text, "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE);

CREATE TABLE "account" ("id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL, "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz NOT NULL);

CREATE TABLE "verification" ("id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY, "identifier" text NOT NULL, "value" text NOT NULL, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL);

CREATE TABLE "twoFactor" ("id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY, "secret" text NOT NULL, "backupCodes" text NOT NULL, "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE, "verified" boolean, "failedVerificationCount" integer, "lockedUntil" timestamptz);

CREATE TABLE "passkey" ("id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY, "name" text, "publicKey" text NOT NULL, "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE, "credentialID" text NOT NULL, "counter" integer NOT NULL, "deviceType" text NOT NULL, "backedUp" boolean NOT NULL, "transports" text, "createdAt" timestamptz, "aaguid" text);

CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" ("secret");
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" ("userId");
CREATE INDEX "passkey_userId_idx" ON "passkey" ("userId");
CREATE INDEX "passkey_credentialID_idx" ON "passkey" ("credentialID");
