import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "@playwright/test";

const grantId = "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24";
const credentialId = "92b8576c-83f1-4c7b-bbcb-6d4d50fbab24";
const botToken = "123456789:telegram-token-that-must-never-reach-control";

test("Telegram credential setup encrypts in the browser before the broker-only intake route", async ({ page }) => {
  const encryption = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const encryptionPublicKeySpkiBase64 = encryption.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const controlBodies: string[] = [];
  const intakeBodies: Array<Record<string, unknown>> = [];

  await page.route("**/api/v1/credentials/telegram/intake-grants", async (route) => {
    const body = route.request().postData() ?? "";
    controlBodies.push(body);
    assert.equal(body, "{}");
    assert.ok((route.request().headers()["idempotency-key"] ?? "").length >= 16);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        grant: "header.payload.signature",
        grantId,
        credentialId,
        action: "create",
        expiresAt: "2026-08-02T00:05:00.000Z",
        intakeUrl: "/api/channel-intake/v1/telegram",
        encryption: {
          algorithm: "RSA-OAEP-256+A256GCM",
          keyId: "telegram-intake-rsa-oaep-256-v1",
          publicKeySpkiBase64: encryptionPublicKeySpkiBase64,
        },
      }),
    });
  });
  await page.route("**/api/channel-intake/v1/telegram", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    intakeBodies.push(body);
    assert.equal(JSON.stringify(body).includes(botToken), false);
    assert.equal(body.grant, "header.payload.signature");
    assert.deepEqual(Object.keys(body).sort(), ["envelope", "grant"]);
    const envelope = body.envelope as Record<string, unknown>;
    assert.equal(envelope.version, 1);
    assert.equal(envelope.algorithm, "RSA-OAEP-256+A256GCM");
    assert.equal(envelope.keyId, "telegram-intake-rsa-oaep-256-v1");
    assert.equal(typeof envelope.encryptedKey, "string");
    assert.equal(typeof envelope.iv, "string");
    assert.equal(typeof envelope.ciphertext, "string");
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: credentialId,
        kind: "telegram_bot_token",
        displayName: "@lemmacomputer_intake_bot",
        botUsername: "lemmacomputer_intake_bot",
        version: 1,
        workspaceId: null,
        connectionId: null,
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
    });
  });

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Credentials" }).click();
  await expect(page.getByRole("heading", { name: "Credentials", exact: true })).toBeVisible();
  await page.locator('input[name="new-telegram-credential"]').fill(botToken);
  await page.getByRole("button", { name: "Add Telegram credential" }).click();

  await expect(page.getByText("Telegram credential stored.")).toBeVisible();
  expect(controlBodies).toEqual(["{}"]);
  expect(intakeBodies).toHaveLength(1);
});
