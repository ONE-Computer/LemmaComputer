import { createHash, randomBytes } from "node:crypto";
import {
  artifactRevisionLocator,
  artifactStagingLocator,
  type ArtifactStore,
} from "@lemmacomputer/artifact-store";
import { LemmaComputerError, type IdentityContext } from "@lemmacomputer/contracts";
import type {
  SiteAccessActor,
  SiteInvitationRecord,
  SiteRecord,
  SiteStore,
  SiteVersionRecord,
} from "@lemmacomputer/workspace-store";
import { z } from "zod";
import {
  defaultSiteBundleLimits,
  normalizeSiteAssetPath,
  validateSiteBundle,
  type SiteBundleLimits,
  type ValidatedSiteBundle,
} from "./site-bundle.js";

const siteSlugSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const siteHandleSchema = z.string().regex(/^[A-Za-z0-9_-]{24}$/);
const sourceProjectPathSchema = z.string().trim().min(1).max(1024).refine((value) => (
  !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((segment) => !segment || segment === "." || segment === "..")
), "sourceProjectPath must be a normalized workspace-relative project path");
const publishSiteSchema = z.strictObject({
  siteId: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  slug: siteSlugSchema,
  bundleBase64: z.string().min(1).max(28_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archiveSizeBytes: z.number().int().min(1).max(defaultSiteBundleLimits.maxArchiveBytes),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(16).max(128),
  sourceWorkspaceId: z.uuid(),
  sourceWorkspaceGeneration: z.number().int().positive(),
  sourceAgentId: z.string().min(1).max(128),
  sourceProjectPath: sourceProjectPathSchema,
});

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const artifactIdFor = (siteId: string) => `artifact-${siteId.replaceAll("-", "")}`;
const revisionIdFor = (versionId: string) => `revision-${versionId.replaceAll("-", "")}`;
const uploadIdFor = (versionId: string) => `upload-${versionId.replaceAll("-", "")}`;
const siteArchiveMediaType = "application/vnd.lemmacomputer.site+zip";

const invitationView = (invitation: SiteInvitationRecord) => ({
  id: invitation.id,
  siteId: invitation.siteId,
  email: invitation.email,
  status: invitation.status,
  deliveryGeneration: invitation.deliveryGeneration,
  expiresAt: invitation.expiresAt.toISOString(),
  acceptedAccountUserId: invitation.acceptedAccountUserId,
  acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
  createdAt: invitation.createdAt.toISOString(),
  updatedAt: invitation.updatedAt.toISOString(),
});

type CachedBundle = { bundle: ValidatedSiteBundle; usedAt: number };

export class SitesService {
  private readonly publicWebUrl: URL;
  private readonly limits: SiteBundleLimits;
  private readonly cache = new Map<string, CachedBundle>();
  private cacheBytes = 0;
  private readonly maxCacheEntries: number;
  private readonly maxCacheBytes: number;

  constructor(
    private readonly store: SiteStore,
    private readonly artifacts: ArtifactStore,
    options: {
      publicWebUrl?: string;
      limits?: Partial<SiteBundleLimits>;
      maxCacheEntries?: number;
      maxCacheBytes?: number;
    } = {},
  ) {
    this.publicWebUrl = new URL(options.publicWebUrl ?? "http://localhost:4174");
    this.limits = Object.freeze({ ...defaultSiteBundleLimits, ...(options.limits ?? {}) });
    this.maxCacheEntries = options.maxCacheEntries ?? 16;
    this.maxCacheBytes = options.maxCacheBytes ?? 100 * 1024 * 1024;
  }

  private stableUrl(site: SiteRecord) {
    return site.handle ? new URL(`/s/${site.handle}`, this.publicWebUrl).toString() : null;
  }

  private async siteView(site: SiteRecord, actor?: SiteAccessActor) {
    const role = actor ? await this.store.getSiteRole(actor, site) : "owner";
    return {
      id: site.id,
      handle: site.handle,
      slug: site.slug,
      name: site.name,
      state: site.state,
      visibility: site.visibility,
      currentRevision: site.currentRevision,
      stableUrl: this.stableUrl(site),
      sourceWorkspaceId: site.sourceWorkspaceId,
      sourceAgentId: site.sourceAgentId,
      role,
      canManage: role === "owner" || role === "admin",
      canDelete: role === "owner",
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
    };
  }

  private versionView(version: SiteVersionRecord) {
    return {
      id: version.id,
      version: version.version,
      state: version.state,
      archiveSha256: version.archiveSha256,
      archiveSizeBytes: version.archiveSizeBytes,
      manifestSha256: version.manifestSha256,
      extractedSizeBytes: version.extractedSizeBytes,
      fileCount: version.fileCount,
      sourceWorkspaceId: version.sourceWorkspaceId,
      sourceWorkspaceGeneration: version.sourceWorkspaceGeneration,
      sourceAgentId: version.sourceAgentId,
      sourceProjectPath: version.sourceProjectPath,
      failureCode: version.failureCode,
      createdAt: version.createdAt.toISOString(),
      readyAt: version.readyAt?.toISOString() ?? null,
    };
  }

  async list(actor: SiteAccessActor) {
    return { sites: await Promise.all((await this.store.listSites(actor)).map((site) => this.siteView(site, actor))) };
  }

  async listOwned(identity: IdentityContext) {
    return { sites: await Promise.all((await this.store.listOwnedSites(identity)).map((site) => this.siteView(site))) };
  }

  async inspectOwned(identity: IdentityContext, rawSiteId: string) {
    const publication = await this.store.getOwnedPublication(identity, z.uuid().parse(rawSiteId));
    if (!publication) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return {
      ...await this.siteView(publication.site),
      publishedVersion: publication.version ? this.versionView(publication.version) : null,
    };
  }

  async publish(identity: IdentityContext, raw: unknown) {
    const input = publishSiteSchema.parse(raw);
    const archive = Buffer.from(input.bundleBase64, "base64");
    if (archive.toString("base64") !== input.bundleBase64) throw new LemmaComputerError("SITE_BUNDLE_INVALID", "The site bundle encoding is invalid", 400);
    const bundle = validateSiteBundle(archive, this.limits);
    if (
      archive.length !== input.archiveSizeBytes
      || bundle.archiveSha256 !== input.archiveSha256
      || bundle.manifestSha256 !== input.manifestSha256
    ) throw new LemmaComputerError("SITE_BUNDLE_MISMATCH", "The site bundle changed before publishing", 409);
    const prepared = await this.store.prepareSiteVersion(identity, {
      ...(input.siteId ? { siteId: input.siteId } : {}),
      slug: input.slug,
      name: input.name,
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceWorkspaceGeneration: input.sourceWorkspaceGeneration,
      sourceAgentId: input.sourceAgentId,
      sourceProjectPath: input.sourceProjectPath,
      storageBackend: this.artifacts.backend,
      archiveSha256: bundle.archiveSha256,
      archiveSizeBytes: bundle.archiveSizeBytes,
      manifestSha256: bundle.manifestSha256,
      manifest: bundle.manifest as unknown as Record<string, unknown>,
      extractedSizeBytes: bundle.extractedSizeBytes,
      fileCount: bundle.manifest.files.length,
      idempotencyKeyHash: digest(Buffer.from(input.idempotencyKey)),
    });
    if (prepared.version.state === "ready") return {
      published: true,
      ...await this.siteView(prepared.site),
      publishedVersion: prepared.version.version,
    };
    if (prepared.version.state === "failed") {
      throw new LemmaComputerError("SITE_PUBLICATION_FAILED", "This publication attempt previously failed; rebuild and publish again", 409);
    }
    const { site, version } = prepared;
    const uploadId = uploadIdFor(version.id);
    let stagingLocator = version.stagingLocator;
    let finalLocator: string | undefined;
    try {
      if (!stagingLocator) {
        try {
          stagingLocator = await this.artifacts.stage({
            tenantId: identity.tenantId,
            uploadId,
            mediaType: siteArchiveMediaType,
            bytes: archive,
            sha256: bundle.archiveSha256,
          });
        } catch (stageError) {
          const expected = artifactStagingLocator(identity.tenantId, uploadId);
          try {
            await this.artifacts.read({ locator: expected, byteLength: archive.length, sha256: bundle.archiveSha256 });
            stagingLocator = expected;
          } catch { throw stageError; }
        }
        if (!await this.store.setSiteVersionStagingLocator(identity, site.id, version.id, stagingLocator)) {
          throw new Error("Site publication staging record is no longer active");
        }
      }
      const artifactId = artifactIdFor(site.id);
      const revisionId = revisionIdFor(version.id);
      try {
        finalLocator = await this.artifacts.finalize({
          tenantId: identity.tenantId,
          uploadId,
          artifactId,
          revisionId,
          stagingLocator,
          mediaType: siteArchiveMediaType,
          byteLength: archive.length,
          sha256: bundle.archiveSha256,
        });
      } catch (finalizeError) {
        // A process can stop after ArtifactStore made the immutable copy but
        // before PostgreSQL moved the live pointer. Prove that exact copy is
        // present and resume the same idempotent publication.
        const expected = artifactRevisionLocator(identity.tenantId, artifactId, revisionId);
        try {
          await this.artifacts.read({ locator: expected, byteLength: archive.length, sha256: bundle.archiveSha256 });
          finalLocator = expected;
        } catch { throw finalizeError; }
      }
      await this.artifacts.read({ locator: finalLocator, byteLength: archive.length, sha256: bundle.archiveSha256 });
      const finalized = await this.store.finalizeSiteVersion(identity, site.id, version.id, finalLocator);
      if (!finalized) throw new Error("Site publication could not move its published version pointer");
      return {
        published: true,
        ...await this.siteView(finalized.site),
        publishedVersion: finalized.version.version,
      };
    } catch (error) {
      // PostgreSQL may commit the live-pointer update even if the connection
      // drops before the caller receives COMMIT. Re-read before deleting the
      // immutable object so an acknowledged commit can never point at a
      // cleanup-deleted bundle.
      try {
        const committed = await this.store.getOwnedPublication(identity, site.id);
        if (committed?.version?.id === version.id && committed.version.state === "ready") {
          return {
            published: true,
            ...await this.siteView(committed.site),
            publishedVersion: committed.version.version,
          };
        }
      } catch { /* Preserve the original publication failure. */ }
      if (finalLocator) await this.artifacts.delete(finalLocator).catch(() => undefined);
      if (stagingLocator) await this.artifacts.deleteStaging(stagingLocator).catch(() => undefined);
      await this.store.failSiteVersion(identity, site.id, version.id, "artifact_publication_failed").catch(() => undefined);
      if (error instanceof LemmaComputerError) throw error;
      throw new LemmaComputerError("SITE_STORAGE_UNAVAILABLE", "The site bundle could not be stored; the previous version is still live", 503, true);
    }
  }

  private evictCache() {
    while (this.cache.size > this.maxCacheEntries || this.cacheBytes > this.maxCacheBytes) {
      const oldest = [...this.cache.entries()].sort(([, left], [, right]) => left.usedAt - right.usedAt)[0];
      if (!oldest) return;
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].bundle.extractedSizeBytes;
    }
  }

  private async bundleFor(version: SiteVersionRecord) {
    const cached = this.cache.get(version.id);
    if (cached) { cached.usedAt = Date.now(); return cached.bundle; }
    if (!version.storageLocator || version.state !== "ready") throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    let bytes: Buffer;
    try {
      bytes = await this.artifacts.read({ locator: version.storageLocator, byteLength: version.archiveSizeBytes, sha256: version.archiveSha256 });
    } catch {
      throw new LemmaComputerError("SITE_STORAGE_UNAVAILABLE", "The published site is temporarily unavailable", 503, true);
    }
    const bundle = validateSiteBundle(bytes, this.limits);
    if (
      bundle.manifestSha256 !== version.manifestSha256
      || bundle.extractedSizeBytes !== version.extractedSizeBytes
      || bundle.manifest.files.length !== version.fileCount
    ) throw new LemmaComputerError("SITE_ARTIFACT_MISMATCH", "The published site failed its integrity check", 503, true);
    this.cache.set(version.id, { bundle, usedAt: Date.now() });
    this.cacheBytes += bundle.extractedSizeBytes;
    this.evictCache();
    return bundle;
  }

  async viewer(actor: SiteAccessActor, rawHandle: string) {
    const handle = siteHandleSchema.parse(rawHandle);
    const publication = await this.store.getAccessiblePublicationByHandle(actor, handle);
    if (!publication?.version) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return {
      tenantId: publication.site.tenantId,
      site: await this.siteView(publication.site, actor),
      version: publication.version.version,
    };
  }

  async asset(actor: SiteAccessActor, rawHandle: string, rawVersion: number, rawPath: string) {
    const handle = siteHandleSchema.parse(rawHandle);
    const versionNumber = z.number().int().positive().parse(rawVersion);
    const assetPath = normalizeSiteAssetPath(rawPath);
    const publication = await this.store.getAccessiblePublicationByHandle(actor, handle, versionNumber);
    if (!publication?.version) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    const bundle = await this.bundleFor(publication.version);
    const bytes = bundle.files.get(assetPath);
    const manifest = bundle.manifest.files.find((file) => file.path === assetPath);
    if (!bytes || !manifest) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return { bytes, mediaType: manifest.mediaType, etag: `"sha256-${manifest.sha256}"`, site: publication.site, version: publication.version };
  }

  async manage(actor: SiteAccessActor, rawSiteId: string) {
    const siteId = z.uuid().parse(rawSiteId);
    const site = await this.store.getManageableSite(actor, siteId);
    if (!site) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    const [versions, grants, invitations] = await Promise.all([
      this.store.listSiteVersions(actor, siteId),
      this.store.listSiteGrants(actor, siteId),
      this.store.listSiteInvitations(actor, siteId, new Date()),
    ]);
    return {
      site: await this.siteView(site, actor),
      ownerAccountUserId: site.creatorAccountUserId,
      versions: (versions ?? []).map((version) => this.versionView(version)),
      grants: (grants ?? []).map((grant) => ({
        id: grant.id,
        accountUserId: grant.granteeAccountUserId,
        permission: grant.permission,
        active: !grant.revokedAt,
        createdAt: grant.createdAt.toISOString(),
      })),
      invitations: (invitations ?? []).map(invitationView),
    };
  }

  async visibility(actor: SiteAccessActor, rawSiteId: string, raw: unknown) {
    const input = z.strictObject({ visibility: z.enum(["private", "organization", "restricted"]) }).parse(raw);
    const site = await this.store.updateSiteVisibility(actor, z.uuid().parse(rawSiteId), input.visibility);
    if (!site) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return this.siteView(site, actor);
  }

  async grant(actor: SiteAccessActor, rawSiteId: string, raw: unknown) {
    const input = z.strictObject({ accountUserId: z.uuid(), permission: z.enum(["viewer", "admin"]).default("viewer") }).parse(raw);
    const grant = await this.store.grantSiteAccess(actor, z.uuid().parse(rawSiteId), input.accountUserId, input.permission);
    if (!grant) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return { id: grant.id, accountUserId: grant.granteeAccountUserId, permission: grant.permission, active: true };
  }

  async revokeGrant(actor: SiteAccessActor, rawSiteId: string, rawGrantId: string) {
    if (!await this.store.revokeSiteAccess(actor, z.uuid().parse(rawSiteId), z.uuid().parse(rawGrantId))) {
      throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    }
  }

  async invite(actor: SiteAccessActor, rawSiteId: string, raw: unknown) {
    const input = z.strictObject({
      email: z.email().max(320).transform((value) => value.toLowerCase()),
      idempotencyKey: z.string().min(16).max(128),
    }).parse(raw);
    const token = `lsi_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const result = await this.store.createSiteInvitation(actor, {
      siteId: z.uuid().parse(rawSiteId),
      email: input.email,
      tokenHash: digest(Buffer.from(token)),
      idempotencyKeyHash: digest(Buffer.from(input.idempotencyKey)),
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
      now,
    });
    if (!result) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return { invitation: invitationView(result.invitation), token: result.replayed ? null : token, replayed: result.replayed };
  }

  async resendInvitation(actor: SiteAccessActor, rawSiteId: string, rawInvitationId: string) {
    const token = `lsi_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const invitation = await this.store.resendSiteInvitation(actor, {
      siteId: z.uuid().parse(rawSiteId), invitationId: z.uuid().parse(rawInvitationId),
      tokenHash: digest(Buffer.from(token)), expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000), now,
    });
    if (!invitation) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return { invitation: invitationView(invitation), token };
  }

  async revokeInvitation(actor: SiteAccessActor, rawSiteId: string, rawInvitationId: string) {
    const invitation = await this.store.revokeSiteInvitation(actor, z.uuid().parse(rawSiteId), z.uuid().parse(rawInvitationId), new Date());
    if (!invitation) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return { invitation: invitationView(invitation) };
  }

  async acceptInvitation(rawToken: string, account: { accountUserId: string; email: string }) {
    const token = z.string().regex(/^lsi_[A-Za-z0-9_-]{32,256}$/).parse(rawToken);
    const accepted = await this.store.acceptSiteInvitation({
      tokenHash: digest(Buffer.from(token)), accountUserId: z.uuid().parse(account.accountUserId),
      email: z.email().parse(account.email).toLowerCase(), now: new Date(),
    });
    if (!accepted) throw new LemmaComputerError("SITE_INVITATION_INVALID", "This site invitation is invalid or no longer active", 403);
    return { siteId: accepted.siteId, handle: accepted.handle, stablePath: `/s/${accepted.handle}` };
  }

  async restore(actor: SiteAccessActor, rawSiteId: string, rawVersion: number) {
    const site = await this.store.restoreSiteVersion(actor, z.uuid().parse(rawSiteId), z.number().int().positive().parse(rawVersion));
    if (!site) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    return this.siteView(site, actor);
  }

  async delete(actor: SiteAccessActor, rawSiteId: string) {
    const result = await this.store.deleteSite(actor, z.uuid().parse(rawSiteId));
    if (!result.deleted) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    await Promise.allSettled([
      ...result.storageLocators.map((locator) => this.artifacts.delete(locator)),
      ...result.stagingLocators.map((locator) => this.artifacts.deleteStaging(locator)),
    ]);
    return { deleted: true };
  }
}
