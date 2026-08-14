import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  environmentParity,
  initializeEnvironment,
  mergeEnvironment,
  parseEnvironment,
} from "../scripts/environment-template.mjs";
import {
  runComposeDown,
  runtimeContainerFilters,
} from "../scripts/compose-down.mjs";

test("environment updates preserve values, map renamed keys, initialize missing keys, and retain extras", () => {
  const template = [
    "KEEP=template-default",
    "KASM_LOCAL_NETWORK_PREFIX=lemmacomputer-workspace",
    "NEW_VALUE=template-default",
    "",
  ].join("\n");
  const current = [
    "KEEP=operator-value",
    "KASM_LOCAL_NETWORK=legacy-network",
    "OPERATOR_EXTENSION=custom",
    "",
  ].join("\n");
  const initialized = [
    "KEEP=initialized",
    "KASM_LOCAL_NETWORK_PREFIX=initialized-network",
    "NEW_VALUE=initialized-value",
    "",
  ].join("\n");

  const merged = mergeEnvironment(template, current, initialized);

  assert.match(merged.contents, /^KEEP=operator-value$/m);
  assert.match(merged.contents, /^KASM_LOCAL_NETWORK_PREFIX=legacy-network$/m);
  assert.match(merged.contents, /^NEW_VALUE=initialized-value$/m);
  assert.match(merged.contents, /^OPERATOR_EXTENSION=custom$/m);
  assert.equal(merged.preserved, 1);
  assert.equal(merged.mapped, 1);
  assert.equal(merged.initialized, 1);
  assert.deepEqual(merged.extras, ["KASM_LOCAL_NETWORK", "OPERATOR_EXTENSION"]);
  assert.deepEqual(environmentParity(template, merged.contents), {
    missing: [],
    extra: ["KASM_LOCAL_NETWORK", "OPERATOR_EXTENSION"],
    duplicates: [],
  });
});

test("environment updates refuse partially configured coupled signing keys", () => {
  const template = [
    "LEMMACOMPUTER_POLICY_SIGNING_KEY_ID=generated",
    "LEMMACOMPUTER_POLICY_SIGNING_PRIVATE_KEY_B64=generated",
    "LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64=generated",
  ].join("\n");
  const current = "LEMMACOMPUTER_POLICY_SIGNING_KEY_ID=existing";

  assert.throws(
    () => mergeEnvironment(template, current, template),
    /coupled environment group must be complete/,
  );
});

test("environment initialization creates separate Telegram grant and envelope key pairs", async () => {
  const template = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  const values = parseEnvironment(initializeEnvironment(template, "Etc/UTC")).values;
  const privateKey = (name: string) => createPrivateKey({
    key: Buffer.from(values.get(name)!, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = (name: string) => createPublicKey({
    key: Buffer.from(values.get(name)!, "base64"),
    format: "der",
    type: "spki",
  });

  assert.equal(privateKey("LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_PRIVATE_KEY_B64").asymmetricKeyType, "ed25519");
  assert.equal(publicKey("LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_PUBLIC_KEY_B64").asymmetricKeyType, "ed25519");
  assert.equal(privateKey("LEMMACOMPUTER_TELEGRAM_INTAKE_ENCRYPTION_PRIVATE_KEY_B64").asymmetricKeyType, "rsa");
  assert.equal(publicKey("LEMMACOMPUTER_TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64").asymmetricKeyType, "rsa");
});

test("compose shutdown refuses to bypass managed workspace lifecycle", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let errors = "";
  const status = runComposeDown({
    projectName: "lemmacomputer",
    run: (command: string, args: string[]) => {
      calls.push({ command, args });
      const filter = args[args.indexOf("--filter") + 1];
      return {
        status: 0,
        stdout: filter === runtimeContainerFilters[0]
          ? "lemmacomputer-sandbox-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508\n"
          : "",
        stderr: "",
      };
    },
    stdout: { write: () => true },
    stderr: { write: (value: string) => { errors += value; return true; } },
  });

  assert.equal(status, 1);
  assert.equal(calls.length, runtimeContainerFilters.length);
  assert.doesNotMatch(calls.map(({ args }) => args.join(" ")).join("\n"), /compose down/);
  assert.match(errors, /Stop every active workspace through LemmaComputer/);
});

test("compose shutdown delegates to Docker only when runtime containers are absent", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let output = "";
  const status = runComposeDown({
    args: ["--volumes"],
    run: (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: "", stderr: "" };
    },
    stdout: { write: (value: string) => { output += value; return true; } },
    stderr: { write: () => true },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls.at(-1), {
    command: "docker",
    args: ["compose", "down", "--volumes"],
  });
  assert.match(output, /Compose-managed volumes were removed/);
});

test("worktree shutdown detects an orphaned workspace relay by its isolated network label", () => {
  let errors = "";
  const status = runComposeDown({
    projectName: "oc-test",
    networkPrefix: "oc-test-workspace",
    run: (command: string, args: string[]) => {
      if (args[0] === "ps") {
        const filter = args[args.indexOf("--filter") + 1];
        return { status: 0, stdout: filter === runtimeContainerFilters[1] ? "orphan-relay\n" : "", stderr: "" };
      }
      if (args[0] === "inspect") {
        return { status: 0, stdout: JSON.stringify({ "com.lemmacomputer.workspace-network": "oc-test-workspace-11111111-1111-4111-8111-111111111111" }), stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
    stdout: { write: () => true },
    stderr: { write: (value: string) => { errors += value; return true; } },
  });

  assert.equal(status, 1);
  assert.match(errors, /orphan-relay/);
});
