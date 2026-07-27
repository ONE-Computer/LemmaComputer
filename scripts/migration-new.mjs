import { randomBytes } from "node:crypto";
import { open, readdir } from "node:fs/promises";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const encode = (value, length) => {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output = alphabet[Number(value % 32n)] + output;
    value /= 32n;
  }
  return output;
};
const name = process.argv[2]?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
if (!name) throw new Error("Usage: npm run db:migration:new -- <short-name>");
const bytes = randomBytes(10);
let random = 0n;
for (const byte of bytes) random = (random << 8n) | BigInt(byte);
const id = `${encode(BigInt(Date.now()), 10)}${encode(random, 16)}`;
const previous = (await readdir("packages/workspace-store/migrations"))
  .filter((file) => file.endsWith(".sql"))
  .sort((left, right) => {
    const leftLegacy = /^\d{3}_/.test(left);
    const rightLegacy = /^\d{3}_/.test(right);
    return leftLegacy === rightLegacy ? left.localeCompare(right) : leftLegacy ? -1 : 1;
  })
  .at(-1)?.split("_", 1)[0];
if (!previous) throw new Error("No existing migration dependency found");
const path = `packages/workspace-store/migrations/${id}_${name}.sql`;
const handle = await open(path, "wx", 0o644);
try {
  await handle.writeFile(`-- id: ${id}\n-- depends-on: ${previous}\n\n-- Forward-only migration. Add safe, bounded SQL below.\n`);
} finally {
  await handle.close();
}
process.stdout.write(`${path}\n`);
