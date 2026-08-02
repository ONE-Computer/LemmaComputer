-- id: 01KZ18DS6XSN4ZJQ6TAK71KZ3A
-- depends-on: 01KYYCNT4QCA6S1EMCK79AVTZD

-- v2 agent bridge grants bind to this monotonically increasing workspace
-- generation. Incrementing it invalidates every prior grant immediately.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS bridge_grant_generation integer NOT NULL DEFAULT 1;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_bridge_grant_generation_positive
    CHECK (bridge_grant_generation > 0);
