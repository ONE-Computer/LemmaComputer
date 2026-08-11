-- id: 002
-- depends-on: 001
-- Generated from Better Auth 1.6.26 with shared database rate-limit storage enabled.

CREATE TABLE "rateLimit" ("id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY, "key" text NOT NULL UNIQUE, "count" integer NOT NULL, "lastRequest" bigint NOT NULL);
