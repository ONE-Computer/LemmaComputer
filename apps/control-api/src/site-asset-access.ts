import { createHmac, timingSafeEqual } from "node:crypto";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import { z } from "zod";

// This is a delegated bundle read, never a Lemma login credential. The live
// authentication session and resource ACL must still be checked on every GET.
const claimsSchema = z.strictObject({
  audience: z.literal("lemma-site-assets-v1"),
  tenantId: z.string().min(1).max(128),
  handle: z.string().regex(/^[A-Za-z0-9_-]{24}$/),
  version: z.number().int().positive(),
  accountUserId: z.uuid(),
  authenticationSessionId: z.uuid(),
  expiresAt: z.number().int().positive(),
});
type Claims = z.infer<typeof claimsSchema>;
export const siteAssetAccessLifetimeMs = 15 * 60 * 1000;
export const siteAssetAccessPath = /^\/v1\/sites\/viewer\/([A-Za-z0-9_-]{24})\/versions\/(\d+)\/access\/([A-Za-z0-9_.-]+)\/assets\/(.+)$/;
export const redactSiteAssetAccessUrl = (url: string) => url.replace(/(\/access\/)[^/?#]+/g, "$1[redacted]");

export class SiteAssetAccessAuthority {
  constructor(private readonly secret: string, private readonly now = Date.now) {
    if (secret.length < 24) throw new Error("Site asset signing secret is required");
  }
  private signature(body: string) {
    return createHmac("sha256", this.secret).update(`lemma-site-assets-v1\0${body}`).digest();
  }
  issue(input: Omit<Claims, "audience" | "expiresAt">) {
    const claims = claimsSchema.parse({ ...input, audience: "lemma-site-assets-v1", expiresAt: this.now() + siteAssetAccessLifetimeMs });
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const token = `${body}.${this.signature(body).toString("base64url")}`;
    return { expiresAt: claims.expiresAt, entryUrl: `/api/v1/sites/viewer/${claims.handle}/versions/${claims.version}/access/${token}/assets/index.html` };
  }
  verify(token: string, handle: string, version: number): Claims {
    try {
      if (token.length > 2048) throw new Error();
      const parts = token.split(".");
      if (parts.length !== 2) throw new Error();
      const [body, signature] = parts as [string, string];
      const expected = this.signature(body);
      const supplied = Buffer.from(signature, "base64url");
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error();
      const claims = claimsSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
      if (claims.handle !== handle || claims.version !== version || claims.expiresAt <= this.now()
        || claims.expiresAt > this.now() + siteAssetAccessLifetimeMs) throw new Error();
      return claims;
    } catch {
      throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    }
  }
}

export const siteAssetHeaders = (resourceBase: string) => ({
  "cache-control": "private, no-store",
  "content-security-policy": `sandbox allow-scripts; default-src 'none'; script-src ${resourceBase}; style-src ${resourceBase} 'unsafe-inline'; img-src ${resourceBase} data:; font-src ${resourceBase}; media-src ${resourceBase}; connect-src ${resourceBase}; form-action 'none'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; navigate-to 'none'`,
  "cross-origin-resource-policy": "cross-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // The sandbox is opaque. Access is the version-scoped grant, not cookies.
  "access-control-allow-origin": "null",
});
