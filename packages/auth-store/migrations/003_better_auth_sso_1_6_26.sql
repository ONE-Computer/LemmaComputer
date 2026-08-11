-- id: 003
-- depends-on: 002
-- Generated from @better-auth/sso 1.6.26 with DNS domain verification enabled.
-- SSO credentials remain in the dedicated authentication database; organization
-- lifecycle and authorization projections remain in the product control store.

CREATE TABLE "ssoProvider" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "issuer" text NOT NULL,
  "oidcConfig" text,
  "samlConfig" text,
  "userId" uuid REFERENCES "user" ("id") ON DELETE CASCADE,
  "providerId" text NOT NULL UNIQUE,
  "organizationId" text,
  "domain" text NOT NULL,
  "domainVerified" boolean DEFAULT false
);

CREATE INDEX "ssoProvider_userId_idx" ON "ssoProvider" ("userId");
CREATE INDEX "ssoProvider_organizationId_idx" ON "ssoProvider" ("organizationId");
CREATE INDEX "ssoProvider_domain_idx" ON "ssoProvider" ("domain");
