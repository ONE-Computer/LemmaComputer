import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

// Execute the actual adapter against a scripted native SSE stream. No model,
// credentials, Python third-party dependencies, or network are needed.
async function translate(events: unknown[], cancel = false) {
  const adapter = await readFile(new URL("../docker/workspace/lemmacomputer-agent-chat.py", import.meta.url), "utf8");
  const hermes = adapter.slice(adapter.indexOf("async def hermes_vendor_events"), adapter.indexOf("def vendor_events"));
  const program = `
import asyncio, json, re, sys
from typing import Any, AsyncIterator
scenario = json.loads(sys.argv[1])
HERMES_URL, HERMES_KEY, MAX_TURN_SECONDS = "http://fixture", "fixture", 10
IMAGE_TYPES = set()
prompt_with_documents = lambda text, *_: text
prompt_with_transcript = lambda item, text: text
system_prompt = lambda: "fixture"
safe_tool_name = lambda name: name
safe_identifier = lambda *parts: ":".join(parts)
tool_trace_summary = lambda *args: "Reviewed the workspace"
web_action_for_tool = lambda *args: None
extract_sources = lambda text: [{"url": "https://example.com/final", "title": "Final source"}] if "https://example.com/final" in text else []
class Response:
    headers = {"content-type": "text/event-stream"}
    def raise_for_status(self): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *args): return False
    async def aiter_lines(self):
        for name, payload in scenario["events"]:
            yield "event: " + name
            yield "data: " + json.dumps(payload)
            yield ""
        if scenario["cancel"]:
            raise asyncio.CancelledError()
class Http:
    def stream(self, *args, **kwargs): return Response()
http = Http()
${hermes}
async def run():
    output = []
    error = None
    try:
        async for event in hermes_vendor_events({"vendorSessionId": "session-1"}, "Question", [], "turn-1", False, None, None):
            output.append(event)
    except asyncio.CancelledError:
        error = "cancelled"
    except Exception as exc:
        error = str(exc)
    print(json.dumps({"events": output, "error": error}))
asyncio.run(run())
`;
  const { stdout } = await execFileAsync("python3", ["-c", program, JSON.stringify({ events, cancel })]);
  return JSON.parse(stdout) as { events: Array<Record<string, unknown>>; error: string | null };
}

const delta = (text: string) => ["assistant.delta", { delta: text }];
const answer = (text: string, extra = {}) => ["assistant.completed", { content: text, completed: true, ...extra }];
const finish = ["run.completed", { completed: true, session_id: "session-1" }];
const textEvents = (result: Awaited<ReturnType<typeof translate>>) => result.events.filter((event) => event.kind === "text");

test("Hermes keeps tool activity live but publishes only the authoritative final answer once", async () => {
  const result = await translate([
    delta("I will research this."),
    ["tool.started", { tool_name: "read_file", tool_call_id: "read-1" }],
    delta("I will give you a grounded overview."),
    ["tool.completed", { tool_name: "read_file", tool_call_id: "read-1" }],
    delta("Streamed answer that must not be duplicated."),
    answer("The documented result. https://example.com/final"),
    answer("The documented result. https://example.com/final"),
    finish,
  ]);
  assert.equal(result.error, null);
  assert.deepEqual(result.events.map((event) => event.kind), ["tool", "tool", "source", "text", "vendor-finish"]);
  assert.deepEqual(result.events.filter((event) => event.kind === "tool").map((event) => event.state), ["running", "completed"]);
  assert.deepEqual(textEvents(result), [{ kind: "text", delta: "The documented result. https://example.com/final" }]);
  assert.equal(result.events.at(-1)?.vendorSessionId, "session-1");
});

test("Hermes emits a plain final-only answer and preserves the shared needs-input marker", async () => {
  for (const text of ["Hello.", "[LEMMACOMPUTER_NEEDS_INPUT] Which country?"]) {
    for (const prefix of [[], [delta("Let me check.")]]) {
      const result = await translate([...prefix, answer(text), finish]);
      assert.equal(result.error, null);
      assert.deepEqual(textEvents(result), [{ kind: "text", delta: text }]);
    }
  }
});

test("Hermes never falls back to mixed deltas on failure or a missing terminal answer", async () => {
  for (const events of [
    [delta("I will research."), ["error", { message: "provider failure" }]],
    [delta("I will research.")],
    [delta("I will research."), finish],
    [answer("Not yet authoritative.")],
    [answer("Partial", { partial: true }), finish],
    [answer("Interrupted", { interrupted: true }), finish],
    [answer("API call failed after 3 retries: private upstream detail"), finish],
    [answer("Not successful."), ["run.completed", { completed: false }]],
  ]) {
    const result = await translate(events);
    assert.ok(result.error, JSON.stringify(events));
    assert.deepEqual(textEvents(result), []);
    assert.ok(!result.events.some((event) => event.kind === "vendor-finish"));
  }
});

test("Hermes cancellation propagates without publishing buffered text or success", async () => {
  const result = await translate([delta("I will research."), answer("Not yet committed.")], true);
  assert.equal(result.error, "cancelled");
  assert.deepEqual(result.events, []);
});

test("Hermes accepts an explicit empty final for artifact-only turns", async () => {
  const result = await translate([delta("I am making the file."), answer(""), finish]);
  assert.equal(result.error, null);
  assert.deepEqual(textEvents(result), []);
  assert.equal(result.events.at(-1)?.kind, "vendor-finish");
});
