-- id: 01M05MEN1QT5MS0XVFXMAJJ3EH
-- depends-on: 01M05M01EAJ9SF3JCT5WAGFMPK

-- A catalog connector that needs a provider OAuth application currently uses
-- one deployment-wide client read from config/litellm/config.yaml at gateway
-- boot. This lets a tenant administrator supply its own application instead,
-- for that tenant alone.
--
-- `credential_mode` records which client a tenant's row uses. `deployment`
-- means the shared gateway row and the deployment-wide client; `tenant` means a
-- LiteLLM row created for this tenant and carrying its own client.
--
-- Only the client id is stored, and only so the screen can show which
-- application is configured. The secret is never written here: it goes straight
-- to LiteLLM, which encrypts both values under LITELLM_SALT_KEY. Rotating
-- LITELLM_SALT_KEY therefore re-encrypts every tenant's credentials at once.
ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS credential_mode TEXT NOT NULL DEFAULT 'deployment',
  ADD COLUMN IF NOT EXISTS oauth_client_id TEXT,
  ADD COLUMN IF NOT EXISTS credentials_updated_by TEXT,
  ADD COLUMN IF NOT EXISTS credentials_updated_at TIMESTAMPTZ;

ALTER TABLE connector_registry
  ADD CONSTRAINT connector_registry_credential_mode
  CHECK (credential_mode IN ('deployment','tenant')) NOT VALID,
  -- A tenant-supplied application is exactly the case that has a client id to
  -- show, so the mode and the recorded client cannot disagree.
  ADD CONSTRAINT connector_registry_tenant_credentials
  CHECK ((credential_mode = 'tenant') = (oauth_client_id IS NOT NULL)) NOT VALID;

ALTER TABLE connector_registry
  VALIDATE CONSTRAINT connector_registry_credential_mode,
  VALIDATE CONSTRAINT connector_registry_tenant_credentials;
