-- id: 01M06WHSSX5WNAW91F9XBX596T
-- depends-on: 01M06F7JEF78KK4CJX2YKSMN2G

ALTER TABLE workspaces
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deletion_content_disposition text
    CHECK (deletion_content_disposition IS NULL OR deletion_content_disposition IN ('preserve','delete')),
  ADD CONSTRAINT workspaces_deletion_state_consistent CHECK (
    (deleted_at IS NULL AND deletion_content_disposition IS NULL)
    OR (deleted_at IS NOT NULL AND deletion_content_disposition IS NOT NULL)
  );

CREATE INDEX workspaces_active_owner_idx
  ON workspaces (tenant_id,subject_id,created_at DESC,id)
  WHERE deleted_at IS NULL;
