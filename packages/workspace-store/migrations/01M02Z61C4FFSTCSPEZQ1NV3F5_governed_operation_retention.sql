-- id: 01M02Z61C4FFSTCSPEZQ1NV3F5
-- depends-on: 01M01ZJZ86BZ21SD78N3J9SQGN

ALTER TABLE governed_operations
  DROP CONSTRAINT governed_operations_workspace_id_fkey,
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD CONSTRAINT governed_operations_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
