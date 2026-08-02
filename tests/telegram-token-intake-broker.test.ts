import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import test from "node:test";
import {
  TelegramTokenIntakeEnvelope,
  TelegramTokenIntakeGrantIssuer,
  TelegramTokenIntakeGrantVerifier,
  type IdentityContext,
} from "@onecomputer/contracts";
import {
  ChannelBrokerService,
  ChannelCredentialVault,
  type ChannelControlClient,
  type TelegramBotClient,
} from "../apps/channel-broker/src/broker.js";
import { createChannelBrokerServer } from "../apps/channel-broker/src/server.js";
import { MemoryChannelStore } from "../apps/channel-broker/src/store.js";
import { encryptTelegramBotTokenEnvelope } from "../apps/web/src/telegram-token-intake.js";

const brokerToken = "broker-internal-token-at-least-32-characters";
const vaultSecret = "channel-vault-test-secret-at-least-32-characters";
const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "onecomputer-control" };
const credentialId = "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24";
const firstToken = "123456789:telegram-token-for-broker-only-intake";
const rotatedToken = "987654321:telegram-token-for-broker-only-rotation";

class IntakeTelegram implements TelegramBotClient {
  validated: string[] = [];
  async validate(token: string) {
    this.validated.push(token);
    return { botId: token.slice(0, token.indexOf(":")), username: "onecomputer_intake_bot" };
  }
  async getUpdates() { return []; }
  async downloadFile() { return Buffer.alloc(0); }
  async sendMessage() { return "1"; }
  async sendDocument() { return "1"; }
  async editMessage() {}
  async sendChatAction() {}
  async answerCallbackQuery() {}
}

const keys = () => {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("rsa", { modulusLength: 3072 });
  return {
    signingPrivate: signing.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    signingPublic: signing.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    encryptionPrivate: encryption.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    encryptionPublic: encryption.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
};

const signedEnvelope = async (
  issuer: TelegramTokenIntakeGrantIssuer,
  encryptionPublicKeySpkiBase64: string,
  input: { action: "create" | "rotate"; credentialId: string; botToken: string; now: Date },
) => {
  const grant = issuer.issue({
    identity: alpha,
    action: input.action,
    credentialId: input.credentialId,
    idempotencyKey: `${input.action}-telegram-intake-idempotency-key`,
    issuedAt: input.now,
    ttlSeconds: 300,
  });
  return {
    grant: grant.token,
    envelope: await encryptTelegramBotTokenEnvelope({
      grantId: grant.grantId,
      encryptionPublicKeySpkiBase64,
      botToken: input.botToken,
    }),
  };
};

test("broker intake atomically consumes one envelope and supports credential rotation without Control seeing the token", async () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  const material = keys();
  const now = new Date();
  const telegram = new IntakeTelegram();
  const service = new ChannelBrokerService(
    new MemoryChannelStore(),
    new ChannelCredentialVault(vaultSecret),
    telegram,
    {} as ChannelControlClient,
    4_000,
    0,
    {
      grantVerifier: new TelegramTokenIntakeGrantVerifier(material.signingPublic),
      envelope: new TelegramTokenIntakeEnvelope(material.encryptionPrivate),
      now: () => now,
    },
  );
  const issuer = new TelegramTokenIntakeGrantIssuer(material.signingPrivate);
  const createdEnvelope = await signedEnvelope(issuer, material.encryptionPublic, {
    action: "create",
    credentialId,
    botToken: firstToken,
    now,
  });

  const created = await service.redeemTelegramTokenIntake(createdEnvelope);
  assert.deepEqual({ id: created.id, version: created.version }, { id: credentialId, version: 1 });
  assert.deepEqual(telegram.validated, [firstToken]);
  await assert.rejects(
    service.redeemTelegramTokenIntake(createdEnvelope),
    { code: "TELEGRAM_INTAKE_GRANT_REPLAYED" },
  );

  const rotateEnvelope = await signedEnvelope(issuer, material.encryptionPublic, {
    action: "rotate",
    credentialId,
    botToken: rotatedToken,
    now,
  });
  const rotated = await service.redeemTelegramTokenIntake(rotateEnvelope);
  assert.deepEqual({ id: rotated.id, version: rotated.version }, { id: credentialId, version: 2 });
  assert.deepEqual(telegram.validated, [firstToken, rotatedToken]);
});

test("the public broker endpoint accepts a signed envelope but rejects deprecated raw hosted intake", async () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  const material = keys();
  const now = new Date();
  const issuer = new TelegramTokenIntakeGrantIssuer(material.signingPrivate);
  const service = new ChannelBrokerService(
    new MemoryChannelStore(),
    new ChannelCredentialVault(vaultSecret),
    new IntakeTelegram(),
    {} as ChannelControlClient,
    4_000,
    0,
    {
      grantVerifier: new TelegramTokenIntakeGrantVerifier(material.signingPublic),
      envelope: new TelegramTokenIntakeEnvelope(material.encryptionPrivate),
      now: () => now,
    },
  );
  const app = createChannelBrokerServer(service, brokerToken, { rawTokenInputMode: "reject" });
  try {
    const envelope = await signedEnvelope(issuer, material.encryptionPublic, {
      action: "create",
      credentialId,
      botToken: firstToken,
      now,
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/public/v1/telegram/intake",
      headers: { "content-type": "application/json" },
      payload: envelope,
    });
    assert.equal(accepted.statusCode, 201);
    assert.equal(accepted.json().id, credentialId);

    const unsignedRaw = await app.inject({
      method: "POST",
      url: "/public/v1/telegram/intake",
      headers: { "content-type": "application/json" },
      payload: { botToken: firstToken },
    });
    assert.equal(unsignedRaw.statusCode, 400);
    assert.equal(unsignedRaw.json().error.code, "INVALID_REQUEST");

    const rejected = await app.inject({
      method: "POST",
      url: "/internal/v1/credentials/telegram",
      headers: { "x-onecomputer-channel-token": brokerToken, "content-type": "application/json" },
      payload: { identity: alpha, botToken: firstToken },
    });
    assert.equal(rejected.statusCode, 410);
    assert.equal(rejected.json().error.code, "TELEGRAM_RAW_TOKEN_INPUT_REJECTED");
  } finally {
    await app.close();
  }
});
