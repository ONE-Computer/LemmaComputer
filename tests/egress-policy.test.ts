import assert from "node:assert/strict";
import test from "node:test";
import {
  egressSecurityGroupVersionSchema,
  type EgressSecurityGroupVersion,
} from "@lemmacomputer/contracts";
import {
  compileEgressSecurityGroup,
  compileRuntimeEgressPolicy,
  decideEgress,
  deriveEgressProxySecret,
  issueEgressProxyGrant,
  normalizeEgressHost,
  PublicHttpsTargetValidationError,
  validatePublicHttpsTarget,
  verifyEgressProxyGrant,
} from "@lemmacomputer/egress-policy";

const group = egressSecurityGroupVersionSchema.parse({
  schemaVersion: 1,
  id: "egv_acme_updates_v1",
  securityGroupId: "esg_acme_updates",
  tenantId: "acme",
  version: 1,
  name: "Approved agent updates",
  description: "Exact reviewed update destinations.",
  defaultAction: "deny",
  rules: [
    {
      id: "anthropic-downloads",
      action: "allow",
      protocol: "https",
      host: "downloads.claude.ai",
      includeSubdomains: false,
      port: 443,
      purpose: "Claude Desktop and Claude Code updates",
    },
    {
      id: "example-subdomains",
      action: "allow",
      protocol: "https",
      host: "updates.example.com",
      includeSubdomains: true,
      port: 443,
      purpose: "Qualification fixture",
    },
  ],
  documentHash: "a".repeat(64),
  createdBy: "admin-1",
  createdAt: "2026-07-23T04:30:00.000Z",
}) satisfies EgressSecurityGroupVersion;

test("egress host normalization is deterministic and rejects literals or wildcards", () => {
  assert.equal(normalizeEgressHost("DOWNLOADS.CLAUDE.AI."), "downloads.claude.ai");
  assert.equal(normalizeEgressHost("BÜCHER.example"), "xn--bcher-kva.example");
  assert.throws(() => normalizeEgressHost("127.0.0.1"), /IP literal/i);
  assert.throws(() => normalizeEgressHost("[::1]"), /IP literal/i);
  assert.throws(() => normalizeEgressHost("*.example.com"), /wildcard/i);
  assert.equal(normalizeEgressHost("example.com.evil.test."), "example.com.evil.test");
});

test("public HTTPS target validation canonicalizes a hostname and retains every resolved address", async () => {
  let resolvedHost = "";
  const target = await validatePublicHttpsTarget("HTTPS://BÜCHER.Example.:8443/mcp?version=1", {
    resolveHostname: async (hostname) => {
      resolvedHost = hostname;
      return [
        { address: "104.18.0.1", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ];
    },
  });

  assert.equal(resolvedHost, "xn--bcher-kva.example");
  assert.equal(target.canonicalUrl, "https://xn--bcher-kva.example:8443/mcp?version=1");
  assert.equal(target.origin, "https://xn--bcher-kva.example:8443");
  assert.equal(target.host, "xn--bcher-kva.example");
  assert.equal(target.port, 8443);
  assert.deepEqual(target.resolvedAddresses, ["104.18.0.1", "2606:4700:4700::1111"]);
  assert.deepEqual(target.decision, {
    decision: "allow",
    reasonCode: "EGRESS_ALLOWED",
    ruleId: "candidate-public-https-endpoint",
  });
});

test("public HTTPS target validation rejects unsafe URL forms before DNS", async () => {
  const neverResolve = async () => {
    throw new Error("DNS must not be reached for an invalid URL");
  };
  const cases: Array<[string, string]> = [
    ["http://mcp.example.com", "EGRESS_HTTPS_REQUIRED"],
    ["https://user:password@mcp.example.com", "EGRESS_URL_CREDENTIALS_DENIED"],
    ["https://mcp.example.com/#fragment", "EGRESS_URL_FRAGMENT_DENIED"],
    ["https://mcp.example.com/#", "EGRESS_URL_FRAGMENT_DENIED"],
    ["https://127.0.0.1/mcp", "EGRESS_IP_LITERAL_DENIED"],
    ["https://[::1]/mcp", "EGRESS_IP_LITERAL_DENIED"],
  ];

  for (const [endpointUrl, reasonCode] of cases) {
    await assert.rejects(
      validatePublicHttpsTarget(endpointUrl, { resolveHostname: neverResolve }),
      (error: unknown) => (
        error instanceof PublicHttpsTargetValidationError && error.reasonCode === reasonCode
      ),
      endpointUrl,
    );
  }
});

test("public HTTPS target validation denies private IPv4, IPv6, and mixed DNS answers", async () => {
  const reservedAnswers: Array<Array<{ address: string; family: 4 | 6 }>> = [
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "::1", family: 6 }],
    [{ address: "fc00::1", family: 6 }],
    [{ address: "fe80::1", family: 6 }],
    [
      { address: "104.18.0.1", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ],
  ];

  for (const answers of reservedAnswers) {
    await assert.rejects(
      validatePublicHttpsTarget("https://mcp.example.com", {
        resolveHostname: async () => answers,
      }),
      (error: unknown) => (
        error instanceof PublicHttpsTargetValidationError
        && error.reasonCode === "EGRESS_DESTINATION_RESERVED"
      ),
      JSON.stringify(answers),
    );
  }

  await assert.rejects(
    validatePublicHttpsTarget("https://mcp.example.com", {
      resolveHostname: async () => [],
    }),
    (error: unknown) => (
      error instanceof PublicHttpsTargetValidationError
      && error.reasonCode === "EGRESS_DNS_UNAVAILABLE"
    ),
  );
});

