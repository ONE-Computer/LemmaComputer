import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPkcs8Base64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const publicKeySpkiBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const date = new Date().toISOString().slice(0, 10).replaceAll("-", "_");
const keyId = `psk_policy_${date}`;
const keySet = {
  profile: "lemmacomputer-policy-key-set/v1",
  keys: [{
    keyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64,
    status: "active",
    activatedAt: new Date().toISOString(),
    expiresAt: null,
  }],
};

const entries = [
  `LEMMACOMPUTER_POLICY_SIGNING_KEY_ID=${keyId}`,
  `LEMMACOMPUTER_POLICY_SIGNING_PRIVATE_KEY_B64=${privateKeyPkcs8Base64}`,
  `LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64=${Buffer.from(JSON.stringify(keySet), "utf8").toString("base64")}`,
  "LEMMACOMPUTER_POLICY_BUNDLE_TTL_SECONDS=86400",
];

const output = `${entries.join("\n")}\n`;
const envFileIndex = process.argv.indexOf("--write-env");
if (envFileIndex === -1) {
  process.stdout.write(output);
} else {
  const envFile = process.argv[envFileIndex + 1];
  if (!envFile || envFile.startsWith("-")) throw new Error("--write-env requires a specific environment file");
  const existing = await readFile(envFile, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const names = new Set(entries.map((entry) => entry.slice(0, entry.indexOf("="))));
  const retained = existing
    .split(/\r?\n/)
    .filter((line) => !names.has(line.slice(0, line.indexOf("="))))
    .join("\n")
    .replace(/\n+$/, "");
  await writeFile(envFile, `${retained ? `${retained}\n` : ""}${output}`, { mode: 0o600 });
  process.stdout.write(`Updated ${envFile} with a new policy signing key and public verification set.\n`);
}
