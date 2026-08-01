CREATE TABLE IF NOT EXISTS onevibe_vcr_frames (
  task_id uuid NOT NULL REFERENCES onevibe_task_runs(id) ON DELETE CASCADE,
  event_sequence integer NOT NULL CHECK (event_sequence > 0),
  source_application text NOT NULL CHECK (source_application IN ('browser','document','desktop')),
  image_sha256 text NOT NULL CHECK (image_sha256 ~ '^[a-f0-9]{64}$'),
  width integer NOT NULL CHECK (width > 0 AND width <= 16_384),
  height integer NOT NULL CHECK (height > 0 AND height <= 16_384),
  captured_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, event_sequence),
  FOREIGN KEY (task_id, event_sequence)
    REFERENCES onevibe_task_events(task_id, sequence)
    ON DELETE CASCADE
);
