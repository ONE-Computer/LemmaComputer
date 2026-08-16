-- id: 01M06F7JEF78KK4CJX2YKSMN2G
-- depends-on: 01M05MEN1QT5MS0XVFXMAJJ3EH

-- Microsoft 365 asks for tenant-wide Graph permissions that no ordinary user
-- can consent to, so an employee who selects Connect reaches a terminal "Need
-- admin approval" page and never returns. The fix is a link that employee can
-- send to their IT administrator, and a landing route that records the grant
-- when the administrator completes it.
--
-- Consent is a fact about one organization's use of one connector, which is
-- exactly the grain of connector_registry, so it lives here rather than in a
-- table of its own.
--
-- `admin_consent_provider_tenant_id` is the directory that granted it, which
-- the provider returns on the consent redirect. It is recorded so a grant can
-- be told apart from a grant by a different directory, for instance after a
-- customer migrates tenants.
ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS admin_consent_granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_consent_provider_tenant_id TEXT,
  ADD COLUMN IF NOT EXISTS admin_consent_requested_by TEXT;

ALTER TABLE connector_registry
  ADD CONSTRAINT connector_registry_admin_consent
  CHECK ((admin_consent_granted_at IS NULL) = (admin_consent_provider_tenant_id IS NULL)) NOT VALID;

ALTER TABLE connector_registry
  VALIDATE CONSTRAINT connector_registry_admin_consent;
