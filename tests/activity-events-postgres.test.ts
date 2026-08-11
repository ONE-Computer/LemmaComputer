import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { AgentChatEvent, IdentityContext } from "@lemmacomputer/contracts";
import { PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";
import { ActivityEventService } from "../apps/control-api/src/activity.js";

const connectionString = process.env.ACTIVITY_TEST_DATABASE_URL;

test("PostgreSQL Activity events are append-only, deduplicated, tenant-scoped, and workspace-cascaded", {
  skip: !connectionString,
}, async () => {
  const store = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  const owner: IdentityContext = {
    tenantId: `activity-owner-${crypto.randomUUID()}`,
    subjectId: "owner",
    audience: "lemmacomputer-control",
  };
  const outsider: IdentityContext = {
    tenantId: `activity-outsider-${crypto.randomUUID()}`,
    subjectId: "owner",
    audience: "lemmacomputer-control",
  };
  const sessionId = "postgres-session";
  const turnId = "turn-postgres-1";
  try {
    await store.migrate();
    await pool.query(
      `INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Activity owner'),($3,$4,'Activity outsider')`,
      [owner.tenantId, `external-${owner.tenantId}`, outsider.tenantId, `external-${outsider.tenantId}`],
    );
    await pool.query(
      `INSERT INTO organizations(id,display_name) VALUES($1,'Activity owner'),($2,'Activity outsider')`,
      [owner.tenantId, outsider.tenantId],
    );
    const workspace = await store.createOrGet(owner, "activity-postgres", crypto.randomUUID());
    const outsiderWorkspace = await store.createOrGet(outsider, "activity-postgres", crypto.randomUUID());
    const service = new ActivityEventService(store);
    const scope = { workspaceId: workspace.id, agentCatalogId: "codex-cli" as const, sessionId, turnId };
    const common = {
      identity: owner,
      workspaceId: workspace.id,
      agentCatalogId: "codex-cli" as const,
      sessionId,
      displayName: "Codex CLI",
      receivedAt: new Date("2026-07-29T00:00:00.000Z"),
    };
    const started: AgentChatEvent = {
      version: 1,
      sequence: 0,
      sessionId,
      turnId,
      type: "turn-start",
      messageId: "message-postgres-1",
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    const tool: AgentChatEvent = {
      version: 1,
      sequence: 1,
      sessionId,
      turnId,
      type: "tool",
      toolCallId: "tool-postgres-1",
      name: "web.search",
      state: "completed",
      summary: "Search completed",
      progressLabel: "Reviewed the search results.",
    };
    const webAction: AgentChatEvent = {
      version: 1,
      sequence: 2,
      sessionId,
      turnId,
      type: "web-action",
      action: "search",
      label: "Searched for traditional rösti recipes",
    };
    const finished: AgentChatEvent = {
      version: 1,
      sequence: 3,
      sessionId,
      turnId,
      type: "turn-finish",
      state: "completed",
      completedAt: "2026-07-29T00:00:01.000Z",
    };
    await service.recordAgentEvent({ ...common, event: started });
    await Promise.all([
      service.recordAgentEvent({ ...common, event: tool }),
      service.recordAgentEvent({ ...common, event: tool }),
    ]);
    await service.recordAgentEvent({ ...common, event: webAction });
    await service.recordAgentEvent({ ...common, event: finished });

    const replay = await service.replay(owner, scope, -1);
    assert.deepEqual(replay.events.map((event) => [event.sequence, event.kind]), [
      [0, "plan"],
      [1, "tool"],
      [2, "web_action"],
      [3, "terminal"],
    ]);
    assert.deepEqual((await service.replay(owner, scope, 1)).events.map((event) => event.sequence), [2, 3]);
    assert.equal((await store.replayActivityEvents(outsider, scope, -1, 100)).found, false);
    assert.equal(await store.appendActivityEvent({
      identity: owner,
      workspaceId: outsiderWorkspace.id,
      agentCatalogId: "codex-cli",
      sessionId,
      turnId,
      dedupeKey: "wrong-owner",
      occurredAt: new Date(),
      draft: {
        turnId,
        kind: "notice",
        state: "completed",
        provenance: "deterministic_system",
        visibility: "user",
        payload: { message: "Must not persist" },
      },
    }), null);

    assert.equal(await store.remove(owner, workspace.id), true);
    assert.equal((await store.replayActivityEvents(owner, scope, -1, 100)).found, false);
  } finally {
    await pool.end();
    await store.close();
  }
});