test("security groups compile to exact, deny-by-default rules", () => {
  const compiled = compileEgressSecurityGroup(group);
  assert.equal(compiled.defaultAction, "deny");
  assert.deepEqual(compiled.rules.map((rule) => rule.host), [
    "downloads.claude.ai",
    "updates.example.com",
  ]);
  assert.equal(compiled.documentHash, group.documentHash);
});

test("egress decisions match exact hosts and explicit subdomains without hostile suffixes", () => {
  const compiled = compileEgressSecurityGroup(group);
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "downloads.claude.ai",
    port: 443,
    resolvedAddresses: ["104.18.0.1"],
  }).reasonCode, "EGRESS_ALLOWED");
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "cdn.updates.example.com",
    port: 443,
    resolvedAddresses: ["104.18.0.2"],
  }).reasonCode, "EGRESS_ALLOWED");
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "downloads.claude.ai.evil.test",
    port: 443,
    resolvedAddresses: ["104.18.0.3"],
  }).reasonCode, "EGRESS_DEFAULT_DENY");
});

test("egress decisions reject raw IPs, reserved resolutions, protocol changes, and alternate ports", () => {
  const compiled = compileEgressSecurityGroup(group);
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "104.18.0.1",
    port: 443,
    resolvedAddresses: ["104.18.0.1"],
  }).reasonCode, "EGRESS_IP_LITERAL_DENIED");
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "downloads.claude.ai",
    port: 443,
    resolvedAddresses: ["169.254.169.254"],
  }).reasonCode, "EGRESS_DESTINATION_RESERVED");
  assert.equal(decideEgress(compiled, {
    protocol: "http",
    host: "downloads.claude.ai",
    port: 443,
    resolvedAddresses: ["104.18.0.1"],
  }).reasonCode, "EGRESS_DEFAULT_DENY");
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "downloads.claude.ai",
    port: 8443,
    resolvedAddresses: ["104.18.0.1"],
  }).reasonCode, "EGRESS_DEFAULT_DENY");
});

test("egress proxy grants are scoped, signed, expiring, and cannot cross workspace boundaries", () => {
  const expected = {
    tenantId: "acme",
    subjectId: "alex",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    securityGroupVersionId: group.id,
    egressMode: "restricted" as const,
    policyHash: "b".repeat(64),
  };
  const now = new Date("2026-07-23T04:00:00.000Z");
  const secret = deriveEgressProxySecret("root-secret-with-at-least-thirty-two-characters", expected.workspaceId);
  const token = issueEgressProxyGrant(secret, expected, now, 60);
  assert.equal(verifyEgressProxyGrant(token, secret, expected, now)?.workspaceId, "workspace-a");
  assert.equal(verifyEgressProxyGrant(`${token}tampered`, secret, expected, now), null);
  assert.equal(verifyEgressProxyGrant(token, secret, { ...expected, workspaceId: "workspace-b" }, now), null);
  assert.equal(verifyEgressProxyGrant(token, secret, { ...expected, tenantId: "other" }, now), null);
  assert.equal(verifyEgressProxyGrant(token, secret, { ...expected, agentId: "agent-b" }, now), null);
  assert.equal(verifyEgressProxyGrant(token, secret, { ...expected, egressMode: "full-web" }, now), null);
  assert.equal(verifyEgressProxyGrant(token, secret, {
    tenantId: expected.tenantId,
    subjectId: expected.subjectId,
    workspaceId: expected.workspaceId,
    agentId: expected.agentId,
  }, now)?.securityGroupVersionId, group.id);
  assert.equal(verifyEgressProxyGrant(token, secret, expected, new Date("2026-07-23T04:01:01.000Z")), null);
});

