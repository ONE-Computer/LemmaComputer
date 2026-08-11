import assert from "node:assert/strict";
import test from "node:test";

import {
  CaptureTransactionalEmailAdapter,
  PostmarkTransactionalEmailAdapter,
  createTransactionalEmailAdapter,
  deliverOrganizationInvitationEmail,
  type TransactionalEmailMessage,
} from "../apps/control-api/src/transactional-email.js";

const message = (suffix = "one"): TransactionalEmailMessage => ({
  kind: "email-verification",
  to: `person-${suffix}@example.test`,
  subject: "Verify your LemmaComputer account",
  text: `Open https://app.example.test/verify?token=secret-${suffix}`,
  html: `<p>Open <a href="https://app.example.test/verify?token=secret-${suffix}">verification</a></p>`,
});

test("capture delivery is bounded, deterministic, consumptive, and ephemeral", async () => {
  const adapter = new CaptureTransactionalEmailAdapter({ capacity: 2 });
  assert.deepEqual(await adapter.send(message("one")), { accepted: true, providerMessageId: null, failure: null });
  assert.deepEqual(await adapter.send(message("two")), { accepted: true, providerMessageId: null, failure: null });
  await assert.rejects(() => adapter.send(message("three")), /capacity/i);

  assert.deepEqual(adapter.take("person-one@example.test", "email-verification"), message("one"));
  assert.equal(adapter.take("person-one@example.test", "email-verification"), null);
  assert.deepEqual(adapter.take("person-two@example.test", "email-verification"), message("two"));
  assert.equal(adapter.size, 0);

  await adapter.send(message("clear"));
  adapter.clear();
  assert.equal(adapter.size, 0);
});

test("organization invitation delivery renders one provider-neutral activation message", async () => {
  const adapter = new CaptureTransactionalEmailAdapter();
  const activationUrl = "https://app.example.test/invite?token=oci_secret-capability";
  await deliverOrganizationInvitationEmail(adapter, {
    recipient: "invitee@example.test",
    organizationDisplayName: "Research & Development <Team>",
    role: "admin",
    activationUrl,
    expiresAt: new Date("2026-08-16T02:00:00.000Z"),
  });
  const captured = adapter.take("invitee@example.test", "organization-invitation");
  assert.ok(captured);
  assert.equal(adapter.size, 0);
  assert.equal(captured.subject, "Join Research & Development <Team> on LemmaComputer");
  assert.match(captured.text, /Administrator/);
  assert.match(captured.text, new RegExp(activationUrl.replace(/[?]/g, "\\?")));
  assert.doesNotMatch(captured.html, /<Team>/);
  assert.match(captured.html, /Research &amp; Development &lt;Team&gt;/);
  assert.match(captured.html, /oci_secret-capability/);
  assert.equal(captured.text.match(/https:\/\/app\.example\.test\/invite\?token=oci_secret-capability/g)?.length, 1);
  assert.equal(captured.html.match(/href=/g)?.length, 1);
});

test("factory rejects capture in hosted production and missing Postmark custody", () => {
  assert.throws(() => createTransactionalEmailAdapter({
    transport: "capture",
    installationKind: "hosted",
    runtimeEnvironment: "production",
  }), /capture.*hosted production/i);
  assert.throws(() => createTransactionalEmailAdapter({
    transport: "postmark",
    installationKind: "hosted",
    runtimeEnvironment: "production",
  }), /Postmark server token/i);
});

test("Postmark delivery sends only the rendered message and returns provider-neutral metadata", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new PostmarkTransactionalEmailAdapter({
    serverToken: "postmark-server-token-secret",
    from: "accounts@lemmacomputer.example",
    messageStream: "auth",
    timeoutMs: 2_000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ MessageID: "postmark-message-123", ErrorCode: 0, Message: "OK" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(await adapter.send(message()), {
    accepted: true,
    providerMessageId: "postmark-message-123",
    failure: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.postmarkapp.com/email");
  assert.equal(new Headers(calls[0]?.init.headers).get("x-postmark-server-token"), "postmark-server-token-secret");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    From: "accounts@lemmacomputer.example",
    To: "person-one@example.test",
    Subject: message().subject,
    TextBody: message().text,
    HtmlBody: message().html,
    MessageStream: "auth",
  });
});

test("Postmark delivery defaults to the standard outbound stream and rejects unsafe stream names", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const adapter = new PostmarkTransactionalEmailAdapter({
    serverToken: "postmark-server-token-secret",
    from: "accounts@lemmacomputer.example",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ MessageID: "postmark-message-default", ErrorCode: 0 });
    },
  });
  assert.equal((await adapter.send(message())).accepted, true);
  assert.equal(requests[0]?.MessageStream, "outbound");
  assert.throws(() => new PostmarkTransactionalEmailAdapter({
    serverToken: "postmark-server-token-secret",
    from: "accounts@lemmacomputer.example",
    messageStream: "auth\r\nX-Test: injected",
  }), /message stream/i);
});

test("Postmark failures are bounded, classified, and never expose provider or message secrets", async () => {
  for (const [status, failure] of [[429, "retryable"], [503, "retryable"], [422, "terminal"]] as const) {
    const adapter = new PostmarkTransactionalEmailAdapter({
      serverToken: "postmark-server-token-secret",
      from: "accounts@lemmacomputer.example",
      fetch: async () => new Response(JSON.stringify({ ErrorCode: 10, Message: "token=leaked-provider-detail" }), { status }),
    });
    const result = await adapter.send(message());
    assert.deepEqual(result, { accepted: false, providerMessageId: null, failure });
    assert.doesNotMatch(JSON.stringify(result), /secret|leaked-provider-detail|postmark-server-token/i);
  }

  const timeout = new PostmarkTransactionalEmailAdapter({
    serverToken: "postmark-server-token-secret",
    from: "accounts@lemmacomputer.example",
    timeoutMs: 5,
    fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted token=secret", "AbortError")));
    }),
  });
  assert.deepEqual(await timeout.send(message()), { accepted: false, providerMessageId: null, failure: "retryable" });
});
