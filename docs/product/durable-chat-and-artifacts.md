# Durable chat and artifacts

Chat history and generated files survive workspace stop, restart, node replacement, and runtime deletion because Control owns their canonical records.

The browser's Recent list is workspace-wide rather than agent-specific. Each conversation identifies its default agent. Opening a saved conversation reads PostgreSQL even when the workspace is stopped; saved file cards download through an authorized Control route. Sending new work still requires the workspace runtime.

Attachments are accepted inline only at the request boundary. Control immediately saves their bytes through `ArtifactStore`, replaces the inline part with an opaque artifact/revision reference, and then commits the message. Generated runtime artifacts follow the same path before an artifact event reaches the browser or Telegram broker.

To continue from an earlier assistant response with a different agent, use the explicit “Continue from here” action. Control creates a child conversation containing normalized history through the selected message. Agent-native session state is deliberately not copied.

## Local verification

```bash
npm run qualify:artifact-store
npm run verify:db
```

The first command starts its own temporary MinIO container. The ordinary worktree stack uses `LEMMACOMPUTER_ARTIFACT_STORE_BACKEND=filesystem` and the worktree's `artifact-data` Docker volume.

## Deployment settings

- `LEMMACOMPUTER_ARTIFACT_STORE_BACKEND`: `filesystem` or `s3`.
- `LEMMACOMPUTER_ARTIFACT_FILESYSTEM_ROOT`: absolute Control-owned filesystem root.
- `LEMMACOMPUTER_ARTIFACT_S3_BUCKET` and `LEMMACOMPUTER_ARTIFACT_S3_REGION`: S3 destination.
- `LEMMACOMPUTER_ARTIFACT_S3_KMS_KEY_ID`: required for hosted deployments.
- `LEMMACOMPUTER_ARTIFACT_S3_ENDPOINT` and `LEMMACOMPUTER_ARTIFACT_S3_FORCE_PATH_STYLE`: local S3-compatible qualification only; a hosted custom endpoint is rejected.

Do not grant workspace nodes direct bucket credentials. Nodes return bounded artifact bytes to Control, and Control verifies persisted node placement and generation before committing them.
