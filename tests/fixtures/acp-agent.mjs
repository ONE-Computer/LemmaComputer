#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const protocolVersion = Number(process.env.ONECOMPUTER_ACP_FIXTURE_PROTOCOL ?? acp.PROTOCOL_VERSION);
const cancelled = new Set();
const fixtureMode = process.env.ONECOMPUTER_ACP_FIXTURE_MODE;
let providerConfig = null;

if (fixtureMode === "exit-before-initialize") {
  process.exit(17);
}
if (fixtureMode === "invalid-ndjson") {
  process.stdout.write("this is not ACP JSON\n");
  process.exit(18);
}

const waitForCancellation = async (sessionId) => {
  while (!cancelled.has(sessionId)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

acp.agent({ name: "ONEComputer ACP conformance fixture" })
  .onRequest(acp.methods.agent.initialize, async () => ({
    ...(fixtureMode === "hang-initialize"
      ? await new Promise(() => undefined)
      : {}),
    protocolVersion,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { resume: {} },
      ...(fixtureMode === "no-providers" ? {} : { providers: {} }),
    },
    agentInfo: { name: "ACP conformance fixture", version: "1.0.0" },
  }))
  .onRequest(acp.methods.agent.providers.set, async (context) => {
    providerConfig = context.params;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, async () => ({
    sessionId: crypto.randomUUID(),
  }))
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    const text = context.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.includes("wait-for-cancel")) {
      await waitForCancellation(context.params.sessionId);
      return { stopReason: "cancelled" };
    }
    if (text.includes("exit-during-turn")) {
      process.exit(23);
    }
    if (text.includes("environment-check")) {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "fixture-environment",
          content: {
            type: "text",
            text: [
              process.env.ONECOMPUTER_ACP_HOST_SECRET ?? "host-secret-missing",
              process.env.ONECOMPUTER_ACP_EXPLICIT ?? "explicit-missing",
            ].join(":"),
          },
        },
      });
      return { stopReason: "end_turn" };
    }
    if (text.includes("many-updates")) {
      for (let index = 0; index < 32; index += 1) {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "fixture-many-updates",
            content: { type: "text", text: String(index % 10) },
          },
        });
      }
      return { stopReason: "end_turn" };
    }
    if (text.includes("filesystem-check")) {
      const path = `${process.cwd()}/notes.txt`;
      const read = await context.client.request(acp.methods.client.fs.readTextFile, {
        sessionId: context.params.sessionId,
        path,
        line: 1,
        limit: 10,
      });
      await context.client.request(acp.methods.client.fs.writeTextFile, {
        sessionId: context.params.sessionId,
        path,
        content: `${read.content}:updated`,
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "fixture-filesystem",
          content: { type: "text", text: read.content },
        },
      });
      return { stopReason: "end_turn" };
    }
    if (text.includes("filesystem-escape")) {
      try {
        await context.client.request(acp.methods.client.fs.readTextFile, {
          sessionId: context.params.sessionId,
          path: `${process.cwd()}/../outside.txt`,
        });
      } catch {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "fixture-filesystem-escape",
            content: { type: "text", text: "escape-denied" },
          },
        });
      }
      return { stopReason: "end_turn" };
    }
    if (text.includes("filesystem-symlink")) {
      try {
        await context.client.request(acp.methods.client.fs.readTextFile, {
          sessionId: context.params.sessionId,
          path: process.env.ONECOMPUTER_ACP_FIXTURE_SYMLINK_PATH,
        });
      } catch {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "fixture-filesystem-symlink",
            content: { type: "text", text: "symlink-escape-denied" },
          },
        });
      }
      return { stopReason: "end_turn" };
    }
    if (text.includes("oversized-text")) {
      for (let index = 0; index < 9; index += 1) {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "fixture-oversized",
            content: { type: "text", text: "x".repeat(16_000) },
          },
        });
      }
      return { stopReason: "end_turn" };
    }
    if (text.includes("stderr-check")) {
      process.stderr.write("Authorization Bearer fixture-secret-token\n");
      process.stderr.write("callback?access_token=fixture-access-token\n");
      return { stopReason: "end_turn" };
    }
    if (text.includes("provider-check")) {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "fixture-provider",
          content: {
            type: "text",
            text: JSON.stringify({
              providerId: providerConfig?.providerId,
              apiType: providerConfig?.apiType,
              baseUrl: providerConfig?.baseUrl,
              authorizationPresent: Boolean(providerConfig?.headers?.authorization),
            }),
          },
        },
      });
      return { stopReason: "end_turn" };
    }

    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect the governed workspace", priority: "high", status: "in_progress" },
          { content: "Return a verified result", priority: "medium", status: "pending" },
        ],
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hidden-reasoning-must-never-persist" },
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "fixture tool 1",
        title: "Read the approved project file",
        name: "workspace/read file",
        kind: "read",
        status: "in_progress",
        rawInput: { authorization: "Bearer fixture-secret" },
      },
    });

    const permission = await context.client.request(acp.methods.client.session.requestPermission, {
      sessionId: context.params.sessionId,
      toolCall: {
        toolCallId: "fixture tool 2",
        title: "Publish the result",
        name: "workspace.publish",
        kind: "execute",
        status: "pending",
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });

    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "fixture tool 1",
        title: "Read the approved project file",
        status: "completed",
      },
    });
    for (const chunk of ["The ACP ", "turn completed."]) {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "fixture-message",
          content: { type: "text", text: chunk },
        },
      });
    }
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "fixture-permission",
        content: {
          type: "text",
          text: permission.outcome.outcome === "selected" ? " Permission governed." : " Permission denied.",
        },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, async (context) => {
    cancelled.add(context.params.sessionId);
  })
  .connect(acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ));
