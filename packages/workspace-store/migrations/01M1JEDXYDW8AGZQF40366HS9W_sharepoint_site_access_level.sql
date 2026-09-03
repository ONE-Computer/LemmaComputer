-- id: 01M1JEDXYDW8AGZQF40366HS9W
-- depends-on: 01M1GDG2M2DPHKFGFXKN6KCTKK

-- Persist the access level requested for the everyday Workplace Connector's
-- selected-site grant. Existing rows remain nullable for rollback compatibility;
-- new code treats NULL as read-only and writes an explicit value.
ALTER TABLE microsoft365_sharepoint_sites
  ADD COLUMN access_level text,
  ADD CONSTRAINT microsoft365_sharepoint_sites_access_level
    CHECK (access_level IS NULL OR access_level IN ('read','write'));
