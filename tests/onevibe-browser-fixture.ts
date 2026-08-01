import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const identity = { tenantId: "onevibe-browser", subjectId: "qa-user", audience: "onecomputer-control" as const };
const proxyToken = "onevibe-browser-fixture-proxy-token-at-least-24-characters";
const store = new MemoryWorkspaceStore();
const workspace = await store.createOrGet(identity, "personal", "onevibe-browser-fixture");
await store.update(workspace.id, { state: "ready" });
const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
  testIdentityMode: true,
  oneVibeCaptureSecret: "onevibe-browser-capture-secret-at-least-32-characters",
});
const port = Number(process.env.ONEVIBE_BROWSER_FIXTURE_PORT ?? 4310);
await app.listen({ host: "127.0.0.1", port });
process.stdout.write(`ONEVibe browser fixture ready for workspace ${workspace.id}\n`);
