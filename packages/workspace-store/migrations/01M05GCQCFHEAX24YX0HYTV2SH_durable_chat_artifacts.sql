-- id: 01M05GCQCFHEAX24YX0HYTV2SH
-- depends-on: 01M051Q03ZNRE1JVFF84B2G7GT

-- Control-owned durable conversations and artifact metadata. The workspace
-- runtime is deliberately absent from every ownership key.
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_tenant_id_id_unique UNIQUE (tenant_id,id);

ALTER TABLE users
  ADD CONSTRAINT users_tenant_id_id_unique UNIQUE (tenant_id,id);

CREATE TABLE chat_conversations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  default_agent_catalog_id text NOT NULL CHECK (default_agent_catalog_id IN ('claude-cli','codex-cli','hermes-claw')),
  title text,
  requested_service_class text NOT NULL CHECK (requested_service_class IN ('lite','balanced','pro')),
  reasoning_effort text CHECK (reasoning_effort IN ('auto','low','medium','high')),
  parent_conversation_id uuid,
  forked_from_message_id text,
  retention_class text NOT NULL DEFAULT 'saved' CHECK (retention_class IN ('saved','temporary','legal_hold','export','staged_delete','purged')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','staged_delete','purged')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_subject_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,parent_conversation_id) REFERENCES chat_conversations(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((parent_conversation_id IS NULL) = (forked_from_message_id IS NULL))
);

CREATE INDEX chat_conversations_owner_updated_idx
  ON chat_conversations (tenant_id,owner_subject_id,workspace_id,updated_at DESC,id DESC)
  WHERE state='active';

CREATE TABLE chat_messages (
  tenant_id text NOT NULL,
  conversation_id uuid NOT NULL,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  ordinal bigint NOT NULL CHECK (ordinal > 0),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  agent_catalog_id text NOT NULL CHECK (agent_catalog_id IN ('claude-cli','codex-cli','hermes-claw')),
  turn_id text CHECK (turn_id IS NULL OR turn_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  state text NOT NULL CHECK (state IN ('streaming','needs_input','completed','cancelled','failed')),
  parts jsonb NOT NULL CHECK (jsonb_typeof(parts)='array'),
  source text CHECK (source IN ('web','telegram')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,conversation_id,id),
  UNIQUE (tenant_id,conversation_id,ordinal),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES chat_conversations(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX chat_messages_conversation_order_idx
  ON chat_messages (tenant_id,conversation_id,ordinal);

CREATE TABLE chat_agent_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  conversation_id uuid NOT NULL,
  assistant_message_id text,
  turn_id text NOT NULL CHECK (turn_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  effective_agent_catalog_id text NOT NULL CHECK (effective_agent_catalog_id IN ('claude-cli','codex-cli','hermes-claw')),
  requested_service_class text NOT NULL CHECK (requested_service_class IN ('lite','balanced','pro')),
  reasoning_effort text CHECK (reasoning_effort IN ('auto','low','medium','high')),
  policy_version_id text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid NOT NULL,
  workspace_node_id text,
  access_generation integer NOT NULL CHECK (access_generation > 0),
  agent_instance_id uuid,
  status text NOT NULL CHECK (status IN ('streaming','needs_input','completed','cancelled','failed')),
  failure_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id,conversation_id,turn_id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES chat_conversations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_node_id) REFERENCES workspace_nodes(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,conversation_id,assistant_message_id)
    REFERENCES chat_messages(tenant_id,conversation_id,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX chat_agent_runs_conversation_started_idx
  ON chat_agent_runs (tenant_id,conversation_id,started_at DESC,id DESC);

CREATE TABLE chat_vendor_session_bindings (
  tenant_id text NOT NULL,
  conversation_id uuid NOT NULL,
  agent_catalog_id text NOT NULL CHECK (agent_catalog_id IN ('claude-cli','codex-cli','hermes-claw')),
  vendor_session_id text NOT NULL CHECK (length(vendor_session_id) BETWEEN 1 AND 512),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,conversation_id,agent_catalog_id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES chat_conversations(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE artifact_staging_uploads (
  id text PRIMARY KEY CHECK (id ~ '^upload-[a-f0-9]{32}$'),
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('input','output')),
  original_filename text NOT NULL,
  media_type text NOT NULL,
  expected_byte_length bigint NOT NULL CHECK (expected_byte_length > 0),
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  workspace_node_id text,
  access_generation integer NOT NULL CHECK (access_generation > 0),
  storage_backend text NOT NULL CHECK (storage_backend IN ('filesystem','s3')),
  staging_locator text NOT NULL,
  artifact_id text CHECK (artifact_id IS NULL OR artifact_id ~ '^artifact-[a-f0-9]{32}$'),
  revision_id text CHECK (revision_id IS NULL OR revision_id ~ '^revision-[a-f0-9]{32}$'),
  final_storage_locator text,
  state text NOT NULL CHECK (state IN ('staged','finalizing','committed','abandoned','failed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES chat_conversations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_subject_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_node_id) REFERENCES workspace_nodes(id) ON DELETE RESTRICT,
  CHECK ((artifact_id IS NULL) = (revision_id IS NULL)),
  CHECK ((artifact_id IS NULL) = (final_storage_locator IS NULL)),
  CHECK (state NOT IN ('finalizing','committed') OR artifact_id IS NOT NULL)
);

CREATE INDEX artifact_staging_expiry_idx
  ON artifact_staging_uploads (expires_at,id)
  WHERE state IN ('staged','finalizing','failed');

CREATE TABLE artifacts (
  id text PRIMARY KEY CHECK (id ~ '^artifact-[a-f0-9]{32}$'),
  tenant_id text NOT NULL,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  creator_subject_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('input','output')),
  original_filename text NOT NULL,
  display_name text NOT NULL,
  media_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('available','staged_delete','purged','failed')),
  retention_class text NOT NULL DEFAULT 'saved' CHECK (retention_class IN ('saved','temporary','legal_hold','export','staged_delete','purged')),
  current_revision_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES chat_conversations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,creator_subject_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX artifacts_conversation_idx
  ON artifacts (tenant_id,conversation_id,created_at,id)
  WHERE state='available';

CREATE TABLE artifact_revisions (
  id text PRIMARY KEY CHECK (id ~ '^revision-[a-f0-9]{32}$'),
  tenant_id text NOT NULL,
  artifact_id text NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  base_revision_id text,
  media_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_backend text NOT NULL CHECK (storage_backend IN ('filesystem','s3')),
  storage_locator text NOT NULL,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,artifact_id,revision_number),
  FOREIGN KEY (tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,base_revision_id) REFERENCES artifact_revisions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_subject_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_current_revision_fk
  FOREIGN KEY (tenant_id,current_revision_id) REFERENCES artifact_revisions(tenant_id,id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE chat_message_artifacts (
  tenant_id text NOT NULL,
  conversation_id uuid NOT NULL,
  message_id text NOT NULL,
  artifact_id text NOT NULL,
  revision_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('input','output')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,conversation_id,message_id,artifact_id,revision_id),
  FOREIGN KEY (tenant_id,conversation_id,message_id)
    REFERENCES chat_messages(tenant_id,conversation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,revision_id) REFERENCES artifact_revisions(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX chat_message_artifacts_artifact_idx
  ON chat_message_artifacts (tenant_id,artifact_id,revision_id);
