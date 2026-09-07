-- id: 01M1WR738JN01ZC8NYRVB6V0ZF
-- depends-on: 01M1TPZ7VW1Y83RGPA0KEMHWXY

ALTER TABLE workspaces
  ADD COLUMN display_name text;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_display_name_valid
  CHECK (
    display_name IS NULL
    OR (
      display_name = btrim(display_name)
      AND char_length(display_name) BETWEEN 1 AND 80
    )
  );
