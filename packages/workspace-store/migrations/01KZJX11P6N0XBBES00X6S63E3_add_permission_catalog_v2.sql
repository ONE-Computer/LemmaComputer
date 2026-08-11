-- id: 01KZJX11P6N0XBBES00X6S63E3
-- depends-on: 01KZJSHAKHV0E5FKK58XAG59A3

-- Preserve the complete v1 permission and protected-role snapshot while new
-- custom role versions begin recording catalog v2. Later catalog additions
-- must be explicit v2 rows and never mutate the v1 snapshot.

INSERT INTO organization_permission_catalog_versions (version,description)
VALUES (2,'Tenant role snapshots resolved independently by catalog version');

INSERT INTO organization_permissions (catalog_version,permission_key,description)
SELECT 2,permission_key,description
FROM organization_permissions
WHERE catalog_version=1;

INSERT INTO organization_role_permissions (catalog_version,role,permission_key)
SELECT 2,role,permission_key
FROM organization_role_permissions
WHERE catalog_version=1;
