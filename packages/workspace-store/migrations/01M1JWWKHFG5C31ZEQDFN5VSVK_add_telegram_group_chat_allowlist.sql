-- id: 01M1JWWKHFG5C31ZEQDFN5VSVK
-- depends-on: 01M0FVF4FWBM708GF5FEQ1EC36

ALTER TABLE channel_connections
  ADD COLUMN allowed_group_chat_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE channel_connections
  ADD CONSTRAINT channel_connections_allowed_group_chat_ids CHECK (
    jsonb_typeof(allowed_group_chat_ids) = 'array'
    AND jsonb_array_length(allowed_group_chat_ids) BETWEEN 0 AND 20
  );
