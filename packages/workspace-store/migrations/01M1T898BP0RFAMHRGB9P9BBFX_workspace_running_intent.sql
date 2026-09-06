-- id: 01M1T898BP0RFAMHRGB9P9BBFX
-- depends-on: 01M1S15T60RZ36F72GXKNMPMD1

-- Forward-only migration. Add safe, bounded SQL below.

-- Nullable expansion: legacy rows derive intent until their next lifecycle write.
-- No table backfill or new index; existing primary key supports bounded scans.
ALTER TABLE workspaces ADD COLUMN desired_state text;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_desired_state_check
  CHECK (desired_state IN ('running', 'stopped')) NOT VALID;

-- Older Control replicas do not know the new column. Preserve their explicit
-- start/stop claims during rolling deployment, without interpreting health polls
-- as user intent. No existing rows are rewritten.
CREATE FUNCTION workspace_capture_lifecycle_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_token IS NOT NULL
     AND NEW.operation_token IS DISTINCT FROM OLD.operation_token THEN
    IF NEW.state IN ('provisioning', 'restarting') THEN
      NEW.desired_state := 'running';
    ELSIF NEW.state = 'stopping' THEN
      NEW.desired_state := 'stopped';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_capture_lifecycle_intent
BEFORE UPDATE OF state, operation_token ON workspaces
FOR EACH ROW EXECUTE FUNCTION workspace_capture_lifecycle_intent();
