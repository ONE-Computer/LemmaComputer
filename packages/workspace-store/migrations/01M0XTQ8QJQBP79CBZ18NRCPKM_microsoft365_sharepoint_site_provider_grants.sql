-- id: 01M0XTQ8QJQBP79CBZ18NRCPKM
-- depends-on: 01M0W7D54NCGXCF0Q94QEM2CKA

-- Track the SharePoint-side application permission independently from the
-- user-token verification state. The permission id is a non-secret Microsoft
-- Graph identifier retained as grant evidence; revocation re-resolves the
-- connector application identity before deleting provider state.
ALTER TABLE microsoft365_sharepoint_sites
  ADD COLUMN microsoft_access_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN microsoft_permission_id text,
  ADD COLUMN microsoft_granted_at timestamptz,
  ADD COLUMN microsoft_last_error text,
  ADD CONSTRAINT microsoft365_sharepoint_sites_microsoft_status
    CHECK (microsoft_access_status IN ('pending','granted','grant_failed','revocation_failed')),
  ADD CONSTRAINT microsoft365_sharepoint_sites_microsoft_permission_id
    CHECK (microsoft_permission_id IS NULL OR char_length(microsoft_permission_id) BETWEEN 1 AND 1000),
  ADD CONSTRAINT microsoft365_sharepoint_sites_microsoft_error_size
    CHECK (microsoft_last_error IS NULL OR char_length(microsoft_last_error)<=320),
  ADD CONSTRAINT microsoft365_sharepoint_sites_microsoft_grant_state
    CHECK (
      (microsoft_access_status='granted'
        AND graph_site_id IS NOT NULL
        AND microsoft_permission_id IS NOT NULL
        AND microsoft_granted_at IS NOT NULL
        AND microsoft_last_error IS NULL)
      OR microsoft_access_status<>'granted'
    );

CREATE INDEX microsoft365_sharepoint_sites_tenant_microsoft_status_idx
  ON microsoft365_sharepoint_sites (tenant_id,microsoft_access_status,display_name,id);
