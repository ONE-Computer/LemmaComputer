-- id: 01M04J2FFVE8G7Q5NEWD3AEXMQ
-- depends-on: 01M04E6G7SJQN3J23VZEWQXJS7

-- Expand the universal tenant boundary so consumer-owned personal tenants can
-- be distinguished from customer organizations without weakening the existing
-- tenant keys. Existing records and old writers remain organizations.
ALTER TABLE tenants
  ADD COLUMN kind text NOT NULL DEFAULT 'organization'
    CHECK (kind IN ('personal','organization')),
  ADD COLUMN personal_owner_account_user_id uuid
    REFERENCES account_users(id) ON DELETE RESTRICT;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_personal_owner_kind_check CHECK (
    (kind='personal' AND personal_owner_account_user_id IS NOT NULL)
    OR (kind='organization' AND personal_owner_account_user_id IS NULL)
  );

CREATE UNIQUE INDEX tenants_personal_owner_account_unique_idx
  ON tenants(personal_owner_account_user_id)
  WHERE personal_owner_account_user_id IS NOT NULL;

CREATE INDEX tenants_kind_display_name_idx
  ON tenants(kind,display_name,id);

-- Forward-only migration. Add safe, bounded SQL below.
