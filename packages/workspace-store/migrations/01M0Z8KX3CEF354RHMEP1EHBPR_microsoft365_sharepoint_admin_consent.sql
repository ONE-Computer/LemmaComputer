-- id: 01M0Z8KX3CEF354RHMEP1EHBPR
-- depends-on: 01M0XTQ8QJQBP79CBZ18NRCPKM

-- Record the separate multi-tenant enterprise-application consent used only
-- to administer selected SharePoint site grants. These nullable columns are
-- independent from the connector's ordinary delegated admin consent.
ALTER TABLE connector_registry
  ADD COLUMN sharepoint_admin_consent_granted_at timestamptz,
  ADD COLUMN sharepoint_admin_consent_provider_tenant_id text,
  ADD COLUMN sharepoint_admin_consent_requested_by text,
  ADD CONSTRAINT connector_registry_sharepoint_admin_consent
    CHECK (
      (sharepoint_admin_consent_granted_at IS NULL)
      = (sharepoint_admin_consent_provider_tenant_id IS NULL)
    );