test("full-web allows only public HTTP and HTTPS on standard ports", () => {
  const compiled = compileRuntimeEgressPolicy({
    schemaVersion: 2,
    mode: "full-web",
    id: "egv_full_web_fixture",
    securityGroupId: "esg_disposable_open",
    version: 1,
    name: "Disposable public web",
    description: "Public web without a destination allowlist.",
    defaultAction: "allow-public-http-https",
    rules: [],
    documentHash: "f".repeat(64),
  });
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "registry.npmjs.org",
    port: 443,
    resolvedAddresses: ["104.16.24.34"],
  }).decision, "allow");
  assert.equal(decideEgress(compiled, {
    protocol: "http",
    host: "example.org",
    port: 80,
    resolvedAddresses: ["93.184.216.34"],
  }).decision, "allow");
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "registry.npmjs.org",
    port: 8443,
    resolvedAddresses: ["104.16.24.34"],
  }).decision, "deny");
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "metadata.google.internal",
    port: 443,
    resolvedAddresses: ["169.254.169.254"],
  }).reasonCode, "EGRESS_DESTINATION_RESERVED");
  for (const reservedAddress of [
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:2::1",
    "2001:db8::1",
    "2002:c000:0201::1",
    "3fff::1",
  ]) {
    assert.equal(decideEgress(compiled, {
      protocol: "https",
      host: "ipv6.example.org",
      port: 443,
      resolvedAddresses: [reservedAddress],
    }).reasonCode, "EGRESS_DESTINATION_RESERVED", reservedAddress);
  }
  assert.equal(decideEgress(compiled, {
    protocol: "https",
    host: "dns.google",
    port: 443,
    resolvedAddresses: ["2001:4860:4860::8888"],
  }).decision, "allow");
});

test("explicit deny rules override both full-web defaults and broader managed allows", () => {
  const denyRule = {
    id: "blocked-packages",
    action: "deny" as const,
    protocol: "https" as const,
    host: "blocked.example.com",
    includeSubdomains: true,
    port: 443,
    purpose: "Block an untrusted package source",
  };
  const fullWeb = compileRuntimeEgressPolicy({
    schemaVersion: 2,
    mode: "full-web",
    id: "egv_full_web_with_deny",
    securityGroupId: "esg_open_exceptions",
    version: 2,
    name: "Open workspace exceptions",
    description: "Default public web with reviewed blocks.",
    defaultAction: "allow-public-http-https",
    rules: [denyRule],
    documentHash: "d".repeat(64),
  });
  assert.deepEqual(decideEgress(fullWeb, {
    protocol: "https",
    host: "cdn.blocked.example.com",
    port: 443,
    resolvedAddresses: ["104.18.0.10"],
  }), {
    decision: "deny",
    reasonCode: "EGRESS_EXPLICIT_DENY",
    ruleId: "blocked-packages",
  });
  assert.equal(decideEgress(fullWeb, {
    protocol: "https",
    host: "registry.npmjs.org",
    port: 443,
    resolvedAddresses: ["104.16.24.34"],
  }).decision, "allow");

  const managed = compileRuntimeEgressPolicy({
    schemaVersion: 2,
    mode: "restricted",
    id: "egv_managed_with_deny",
    securityGroupId: "esg_managed_with_deny",
    version: 1,
    name: "Managed exceptions",
    description: "Allow a domain family except a reviewed host.",
    defaultAction: "deny",
    rules: [
      {
        id: "allow-example",
        action: "allow",
        protocol: "https",
        host: "example.com",
        includeSubdomains: true,
        port: 443,
        purpose: "Approved example services",
      },
      denyRule,
    ],
    documentHash: "e".repeat(64),
  });
  assert.equal(decideEgress(managed, {
    protocol: "https",
    host: "blocked.example.com",
    port: 443,
    resolvedAddresses: ["104.18.0.11"],
  }).reasonCode, "EGRESS_EXPLICIT_DENY");
});
