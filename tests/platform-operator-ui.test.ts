import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformOperatorSession } from "@lemmacomputer/workspace-store";
import { renderPlatformOperatorUi } from "../apps/control-api/src/platform-operator-ui.js";

const session = {
  principal: {
    realm: "platform-operator",
    operatorSessionId: "22222222-2222-4222-8222-222222222222",
    operatorId: "33333333-3333-4333-8333-333333333333",
    identity: { provider: "better-auth", issuer: "https://issuer.example.test", subject: "operator" },
    assurance: { level: "aal2", factors: ["federated", "totp"] },
    authenticatedAt: "2026-08-09T03:00:00.000Z",
    recentStepUpAt: "2026-08-09T03:05:00.000Z",
  },
  roles: ["platform-administrator"],
} as PlatformOperatorSession;

test("operator UI encodes bootstrap JSON and optional base URL as inert data", () => {
  const maliciousSession = {
    ...session,
    principal: { ...session.principal, operatorId: "</script><script>alert('operator')</script>" },
  } as PlatformOperatorSession;
  const html = renderPlatformOperatorUi(maliciousSession, { baseHref: '\"><script>alert("base")</script>' });
  assert.doesNotMatch(html, /<script>alert\(["'](?:operator|base)/);
  assert.match(html, /\\u003c\/script>/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test("operator UI identifies the isolated passkey realm", () => {
  const html = renderPlatformOperatorUi({
    ...session,
    principal: {
      ...session.principal,
      identity: { provider: "better-auth", issuer: "urn:lemmacomputer:platform-better-auth", subject: "local-operator" },
      assurance: { level: "aal2", factors: ["passkey"] },
    },
  } as PlatformOperatorSession);
  assert.match(html, /Platform passkey realm/);
  assert.match(html, /Platform control plane/);
  assert.doesNotMatch(html, /Workforce operator realm/);
});
