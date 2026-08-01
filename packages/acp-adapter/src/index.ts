import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  ActiveSession,
  ClientConnection,
  ContentBlock,
  InitializeResponse,
  McpServer,
  ReadTextFileRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  SetProviderRequest,
  ToolCallStatus,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import {
  agentChatEventSchema,
  harnessRuntimeSchema,
  type AgentChatEvent,
  type ChatAgentCatalogId,
  type HarnessRuntime,
} from "@onecomputer/contracts";

const maxDiagnosticLength = 500;
const maxTextLength = 128_000;
const defaultStartupTimeoutMs = 15_000;
const defaultTurnTimeoutMs = 10 * 60_000;
const inheritedEnvironmentKeys = [
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;
type UnsequencedEvent = AgentChatEvent extends infer Event
  ? Event extends AgentChatEvent
    ? Omit<Event, "sequence">
    : never
  : never;
type EventBase = Pick<AgentChatEvent, "version" | "sessionId" | "turnId">;
const identifier = (prefix: string, value: string) => (
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`
);
const bounded = (value: string, maximum: number) => value.trim().slice(0, maximum);
const toolName = (value: string) => {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 160);
  return normalized || "acp-tool";
};

export const redactAcpDiagnostic = (value: string) => bounded(value
  .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_AUTH]")
  .replace(/\b(?:sk|key|token|secret|password)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_SECRET]")
  .replace(/([?&](?:access_token|api[_-]?key|code|credential|password|sig|signature|token)=)[^&\s]+/gi, "$1[REDACTED]"),
maxDiagnosticLength);

export const resolveConfinedPath = (cwd: string, requestedPath: string) => {
  const root = resolve(cwd);
  const target = resolve(root, requestedPath);
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error("ACP path escapes the governed workspace");
  }
  return target;
};

const assertRealPathConfined = async (cwd: string, target: string) => {
  const root = await realpath(cwd);
  let ancestor = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = resolve(await realpath(ancestor), ...missing);
      const local = relative(root, canonical);
      if (local === ".." || local.startsWith(`..${sep}`)) {
        throw new Error("ACP path escapes the governed workspace through a symbolic link");
      }
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
};

export type AcpPermissionResolution =
  | { outcome: "cancelled" }
  | {
    outcome: "selected";
    optionId: string;
    operationId: string;
    approvalId: string;
    summary: string;
  };

export interface AcpHarnessConfiguration {
  command: string;
  args: readonly string[];
  cwd: string;
  agentCatalogId: ChatAgentCatalogId;
  environment?: Readonly<Record<string, string>>;
  mcpServers?: readonly McpServer[];
  clientName?: string;
  clientVersion?: string;
  startupTimeoutMs?: number;
  turnTimeoutMs?: number;
  stderr?: (diagnostic: string) => void;
  permission?: (request: RequestPermissionRequest) => Promise<AcpPermissionResolution>;
  readTextFile?: (request: ReadTextFileRequest) => Promise<string>;
  writeTextFile?: (request: WriteTextFileRequest) => Promise<void>;
  provider?: SetProviderRequest;
}

export type OfficialAcpAgent = Extract<ChatAgentCatalogId, "claude-cli" | "codex-cli" | "opencode-cli">;

export interface OfficialAcpHarnessInput {
  agentCatalogId: OfficialAcpAgent;
  cwd: string;
  home?: string;
  runtimeRoot?: string;
  model?: string;
  gateway?: {
    baseUrl: string;
    headers: Readonly<Record<string, string>>;
  };
}

const officialAcpExecutables: Readonly<Record<OfficialAcpAgent, string>> = Object.freeze({
  "claude-cli": "claude-agent-acp",
  "codex-cli": "codex-acp",
  "opencode-cli": "opencode",
});

export const officialAcpHarnessConfiguration = (
  input: OfficialAcpHarnessInput,
): AcpHarnessConfiguration => {
  const home = resolve(input.home ?? "/home/kasm-user");
  const runtimeRoot = resolve(input.runtimeRoot ?? "/opt/onecomputer/acp-runtime");
  const executable = officialAcpExecutables[input.agentCatalogId];
  if (input.agentCatalogId !== "claude-cli" && !input.gateway) {
    throw new Error(`The governed ${input.agentCatalogId} ACP runtime requires a broker gateway`);
  }
  return {
    command: resolve(runtimeRoot, "node_modules", ".bin", executable),
    args: input.agentCatalogId === "opencode-cli" ? ["acp"] : [],
    cwd: resolve(input.cwd),
    agentCatalogId: input.agentCatalogId,
    environment: input.agentCatalogId === "claude-cli"
      ? {
        HOME: home,
        CLAUDE_CONFIG_DIR: resolve(home, ".claude-cli"),
        NO_BROWSER: "1",
      }
      : input.agentCatalogId === "codex-cli"
        ? {
        HOME: home,
        CODEX_HOME: resolve(home, ".codex-cli"),
        ...(input.model ? {
          CODEX_CONFIG: JSON.stringify({
            model: input.model,
            model_context_window: 32_768,
          }),
        } : {}),
        NO_BROWSER: "1",
        }
        : {
          HOME: home,
          OPENCODE_CONFIG_DIR: resolve(home, ".config", "opencode"),
          OPENCODE_DISABLE_TUI: "1",
          NO_BROWSER: "1",
        },
    ...(input.agentCatalogId !== "claude-cli" && input.gateway ? {
      provider: {
        providerId: "custom-gateway",
        apiType: "openai",
        baseUrl: input.gateway.baseUrl,
        headers: { ...input.gateway.headers },
      },
    } : {}),
    clientName: "ONEComputer",
    clientVersion: "0.1.0",
  };
};

export interface AcpTurnInput {
  sessionId: string;
  turnId: string;
  messageId: string;
  prompt: string | readonly ContentBlock[];
  signal?: AbortSignal;
}

const processExit = (process: ChildProcessWithoutNullStreams) => new Promise<never>((_resolve, reject) => {
  process.once("error", reject);
  process.once("exit", (code, signal) => {
    reject(new Error(`ACP harness exited before the protocol session closed (${signal ?? code ?? "unknown"})`));
  });
});

const positiveTimeout = (value: number | undefined, fallback: number) => (
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
);

const withTimeout = async <Result>(
  operation: Promise<Result>,
  timeoutMs: number,
  message: string,
): Promise<Result> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const projectCapabilities = (response: InitializeResponse): HarnessRuntime => {
  const capabilities = response.agentCapabilities;
  return harnessRuntimeSchema.parse({
    transport: "acp",
    protocolVersion: String(response.protocolVersion),
    implementation: bounded(response.agentInfo?.name ?? "ACP agent", 80),
    implementationVersion: bounded(response.agentInfo?.version ?? "unknown", 40),
    capabilities: {
      loadSession: capabilities?.loadSession === true,
      resumeSession: capabilities?.sessionCapabilities?.resume != null,
      cancelTurn: true,
      permissions: true,
      fsReadTextFile: false,
      fsWriteTextFile: false,
      terminal: false,
      mcp: Boolean(
        capabilities?.mcpCapabilities?.http
        || capabilities?.mcpCapabilities?.sse
        || capabilities?.mcpCapabilities?.acp,
      ),
    },
  });
};

const textContent = (content: ContentBlock) => content.type === "text" ? content.text : null;
const toolState = (status?: ToolCallStatus | null): "running" | "completed" | "failed" => {
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "running";
};

const updateEvents = (
  update: SessionUpdate,
  base: EventBase,
): UnsequencedEvent[] => {
  if (update.sessionUpdate === "agent_message_chunk") {
    const text = textContent(update.content);
    return text ? [{
      ...base,
      type: "text-delta",
      textId: identifier("text", update.messageId ?? base.turnId),
      delta: text.slice(0, 16_000),
    }] : [];
  }
  if (update.sessionUpdate === "agent_thought_chunk") {
    return [];
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const rawName = update.name ?? update.title ?? "ACP tool";
    return [{
      ...base,
      type: "tool",
      toolCallId: identifier("tool", update.toolCallId),
      name: toolName(rawName),
      state: toolState(update.status),
      summary: bounded(update.title ?? rawName, 500),
    }];
  }
  if (update.sessionUpdate === "plan") {
    const entries = update.entries.slice(0, 12);
    const active = entries.find((entry) => entry.status === "in_progress") ?? entries[0];
    if (!active) return [];
    return [{
      ...base,
      type: "plan",
      title: bounded(active.content, 240),
      summary: bounded(entries.map((entry) => entry.content).join(" · "), 500),
      state: entries.every((entry) => entry.status === "completed") ? "completed" : "running",
    }];
  }
  return [];
};

export class AcpHarnessSession {
  readonly runtime: HarnessRuntime;
  readonly vendorSessionId: string;

  private active = false;
  private closed = false;

  private constructor(
    private readonly configuration: AcpHarnessConfiguration,
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly connection: ClientConnection,
    private readonly session: ActiveSession,
    runtime: HarnessRuntime,
    private readonly exited: Promise<never>,
  ) {
    this.runtime = harnessRuntimeSchema.parse({
      ...runtime,
      capabilities: {
        ...runtime.capabilities,
        fsReadTextFile: Boolean(configuration.readTextFile),
        fsWriteTextFile: Boolean(configuration.writeTextFile),
      },
    });
    this.vendorSessionId = session.sessionId;
  }

  static async start(configuration: AcpHarnessConfiguration) {
    if (!configuration.command.trim()) throw new Error("An allow-listed ACP command is required");
    await mkdir(configuration.cwd, { recursive: true });
    configuration = { ...configuration, cwd: await realpath(configuration.cwd) };

    const process = spawn(configuration.command, [...configuration.args], {
      cwd: configuration.cwd,
      env: { ...processEnvironment(), ...configuration.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = processExit(process);
    drainStderr(process, configuration.stderr);

    let activeTurn: {
      sessionId: string;
      vendorSessionId: string;
      turnId: string;
      emit: (event: UnsequencedEvent) => void;
    } | null = null;

    const application = acp.client({ name: configuration.clientName ?? "ONEComputer" })
      .onRequest(acp.methods.client.session.requestPermission, async (context) => {
        const resolution = await configuration.permission?.(context.params) ?? { outcome: "cancelled" };
        const option = resolution.outcome === "selected"
          ? context.params.options.find((candidate) => candidate.optionId === resolution.optionId)
          : undefined;
        if (resolution.outcome === "selected" && !option) {
          throw new Error("ACP permission resolver selected an option the agent did not offer");
        }
        if (activeTurn && context.params.sessionId === activeTurn.vendorSessionId) {
          if (resolution.outcome === "selected") {
            activeTurn.emit({
              version: 1,
              sessionId: activeTurn.sessionId,
              turnId: activeTurn.turnId,
              type: "approval",
              approvalId: identifier("approval", resolution.approvalId),
              toolCallId: identifier("tool", context.params.toolCall.toolCallId),
              operationId: resolution.operationId,
              state: "approved",
              summary: bounded(resolution.summary, 500),
            });
          } else {
            activeTurn.emit({
              version: 1,
              sessionId: activeTurn.sessionId,
              turnId: activeTurn.turnId,
              type: "notice",
              message: "The ACP tool request was denied because no governed approval was available",
            });
          }
        }
        const response: RequestPermissionResponse = resolution.outcome === "selected"
          ? { outcome: { outcome: "selected", optionId: resolution.optionId } }
          : { outcome: { outcome: "cancelled" } };
        return response;
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (context) => {
        if (!configuration.readTextFile) return { content: "" };
        const target = resolveConfinedPath(configuration.cwd, context.params.path);
        await assertRealPathConfined(configuration.cwd, target);
        return { content: await configuration.readTextFile(context.params) };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (context) => {
        if (!configuration.writeTextFile) return {};
        const target = resolveConfinedPath(configuration.cwd, context.params.path);
        await assertRealPathConfined(configuration.cwd, target);
        await configuration.writeTextFile(context.params);
        return {};
      });

    const stream = acp.ndJsonStream(
      Writable.toWeb(process.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = application.connect(stream);
    try {
      const startupTimeoutMs = positiveTimeout(configuration.startupTimeoutMs, defaultStartupTimeoutMs);
      const initialized = await withTimeout(Promise.race([
          connection.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: {
              name: configuration.clientName ?? "ONEComputer",
              version: configuration.clientVersion ?? "0.1.0",
            },
            clientCapabilities: {
              ...(configuration.readTextFile || configuration.writeTextFile ? {
                fs: {
                  readTextFile: Boolean(configuration.readTextFile),
                  writeTextFile: Boolean(configuration.writeTextFile),
                },
              } : {}),
              terminal: false,
            },
          }),
          exited,
        ]),
        startupTimeoutMs,
        "ACP harness initialization timed out",
      );
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`Unsupported ACP protocol version ${initialized.protocolVersion}`);
      }
      if (configuration.provider) {
        if (initialized.agentCapabilities?.providers == null) {
          throw new Error("ACP harness does not support governed provider configuration");
        }
        await withTimeout(
          Promise.race([
            connection.agent.request(acp.methods.agent.providers.set, configuration.provider),
            exited,
          ]),
          startupTimeoutMs,
          "ACP provider configuration timed out",
        );
      }
      const builder = connection.agent.buildSession({
        cwd: resolve(configuration.cwd),
        mcpServers: [...(configuration.mcpServers ?? [])],
      });
      const session = await withTimeout(
        Promise.race([builder.start(), exited]),
        startupTimeoutMs,
        "ACP session creation timed out",
      );
      const instance = new AcpHarnessSession(
        configuration,
        process,
        connection,
        session,
        projectCapabilities(initialized),
        exited,
      );
      instance.setActiveTurn = (value) => {
        activeTurn = value;
      };
      return instance;
    } catch (error) {
      connection.close(error);
      stopProcess(process);
      throw error;
    }
  }

  private setActiveTurn: (value: {
    sessionId: string;
    vendorSessionId: string;
    turnId: string;
    emit: (event: UnsequencedEvent) => void;
  } | null) => void = () => undefined;

  async *streamTurn(input: AcpTurnInput): AsyncGenerator<AgentChatEvent> {
    if (this.closed) throw new Error("ACP session is closed");
    if (this.active) throw new Error("ACP session already has an active turn");
    if (input.prompt instanceof Array && input.prompt.length === 0) throw new Error("ACP prompt is empty");
    if (typeof input.prompt === "string" && !input.prompt.trim()) throw new Error("ACP prompt is empty");
    this.active = true;

    const pending: UnsequencedEvent[] = [];
    this.setActiveTurn({
      sessionId: input.sessionId,
      vendorSessionId: this.vendorSessionId,
      turnId: input.turnId,
      emit: (event) => pending.push(event),
    });
    let sequence = 0;
    let textSize = 0;
    const emit = (event: UnsequencedEvent) => {
      const parsed = agentChatEventSchema.parse({ ...event, sequence });
      sequence += 1;
      return parsed;
    };
    const runtime = this.runtime;
    yield emit({
      version: 1,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: "turn-start",
      messageId: input.messageId,
      createdAt: new Date().toISOString(),
      runtime,
    });

    const cancel = () => {
      void this.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: this.vendorSessionId,
      }).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    const turnTimeoutMs = positiveTimeout(this.configuration.turnTimeoutMs, defaultTurnTimeoutMs);
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort();
      cancel();
    }, turnTimeoutMs);
    timeout.unref();
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeoutController.signal.addEventListener(
        "abort",
        () => reject(new Error("ACP turn timed out")),
        { once: true },
      );
    });
    try {
      const prompt = this.session.prompt(input.prompt instanceof Array ? [...input.prompt] : input.prompt);
      for (;;) {
        const next = await Promise.race([
          this.session.nextUpdate(),
          this.exited,
          timedOut,
        ]);
        while (pending.length) yield emit(pending.shift()!);
        if (next.kind === "stop") {
          await prompt;
          const state = next.stopReason === "end_turn"
            ? "completed"
            : next.stopReason === "cancelled"
              ? "cancelled"
              : "failed";
          yield emit({
            version: 1,
            sessionId: input.sessionId,
            turnId: input.turnId,
            type: "turn-finish",
            state,
            ...(state === "failed" ? { message: `ACP turn stopped: ${next.stopReason}` } : {}),
            completedAt: new Date().toISOString(),
          });
          return;
        }
        const base = {
          version: 1 as const,
          sessionId: input.sessionId,
          turnId: input.turnId,
        };
        for (const event of updateEvents(next.update, base)) {
          if (event.type === "text-delta") {
            textSize += event.delta.length;
            if (textSize > maxTextLength) throw new Error("ACP turn exceeded the canonical text limit");
          }
          yield emit(event);
        }
      }
    } catch (error) {
      const aborted = input.signal?.aborted === true;
      const timedOut = timeoutController.signal.aborted;
      yield emit({
        version: 1,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: "error",
        code: aborted ? "ACP_TURN_CANCELLED" : timedOut ? "ACP_TURN_TIMEOUT" : "ACP_TURN_FAILED",
        message: aborted
          ? "The ACP turn was cancelled"
          : timedOut
            ? "The ACP turn timed out"
            : "The ACP harness could not complete the turn",
        retryable: !aborted,
      });
      yield emit({
        version: 1,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: "turn-finish",
        state: aborted || timedOut ? "cancelled" : "failed",
        completedAt: new Date().toISOString(),
      });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", cancel);
      this.setActiveTurn(null);
      this.active = false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.dispose();
    this.connection.close();
    stopProcess(this.process);
  }
}

export const processEnvironment = () => Object.fromEntries(
  inheritedEnvironmentKeys.flatMap((key) => {
    const value = process.env[key];
    return typeof value === "string" ? [[key, value]] : [];
  }),
);

const drainStderr = (
  process: ChildProcessWithoutNullStreams,
  receive?: (diagnostic: string) => void,
) => {
  let buffered = "";
  process.stderr.setEncoding("utf8");
  process.stderr.on("data", (chunk: string) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line.trim()) receive?.(redactAcpDiagnostic(line));
    }
    if (buffered.length > 4_096) buffered = buffered.slice(-4_096);
  });
  process.stderr.on("end", () => {
    if (buffered.trim()) receive?.(redactAcpDiagnostic(buffered));
  });
};

const stopProcess = (process: ChildProcessWithoutNullStreams) => {
  const running = () => process.exitCode === null && process.signalCode === null;
  if (running()) process.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (running()) process.kill("SIGKILL");
  }, 2_000);
  timer.unref();
};
