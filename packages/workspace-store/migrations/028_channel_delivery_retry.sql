ALTER TABLE channel_updates
  ADD COLUMN IF NOT EXISTS response_chat_id text NULL,
  ADD COLUMN IF NOT EXISTS response_text text NULL,
  ADD COLUMN IF NOT EXISTS response_offset integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_state text NULL,
  ADD COLUMN IF NOT EXISTS final_failure_code text NULL;

ALTER TABLE channel_updates
  DROP CONSTRAINT IF EXISTS channel_updates_response_chat_id_check,
  ADD CONSTRAINT channel_updates_response_chat_id_check
    CHECK (response_chat_id IS NULL OR response_chat_id ~ '^-?[0-9]{1,20}$'),
  DROP CONSTRAINT IF EXISTS channel_updates_response_offset_check,
  ADD CONSTRAINT channel_updates_response_offset_check
    CHECK (response_offset >= 0),
  DROP CONSTRAINT IF EXISTS channel_updates_final_state_check,
  ADD CONSTRAINT channel_updates_final_state_check
    CHECK (final_state IS NULL OR final_state IN ('delivered','failed'));

CREATE INDEX IF NOT EXISTS channel_updates_pending_delivery_idx
  ON channel_updates (connection_id, created_at)
  WHERE state = 'dispatched' AND response_text IS NOT NULL;
