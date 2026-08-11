-- id: 01KZP5PQK4ZC0B1WG1HD8RWV0A
-- depends-on: 01KZMR12CE9ER3JM1H17J8V1F8

-- Preserve v1 and v2 as immutable historical snapshots. Catalog v3 separates
-- creating a subject-owned workspace from broad workspace administration.

INSERT INTO organization_permission_catalog_versions (version,description)
VALUES (3,'Member-owned workspace creation separated from workspace administration');

INSERT INTO organization_permissions (catalog_version,permission_key,description)
SELECT 3,permission_key,description
FROM organization_permissions
WHERE catalog_version=2;

INSERT INTO organization_permissions (catalog_version,permission_key,description)
VALUES
  (3,'workspace.create','Create a member-owned organization workspace'),
  (3,'workspace.manage_own','Manage a workspace owned by the signed-in member');

INSERT INTO organization_role_permissions (catalog_version,role,permission_key)
SELECT 3,role,permission_key
FROM organization_role_permissions
WHERE catalog_version=2;

INSERT INTO organization_role_permissions (catalog_version,role,permission_key) VALUES
  (3,'owner','workspace.create'),
  (3,'admin','workspace.create'),
  (3,'member','workspace.create'),
  (3,'owner','workspace.manage_own'),
  (3,'admin','workspace.manage_own'),
  (3,'member','workspace.manage_own');

ALTER TABLE organization_memberships
  ALTER COLUMN permission_catalog_version SET DEFAULT 3;

UPDATE organization_memberships
SET permission_catalog_version=3
WHERE permission_catalog_version IN (1,2);
