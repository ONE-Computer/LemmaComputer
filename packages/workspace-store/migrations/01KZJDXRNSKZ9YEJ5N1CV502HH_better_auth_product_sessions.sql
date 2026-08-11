-- id: 01KZJDXRNSKZ9YEJ5N1CV502HH
-- depends-on: 01KZDMJVTS4Y1K48DEZMFQ65VE

-- Better Auth owns its browser credential and authentication session. Control
-- records only the validated Better Auth session identifier needed to resolve
-- an explicit membership-bound product authorization context. Existing Entra
-- token-hash sessions remain valid during the bounded compatibility window.

ALTER TABLE browser_sessions
  ADD COLUMN authentication_session_id uuid;

CREATE UNIQUE INDEX browser_sessions_authentication_session_idx
  ON browser_sessions (authentication_session_id)
  WHERE authentication_session_id IS NOT NULL;
