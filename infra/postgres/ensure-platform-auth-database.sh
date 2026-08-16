#!/bin/sh
set -eu

# docker-entrypoint-initdb.d runs only for a new PostgreSQL volume. This
# idempotent Compose job also expands an existing worktree volume without
# deleting its customer, control, or LiteLLM data.
psql --dbname postgres \
  --set=platform_auth_runtime_password="$LEMMACOMPUTER_PLATFORM_AUTH_POSTGRES_RUNTIME_PASSWORD" \
  --set=platform_auth_migrator_password="$LEMMACOMPUTER_PLATFORM_AUTH_POSTGRES_MIGRATOR_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE lemmacomputer_platform_auth_runtime LOGIN PASSWORD %L', :'platform_auth_runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lemmacomputer_platform_auth_runtime') \gexec
SELECT format('CREATE ROLE lemmacomputer_platform_auth_migrator LOGIN PASSWORD %L', :'platform_auth_migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lemmacomputer_platform_auth_migrator') \gexec
SELECT format('ALTER ROLE lemmacomputer_platform_auth_runtime LOGIN PASSWORD %L', :'platform_auth_runtime_password') \gexec
SELECT format('ALTER ROLE lemmacomputer_platform_auth_migrator LOGIN PASSWORD %L', :'platform_auth_migrator_password') \gexec
SELECT 'CREATE DATABASE lemmacomputer_platform_auth OWNER lemmacomputer_platform_auth_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'lemmacomputer_platform_auth') \gexec
SQL

psql --dbname lemmacomputer_platform_auth <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO lemmacomputer_platform_auth_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lemmacomputer_platform_auth_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lemmacomputer_platform_auth_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lemmacomputer_platform_auth_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO lemmacomputer_platform_auth_runtime;
SQL
