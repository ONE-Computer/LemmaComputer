import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import {
  OneComputerError,
  channelBrokerCredentialOwnerSchema,
  channelBrokerOwnerSchema,
  channelBrokerSaveConnectionSchema,
  channelBrokerSaveCredentialSchema,
  identityContextSchema,
} from "@onecomputer/contracts";
import { z } from "zod";
import {
  ChannelBrokerService,
  ChannelCredentialVault,
  HttpChannelControlClient,
  TelegramBotApiClient,
} from "./broker.js";
import { PostgresChannelStore } from "./store.js";

const envSchema = z.object({
  CHANNEL_BROKER_HOST: z.string().default("127.0.0.1"),
  CHANNEL_BROKER_PORT: z.coerce.number().int().positive().default(4102),
  CHANNEL_BROKER_INTERNAL_TOKEN: z.string().min(32),
  CHANNEL_CREDENTIAL_SECRET: z.string().min(32),
  CONTROL_URL: z.string().url().default("http://127.0.0.1:4100"),
  DATABASE_URL: z.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
});

const sameSecret = (received: string | string[] | undefined, expected: string) => {
  const value = Array.isArray(received) ? received[0] : received;
  if (!value) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createChannelBrokerServer(service: ChannelBrokerService, internalToken: string) {
  const app = Fastify({
    logger: {
      redact: [
        "req.headers.x-onecomputer-channel-token",
        "req.body",
        "*.credentialCiphertext",
      ],
    },
    bodyLimit: 32 * 1024,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    if (!sameSecret(request.headers["x-onecomputer-channel-token"], internalToken)) {
      return reply.code(401).send({
        error: {
          code: "UNAUTHENTICATED",
          message: "Channel broker authentication is required",
          correlationId: request.id,
          retryable: false,
        },
      });
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.post("/internal/v1/credentials", async (request) => {
    const { identity } = channelBrokerOwnerSchema.parse(request.body ?? {});
    return service.listCredentials(identityContextSchema.parse(identity));
  });
  app.post("/internal/v1/credentials/telegram", async (request) => {
    const { identity, botToken } = channelBrokerSaveCredentialSchema.parse(request.body ?? {});
    return service.saveCredential(identityContextSchema.parse(identity), { botToken });
  });
  app.put("/internal/v1/credentials/telegram", async (request) => {
    const { identity, credentialId, botToken } = channelBrokerSaveCredentialSchema.parse(request.body ?? {});
    if (!credentialId) throw new OneComputerError("CHANNEL_CREDENTIAL_ID_REQUIRED", "Credential ID is required", 400);
    return service.saveCredential(identityContextSchema.parse(identity), { botToken }, credentialId);
  });
  app.delete("/internal/v1/credentials/telegram", async (request, reply) => {
    const { identity, credentialId } = channelBrokerCredentialOwnerSchema.parse(request.body ?? {});
    await service.deleteCredential(identityContextSchema.parse(identity), credentialId);
    return reply.code(204).send();
  });
  app.post("/internal/v1/connections/telegram/status", async (request, reply) => {
    const { identity, workspaceId } = channelBrokerOwnerSchema.parse(request.body ?? {});
    if (!workspaceId) throw new OneComputerError("CHANNEL_WORKSPACE_ID_REQUIRED", "Workspace ID is required", 400);
    const status = await service.status(identityContextSchema.parse(identity), workspaceId);
    return status ? reply.send(status) : reply.code(204).send();
  });
  app.put("/internal/v1/connections/telegram", async (request) => {
    const { identity, ...input } = channelBrokerSaveConnectionSchema.parse(request.body ?? {});
    return service.saveConnection(identityContextSchema.parse(identity), input);
  });
  app.delete("/internal/v1/connections/telegram", async (request, reply) => {
    const { identity, workspaceId } = channelBrokerOwnerSchema.parse(request.body ?? {});
    if (!workspaceId) throw new OneComputerError("CHANNEL_WORKSPACE_ID_REQUIRED", "Workspace ID is required", 400);
    await service.disconnect(identityContextSchema.parse(identity), workspaceId);
    return reply.code(204).send();
  });

  app.setErrorHandler((error, request, reply) => {
    const validation = error instanceof Error && error.name === "ZodError";
    const known = error instanceof OneComputerError
      ? error
      : validation
        ? new OneComputerError("INVALID_REQUEST", "The request is invalid", 400)
        : new OneComputerError("CHANNEL_BROKER_ERROR", "The channel broker could not complete the request", 500, true);
    request.log.error({ err: { name: error instanceof Error ? error.name : "UnknownError", code: known.code } }, "channel broker request failed");
    reply.code(known.statusCode).send({
      error: {
        code: known.code,
        message: known.message,
        correlationId: request.id,
        retryable: known.retryable,
      },
    });
  });
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const env = envSchema.parse(process.env);
  const store = PostgresChannelStore.fromConnectionString(env.DATABASE_URL);
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault(env.CHANNEL_CREDENTIAL_SECRET),
    new TelegramBotApiClient(),
    new HttpChannelControlClient(env.CONTROL_URL, env.CHANNEL_BROKER_INTERNAL_TOKEN),
  );
  const app = createChannelBrokerServer(service, env.CHANNEL_BROKER_INTERNAL_TOKEN);
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await service.pollOnce();
    } catch (error) {
      app.log.error({
        err: {
          name: error instanceof Error ? error.name : "UnknownError",
          code: error instanceof OneComputerError ? error.code : "CHANNEL_POLL_FAILED",
        },
      }, "channel polling failed");
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(poll, env.POLL_INTERVAL_MS);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await store.close();
  });
  await app.listen({ host: env.CHANNEL_BROKER_HOST, port: env.CHANNEL_BROKER_PORT });
  await poll();
}
