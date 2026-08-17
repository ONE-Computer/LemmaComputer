-- id: 01M075NBF74WSAD70GTP88CFG9
-- depends-on: 01M06WHSSX5WNAW91F9XBX596T

-- Workspace-independent history and artifact library pagination remains
-- owner-scoped. Partial indexes exclude content already staged for deletion.
CREATE INDEX chat_conversations_owner_library_idx
  ON chat_conversations (tenant_id,owner_subject_id,updated_at DESC,id DESC)
  WHERE state='active';

CREATE INDEX artifacts_owner_library_idx
  ON artifacts (tenant_id,creator_subject_id,updated_at DESC,id DESC)
  WHERE state='available';
