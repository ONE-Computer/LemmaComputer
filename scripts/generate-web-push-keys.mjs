import { randomBytes } from "node:crypto";
import webPush from "web-push";

const keys = webPush.generateVAPIDKeys();
process.stdout.write([
  "LEMMACOMPUTER_WEB_PUSH_VAPID_SUBJECT=mailto:replace-with-operations-contact@example.com",
  `LEMMACOMPUTER_WEB_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `LEMMACOMPUTER_WEB_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`,
  `LEMMACOMPUTER_WEB_PUSH_SUBSCRIPTION_SECRET=${randomBytes(32).toString("base64url")}`,
  "",
].join("\n"));
