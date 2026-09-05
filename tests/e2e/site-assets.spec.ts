import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { MemoryArtifactStore } from "@lemmacomputer/artifact-store";
import { MemorySiteStore, MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import { createControlServer } from "../../apps/control-api/src/server.js";
import { SitesService } from "../../apps/control-api/src/sites.js";
import { createDeterministicSiteZip, validateSiteBundle } from "../../apps/control-api/src/site-bundle.js";

test("real Sites gateway serves opaque-sandbox modules, CSS and JSON and revokes access", async ({ page }, testInfo) => {
  const proxyToken = "site-browser-fixture-proxy-secret-at-least-32-characters";
  const owner = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" };
  const accountUserId = randomUUID(), authenticationSessionId = randomUUID();
  let signedIn = true, organization = "acme";
  const store = new MemorySiteStore(), artifacts = new MemoryArtifactStore();
  const requests: Array<{ path: string; cookie: boolean; status: number }> = [];
  let control: ReturnType<typeof createControlServer>;
  let handle = "";
  const server = createServer(async (request, response) => {
    if (request.url === "/viewer") {
      response.setHeader("content-type", "text/html");
      response.end(`<iframe sandbox="allow-scripts"></iframe><script>
        fetch('/api/v1/sites/viewer/${handle}').then(r=>r.json()).then(v=>document.querySelector('iframe').src=v.entryUrl);
      </script>`);
      return;
    }
    const result = await control.inject({ method: "GET", url: request.url!.replace(/^\/api/, ""),
      headers: { ...request.headers, "x-lemmacomputer-proxy-token": proxyToken } });
    requests.push({ path: request.url!, cookie: Boolean(request.headers.cookie), status: result.statusCode });
    response.writeHead(result.statusCode, result.headers);
    response.end(result.rawPayload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const resolution = () => signedIn ? { status: "authorized", accountUserId, authenticationSessionId,
    user: { id: accountUserId, email: "alex@example.test", name: "Alex" }, memberships: [],
    principal: { tenantId: organization, userId: "alex", accountUserId, role: "member" } } : { status: "anonymous" };
  control = createControlServer(new MemoryWorkspaceStore(), {} as never, proxyToken, undefined, undefined, { publicWebUrl: origin }, {
    agentBridgeSecret: "site-browser-agent-secret-at-least-32-characters",
    siteStore: store, artifactStore: artifacts,
    customerProductAuthentication: {
      resolve: async (headers: Headers) => headers.get("cookie")?.includes("site_test=valid") ? resolution() : { status: "anonymous" },
      resolveSiteViewerSession: async (id: string, account: string) => id === authenticationSessionId && account === accountUserId ? resolution() : { status: "anonymous" },
    } as never,
  });
  const service = new SitesService(store, artifacts, { publicWebUrl: origin });
  try {
    const zip = createDeterministicSiteZip(new Map([
      ["index.html", Buffer.from('<!doctype html><html><head><link rel="stylesheet" crossorigin href="./assets/app.css"><script type="module" crossorigin src="./assets/app.js"></script></head><body><h1>Loading dashboard</h1><button>Filter</button><p id="result"></p></body></html>')],
      ["assets/app.css", Buffer.from("h1{color:rgb(12, 34, 56)}")],
      ["assets/app.js", Buffer.from('import { title } from "./title.js"; const data=await fetch("./data/snapshot.json").then(r=>r.json()); document.querySelector("h1").textContent=title; document.querySelector("button").onclick=()=>document.querySelector("#result").textContent=data.label;')],
      ["assets/title.js", Buffer.from('export const title="Interactive dashboard";')],
      ["data/snapshot.json", Buffer.from('{"label":"C&P snapshot loaded"}')],
    ]));
    const checked = validateSiteBundle(zip);
    const publicationInput = { name: "Asset browser test", slug: "asset-browser-test", bundleBase64: zip.toString("base64"),
      archiveSha256: checked.archiveSha256, archiveSizeBytes: zip.length, manifestSha256: checked.manifestSha256,
      idempotencyKey: randomUUID(), sourceWorkspaceId: randomUUID(), sourceWorkspaceGeneration: 1, sourceAgentId: "hermes", sourceProjectPath: "Sites/test" };
    const published = await service.publish(owner as never, publicationInput);
    handle = published.handle!;
    await page.context().addCookies([{ name: "site_test", value: "valid", url: origin, sameSite: "Lax", httpOnly: true }]);
    await page.goto(`${origin}/viewer`);
    const frame = page.locator("iframe").contentFrame();
    await expect(frame.getByRole("heading")).toHaveText("Interactive dashboard");
    await expect(frame.getByRole("heading")).toHaveCSS("color", "rgb(12, 34, 56)");
    await frame.getByRole("button").click();
    await expect(frame.getByText("C&P snapshot loaded")).toBeVisible();
    const iframe = page.frames().find((value) => value.parentFrame())!;
    expect(await iframe.evaluate(() => {
      try { return window.parent.document.body.textContent; } catch { return "blocked"; }
    })).toBe("blocked");
    expect(await iframe.evaluate(() => { try { return document.cookie; } catch { return "blocked"; } })).toBe("blocked");
    expect(await iframe.evaluate(async (url) => {
      try { await fetch(`${url}/api/v1/sites`); return "allowed"; } catch { return "blocked"; }
    }, origin)).toBe("blocked");
    const assetRequests = requests.filter((value) => /\.(css|js|json)$/.test(value.path));
    expect(assetRequests).toHaveLength(4);
    expect(assetRequests.every((value) => value.status === 200 && !value.cookie)).toBe(true);
    const entryUrl = await page.locator("iframe").getAttribute("src");
    const resource = entryUrl!.replace(/index.html$/, "data/snapshot.json");
    // Current ACL, not the grant's original role, is authoritative on every read.
    organization = "foreign";
    expect((await page.request.get(`${origin}${resource}`)).status()).toBe(404);
    organization = "acme";
    signedIn = false;
    expect((await page.request.get(`${origin}${resource}`)).status()).toBe(404);
    signedIn = true;
    expect((await page.request.get(`${origin}${resource.replace('/versions/1/', '/versions/2/')}`)).status()).toBe(404);
    const externalOwner = { ...owner, tenantId: "other-org", subjectId: "bob" };
    const sharedSite = await service.publish(externalOwner as never, { ...publicationInput, idempotencyKey: randomUUID() });
    const sharedGrant = await service.grant(externalOwner, sharedSite.id, { accountUserId });
    const sharedViewer = await page.request.get(`${origin}/api/v1/sites/viewer/${sharedSite.handle}`);
    expect(sharedViewer.status()).toBe(200);
    const sharedResource = (await sharedViewer.json()).entryUrl.replace(/index.html$/, "data/snapshot.json");
    expect((await page.request.get(`${origin}${sharedResource}`)).status()).toBe(200);
    await service.revokeGrant(externalOwner, sharedSite.id, sharedGrant.id);
    expect((await page.request.get(`${origin}${sharedResource}`)).status()).toBe(404);
    await service.delete({ ...owner, accountUserId }, published.id);
    expect((await page.request.get(`${origin}${resource}`)).status()).toBe(404);
    await testInfo.attach("authenticated-multifile-site", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await control.close();
  }
});
