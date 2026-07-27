import assert from "node:assert/strict";
import test from "node:test";
import {
  environmentParity,
  mergeEnvironment,
} from "../scripts/environment-template.mjs";
import {
  runComposeDown,
  runtimeContainerFilters,
} from "../scripts/compose-down.mjs";

test("environment updates preserve values, map renamed keys, initialize missing keys, and retain extras", () => {
  const template = [
    "KEEP=template-default",
    "KASM_LOCAL_NETWORK_PREFIX=onecomputer-workspace",
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
    "ONECOMPUTER_POLICY_SIGNING_KEY_ID=generated",
    "ONECOMPUTER_POLICY_SIGNING_PRIVATE_KEY_B64=generated",
    "ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64=generated",
  ].join("\n");
  const current = "ONECOMPUTER_POLICY_SIGNING_KEY_ID=existing";

  assert.throws(
    () => mergeEnvironment(template, current, template),
    /coupled environment group must be complete/,
  );
});

test("compose shutdown refuses to bypass managed workspace lifecycle", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let errors = "";
  const status = runComposeDown({
    projectName: "onecomputer",
    run: (command: string, args: string[]) => {
      calls.push({ command, args });
      const filter = args[args.indexOf("--filter") + 1];
      return {
        status: 0,
        stdout: filter === runtimeContainerFilters[0]
          ? "onecomputer-sandbox-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508\n"
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
  assert.match(errors, /Stop every active workspace through ONEComputer/);
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
