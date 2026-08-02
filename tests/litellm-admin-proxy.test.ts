import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createLiteLlmAdminProxy } from "../apps/litellm-admin-proxy/server.mjs";
import { createMutualTlsFetch } from "@onecomputer/litellm-adapter";

type CertificateMaterial = {
  directory: string;
  ca: string;
  serverCertificate: string;
  serverKey: string;
  controlCertificate: string;
  controlKey: string;
};

const listen = (server: ReturnType<typeof createHttpServer>) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: { close(callback: (error?: Error) => void): unknown }) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const generateCertificates = async (): Promise<CertificateMaterial> => {
  const directory = await mkdtemp(join(tmpdir(), "onecomputer-litellm-admin-tls-"));
  const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=onecomputer-test-ca", "-days", "1"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=litellm-admin"]);
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "control.key", "-out", "control.csr", "-subj", "/CN=onecomputer-control"]);
  openssl(["x509", "-req", "-in", "control.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "control.crt", "-days", "1"]);
  return {
    directory,
    ca: await readFile(join(directory, "ca.crt"), "utf8"),
    serverCertificate: await readFile(join(directory, "server.crt"), "utf8"),
    serverKey: await readFile(join(directory, "server.key"), "utf8"),
    controlCertificate: await readFile(join(directory, "control.crt"), "utf8"),
    controlKey: await readFile(join(directory, "control.key"), "utf8"),
  };
};

const request = (port: number, options: { certificate?: string; key?: string }) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const client = httpsRequest({
    host: "127.0.0.1",
    port,
    path: "/key/generate?probe=true",
    method: "POST",
    cert: options.certificate,
    key: options.key,
    rejectUnauthorized: false,
    headers: { authorization: "Bearer control-master-key-never-logged" },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
  });
  client.once("error", reject);
  client.end(JSON.stringify({ key_alias: "probe" }));
});

test("the LiteLLM administration proxy requires a Control client certificate and rejects another workload identity", async () => {
  const certificates = await generateCertificates();
  const received: Array<{ url: string; authorization: string }> = [];
  const upstream = createHttpServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before responding.
    }
    received.push({ url: request.url ?? "", authorization: String(request.headers.authorization ?? "") });
    if (request.url === "/key/delete") {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await listen(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const proxy = createLiteLlmAdminProxy({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    certificate: certificates.serverCertificate,
    privateKey: certificates.serverKey,
    clientCa: certificates.ca,
    expectedClientCommonName: "onecomputer-control",
  });
  await listen(proxy);
  const proxyPort = (proxy.address() as AddressInfo).port;

  try {
    await assert.rejects(request(proxyPort, {}));
    const wrongIdentity = await request(proxyPort, { certificate: certificates.serverCertificate, key: certificates.serverKey });
    assert.equal(wrongIdentity.status, 403);

    const accepted = await request(proxyPort, { certificate: certificates.controlCertificate, key: certificates.controlKey });
    assert.equal(accepted.status, 200);
    const controlFetch = createMutualTlsFetch({
      ca: certificates.ca,
      clientCertificate: certificates.controlCertificate,
      clientKey: certificates.controlKey,
      serverName: "litellm-admin",
    });
    const throughAdapterTransport = await controlFetch(`https://127.0.0.1:${proxyPort}/key/delete`, {
      method: "POST",
      headers: { authorization: "Bearer control-master-key-never-logged", "content-type": "application/json" },
      body: JSON.stringify({ key_aliases: ["probe"] }),
    });
    assert.equal(throughAdapterTransport.status, 204);
    assert.deepEqual(received, [
      { url: "/key/generate?probe=true", authorization: "Bearer control-master-key-never-logged" },
      { url: "/key/delete", authorization: "Bearer control-master-key-never-logged" },
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
    await rm(certificates.directory, { recursive: true, force: true });
  }
});
