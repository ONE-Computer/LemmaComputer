import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, governedOperationDigest, type GovernedOperationEnvelope } from "@lemmacomputer/contracts";

const baseEnvelope = (): GovernedOperationEnvelope => ({
  version: "1",
  tenantId: "acme",
  subjectId: "alex-morgan",
  workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
  audience: "lemmacomputer-control",
  capabilityId: "files.delete",
  serverName: "lemmacomputer_fixture",
  toolName: "delete_file",
  schemaId: "lemmacomputer.fixture.delete_file.v1",
  arguments: { path: "/Finance/2026/Q3-draft.docx" },
  nonce: "145f0ca8-3d16-41e0-a277-238233714a04",
  expiresAt: "2026-07-19T12:00:00.000Z",
});

test("canonical JSON is stable across object key order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: [3, 2, 1] } }), canonicalJson({ a: { x: [3, 2, 1], y: true }, z: 1 }));
});

test("every authority-bearing operation field changes the digest", () => {
  const original = baseEnvelope();
  const digest = governedOperationDigest(original);
  const mutations: GovernedOperationEnvelope[] = [
    { ...original, tenantId: "other" },
    { ...original, subjectId: "other" },
    { ...original, workspaceId: "50b5aa14-f6ea-42c0-9d4b-1542b0d67390" },
    { ...original, audience: "lemmacomputer-other" },
    { ...original, capabilityId: "files.read" },
    { ...original, serverName: "other_server" },
    { ...original, toolName: "search_files" },
    { ...original, schemaId: "other.schema.v1" },
    { ...original, arguments: { path: "/Finance/2026/other.docx" } },
    { ...original, nonce: "45b91a1f-fb03-4ed4-9e5e-f29a4df64836" },
    { ...original, expiresAt: "2026-07-19T12:00:01.000Z" },
  ];
  for (const mutation of mutations) assert.notEqual(governedOperationDigest(mutation), digest);
});

test("canonical JSON rejects values outside the owned JSON contract", () => {
  assert.throws(() => canonicalJson({ path: undefined }));
  assert.throws(() => canonicalJson({ count: Number.NaN }));
  assert.throws(() => canonicalJson(new Date()));
});
