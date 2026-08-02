import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import test from "node:test";
import {
  TelegramTokenIntakeEnvelope,
  TelegramTokenIntakeGrantIssuer,
  TelegramTokenIntakeGrantVerifier,
  telegramTokenIntakeGrantSchema,
} from "@onecomputer/contracts";
import { encryptTelegramBotTokenEnvelope } from "../apps/web/src/telegram-token-intake.js";

const identity = {
  tenantId: "tenant-alpha",
  subjectId: "user-alpha",
  audience: "onecomputer-control" as const,
};
const credentialId = "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24";
const botToken = "123456789:telegram-token-that-must-never-reach-control";

const keyMaterial = () => {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("rsa", { modulusLength: 3072 });
  return {
    signingPrivateKeyPkcs8Base64: signing.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    signingPublicKeySpkiBase64: signing.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    encryptionPrivateKeyPkcs8Base64: encryption.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    encryptionPublicKeySpkiBase64: encryption.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
};

test("a broker-only Telegram intake envelope binds the token to one short-lived grant", async () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  const keys = keyMaterial();
  const issuedAt = new Date("2026-08-02T00:00:00.000Z");
  const issuer = new TelegramTokenIntakeGrantIssuer(keys.signingPrivateKeyPkcs8Base64);
  const verifier = new TelegramTokenIntakeGrantVerifier(keys.signingPublicKeySpkiBase64);
  const grant = issuer.issue({
    identity,
    action: "create",
    credentialId,
    idempotencyKey: "telegram-create-idempotency-key",
    issuedAt,
    ttlSeconds: 300,
  });

  const verified = verifier.verify(grant.token, issuedAt);
  assert.equal(verified.tenantId, identity.tenantId);
  assert.equal(verified.subjectId, identity.subjectId);
  assert.equal(verified.credentialId, credentialId);
  assert.equal(verified.action, "create");
  assert.ok(!grant.token.includes(botToken));

  const envelope = await encryptTelegramBotTokenEnvelope({
    grantId: grant.grantId,
    encryptionPublicKeySpkiBase64: keys.encryptionPublicKeySpkiBase64,
    botToken,
  });
  assert.ok(!JSON.stringify(envelope).includes(botToken));

  const opened = new TelegramTokenIntakeEnvelope(keys.encryptionPrivateKeyPkcs8Base64)
    .open(envelope, grant.grantId);
  assert.equal(opened, botToken);
});

test("the broker rejects tampered, expired, and cross-grant Telegram intake material", async () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  const keys = keyMaterial();
  const issuedAt = new Date("2026-08-02T00:00:00.000Z");
  const issuer = new TelegramTokenIntakeGrantIssuer(keys.signingPrivateKeyPkcs8Base64);
  const verifier = new TelegramTokenIntakeGrantVerifier(keys.signingPublicKeySpkiBase64);
  const grant = issuer.issue({
    identity,
    action: "rotate",
    credentialId,
    idempotencyKey: "telegram-rotate-idempotency-key",
    issuedAt,
    ttlSeconds: 30,
  });
  const envelope = await encryptTelegramBotTokenEnvelope({
    grantId: grant.grantId,
    encryptionPublicKeySpkiBase64: keys.encryptionPublicKeySpkiBase64,
    botToken,
  });

  await assert.rejects(
    Promise.resolve().then(() => verifier.verify(grant.token, new Date("2026-08-02T00:00:31.000Z"))),
    { code: "TELEGRAM_INTAKE_GRANT_EXPIRED" },
  );
  assert.throws(
    () => new TelegramTokenIntakeEnvelope(keys.encryptionPrivateKeyPkcs8Base64)
      .open(envelope, "02bf576c-83f1-4c7b-bbcb-6d4d50fbab24"),
    { code: "TELEGRAM_INTAKE_ENVELOPE_INVALID" },
  );

  const [header, payload, signature] = grant.token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
    tenantId: "tenant-bravo",
  })).toString("base64url");
  assert.throws(
    () => verifier.verify(`${header}.${tamperedPayload}.${signature}`, issuedAt),
    { code: "TELEGRAM_INTAKE_GRANT_INVALID" },
  );
});

test("the intake grant can name only the same-origin broker path", () => {
  assert.throws(() => telegramTokenIntakeGrantSchema.parse({
    grant: "header.payload.signature",
    grantId: credentialId,
    credentialId,
    action: "create",
    expiresAt: "2026-08-02T00:05:00.000Z",
    intakeUrl: "//untrusted.example/telegram",
    encryption: {
      algorithm: "RSA-OAEP-256+A256GCM",
      keyId: "telegram-intake-rsa-oaep-256-v1",
      publicKeySpkiBase64: "A".repeat(256),
    },
  }));
});
