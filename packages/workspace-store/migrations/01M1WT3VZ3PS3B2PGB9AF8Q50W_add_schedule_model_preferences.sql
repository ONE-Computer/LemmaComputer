-- id: 01M1WT3VZ3PS3B2PGB9AF8Q50W
-- depends-on: 01M1WR738JN01ZC8NYRVB6V0ZF

ALTER TABLE schedules
  ADD COLUMN requested_service_class text NOT NULL DEFAULT 'balanced'
    CHECK (requested_service_class IN ('lite', 'balanced', 'pro')),
  ADD COLUMN reasoning_effort text NULL
    CHECK (reasoning_effort IN ('auto', 'low', 'medium', 'high'));
