import { createHash } from "node:crypto";
import { LemmaComputerError, type IdentityContext } from "@lemmacomputer/contracts";
import type { SiteRecord, SiteStore } from "@lemmacomputer/workspace-store";
import { z } from "zod";

const siteSlugSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const publishSiteSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  slug: siteSlugSchema,
  htmlBase64: z.string().min(1).max(750_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceWorkspaceId: z.uuid(),
  sourceAgentId: z.string().min(1).max(128),
});

const siteView = (site: SiteRecord) => ({
  id: site.id,
  slug: site.slug,
  name: site.name,
  state: site.state,
  currentRevision: site.currentRevision,
  sourceWorkspaceId: site.sourceWorkspaceId,
  sourceAgentId: site.sourceAgentId,
  createdAt: site.createdAt.toISOString(),
  updatedAt: site.updatedAt.toISOString(),
});

export class SitesService {
  constructor(private readonly store: SiteStore) {}

  async list(identity: IdentityContext) {
    return { sites: (await this.store.listOwnedSites(identity)).map(siteView) };
  }

  async publish(identity: IdentityContext, raw: unknown) {
    const input = publishSiteSchema.parse(raw);
    const content = Buffer.from(input.htmlBase64, "base64");
    if (!content.length || content.length > 512 * 1024) {
      throw new LemmaComputerError("SITE_ARTIFACT_TOO_LARGE", "The demo site must be 512 KB or smaller", 413);
    }
    if (content.toString("base64") !== input.htmlBase64) {
      throw new LemmaComputerError("SITE_ARTIFACT_INVALID", "The site artifact is invalid", 400);
    }
    const html = content.toString("utf8");
    if (!Buffer.from(html, "utf8").equals(content) || html.includes("\0") || !/<html(?:\s|>)/i.test(html)) {
      throw new LemmaComputerError("SITE_ARTIFACT_INVALID", "The demo site must be one UTF-8 HTML document", 400);
    }
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== input.artifactSha256) {
      throw new LemmaComputerError("SITE_ARTIFACT_MISMATCH", "The site artifact changed before publishing", 409);
    }
    const site = await this.store.publishSite(identity, {
      slug: input.slug,
      name: input.name,
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceAgentId: input.sourceAgentId,
      artifactSha256: digest,
      contentHtml: html,
      sizeBytes: content.length,
    });
    return siteView(site);
  }

  async preview(identity: IdentityContext, siteId: string) {
    const result = await this.store.getOwnedSiteRevision(identity, z.uuid().parse(siteId));
    if (!result) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return {
      site: siteView(result.site),
      revision: result.revision.revision,
      artifactSha256: result.revision.artifactSha256,
      html: result.revision.contentHtml,
    };
  }

  async delete(identity: IdentityContext, siteId: string) {
    if (!await this.store.deleteOwnedSite(identity, z.uuid().parse(siteId))) {
      throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    }
  }
}
