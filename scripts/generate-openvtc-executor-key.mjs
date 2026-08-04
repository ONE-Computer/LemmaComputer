import { randomBytes } from "node:crypto";

process.stdout.write([
  `LEMMACOMPUTER_OPENVTC_EXECUTOR_SEED_B64=${randomBytes(32).toString("base64")}`,
  `LEMMACOMPUTER_OPENVTC_CONSENT_TOKEN=${randomBytes(32).toString("base64url")}`,
  "",
].join("\n"));
