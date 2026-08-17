# Durable chat and artifacts

Chat history and generated files survive workspace stop, restart, node replacement, and runtime deletion because Control owns their canonical records.

The browser's Recent list is user-wide within the active organization rather than workspace- or agent-specific. Each conversation identifies its source workspace and default agent. Opening a saved conversation reads PostgreSQL even when the source workspace was deleted; the Saved files library and file cards download through an authorized Control route. Sending new work still requires an active workspace runtime.

Attachments are accepted inline only at the request boundary. Control immediately saves their bytes through `ArtifactStore`, replaces the inline part with an opaque artifact/revision reference, and then commits the message. Generated runtime artifacts follow the same path before an artifact event reaches the browser or Telegram broker.

To continue from an earlier response in another workspace or with a different agent, use the explicit continuation action. Control creates a child conversation in the selected current workspace containing normalized history through the selected message and retains authorized artifact references. Agent-native session state is deliberately not copied.

## Workspace deletion

Workspace runtime deletion and durable-content retention are separate decisions. The delete dialog preserves chats and artifacts by default. If the user instead chooses to delete content, Control marks eligible conversations and artifacts for retention-controlled deletion; it does not synchronously erase canonical records or object bytes. Legal holds, exports, and artifacts referenced by protected or other-workspace conversations remain protected.

Deleting a workspace tombstones its logical record after its runtime, home, routes, and schedules are removed. Preserved conversations remain visible in Chat, while preserved files remain available from the top-level Artifacts library without starting a workspace. Recreating the same workspace grant revives that record with the same opaque workspace ID, while continuing in a different current workspace creates an explicit fork of normalized history. Neither path restores vendor-native session state.

Physical purge, retention windows, and user-visible deletion status remain part of the retention lifecycle rather than workspace runtime deletion.

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
- `LEMMACOMPUTER_ARTIFACT_S3_KMS_KEY_ID`: optional SSE-KMS override. When blank, Control explicitly requests SSE-S3 (`AES256`) for every staged and finalized object.
- `LEMMACOMPUTER_ARTIFACT_S3_ENDPOINT` and `LEMMACOMPUTER_ARTIFACT_S3_FORCE_PATH_STYLE`: local S3-compatible qualification only; a hosted custom endpoint is rejected.

Bucket and region values are inert while `LEMMACOMPUTER_ARTIFACT_STORE_BACKEND=filesystem`, so an operator may record the hosted destination in a local environment without switching the local artifact store. On the hosted Control deployment, set the backend to `s3`; AWS SDK credential resolution then uses the EC2 instance role or other workload identity without static access keys in `.env`.

Do not grant workspace nodes direct bucket credentials. Nodes return bounded artifact bytes to Control, and Control verifies persisted node placement and generation before committing them.
