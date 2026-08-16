-- id: 01M05M01EAJ9SF3JCT5WAGFMPK
-- depends-on: 01M051Q03ZNRE1JVFF84B2G7GT

-- Tenant-owned connectors previously derived their LiteLLM `server_name` from
-- the tenant-supplied connector name and were checked for uniqueness only
-- inside their own tenant. LiteLLM keys `LiteLLM_MCPServerTable` on
-- `server_id` alone and the adapter resolves a connection by name, so in a
-- shared gateway two tenants could hold two rows named
-- `lemmacomputer_reports` and resolve between them arbitrarily.
--
-- Recompute every tenant-owned name from that row's already unique
-- `server_id`. This mirrors `tenantOwnedServerName` in
-- apps/control-api/src/connector-catalog.ts; keep the two in step. Renaming
-- the registry record is safe on its own: Control reconciles the gateway row
-- by server id on the next read, which renames it in place and preserves both
-- its stored OAuth client and every per-user token, because the gateway purges
-- tokens only for a mint-relevant change and the name is not one.
--
-- Built-in rows are untouched. Every tenant's built-in entry deliberately
-- names the same shared gateway server.
UPDATE connector_registry SET
  server_name =
    left(
      'lemmacomputer_' || replace(id, '-', '_'),
      96 - length(lower(regexp_replace(server_id, '[^0-9a-zA-Z]', '', 'g'))) - 1
    )
    || '_' || lower(regexp_replace(server_id, '[^0-9a-zA-Z]', '', 'g'))
WHERE source = 'custom';

-- The tenant-scoped UNIQUE (tenant_id, server_name) from 022 stays for the
-- built-in rows it still describes. This adds the constraint the shared
-- gateway actually needs, so a future collision fails closed at the database
-- instead of resolving to another tenant's connector.
CREATE UNIQUE INDEX IF NOT EXISTS connector_registry_custom_server_name_key
  ON connector_registry (server_name)
  WHERE source = 'custom';
