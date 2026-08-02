const encoder = new TextEncoder();

const base64url = (value) => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64 = (value) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${normalized}${"=".repeat((4 - normalized.length % 4) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const intakeAad = (grantId) => encoder.encode(`onecomputer.telegram-token-intake.v1:${grantId}`);

export async function encryptTelegramBotTokenEnvelope({ grantId, encryptionPublicKeySpkiBase64, botToken }) {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot securely store a Telegram bot token.");
  if (!/^[0-9a-f-]{36}$/i.test(grantId ?? "")) throw new Error("The Telegram credential request is invalid.");
  if (typeof botToken !== "string" || !botToken.trim()) throw new Error("A Telegram bot token is required.");
  const publicKey = await globalThis.crypto.subtle.importKey(
    "spki",
    fromBase64(encryptionPublicKeySpkiBase64),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const contentKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await globalThis.crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: intakeAad(grantId), tagLength: 128 },
    aesKey,
    encoder.encode(botToken.trim()),
  );
  const encryptedKey = await globalThis.crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, contentKey);
  return {
    version: 1,
    algorithm: "RSA-OAEP-256+A256GCM",
    keyId: "telegram-intake-rsa-oaep-256-v1",
    encryptedKey: base64url(encryptedKey),
    iv: base64url(iv),
    ciphertext: base64url(ciphertext),
  };
}
