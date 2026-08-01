import { createHmac, timingSafeEqual } from "node:crypto";
import { OneComputerError, type IdentityContext } from "@onecomputer/contracts";
import { z } from "zod";

const captureGrantSchema = z.strictObject({
  version: z.literal(1),
  tenantId: z.string().min(1).max(128),
  subjectId: z.string().min(1).max(128),
  workspaceId: z.uuid(),
  taskId: z.uuid(),
  sourceApplication: z.enum(["browser", "document", "desktop"]),
  expiresAt: z.iso.datetime(),
  maximumBytes: z.number().int().min(1).max(2 * 1024 * 1024),
});

export type OneVibeCaptureGrant = z.infer<typeof captureGrantSchema>;

export class OneVibeCaptureAuthority {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error("ONEVibe capture secret must be at least 32 characters");
  }

  issue(identity: IdentityContext, input: Omit<OneVibeCaptureGrant, "version" | "tenantId" | "subjectId" | "expiresAt">, now = new Date()) {
    const grant = captureGrantSchema.parse({
      version: 1, tenantId: identity.tenantId, subjectId: identity.subjectId, ...input,
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    });
    const encoded = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return `ocvcr_${encoded}.${this.sign(encoded)}`;
  }

  verify(token: string, now = new Date()): OneVibeCaptureGrant {
    const match = /^ocvcr_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) throw new OneComputerError("UNAUTHENTICATED", "ONEVibe capture authentication is required", 401);
    const expected = Buffer.from(this.sign(match[1]!));
    const received = Buffer.from(match[2]!);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new OneComputerError("UNAUTHENTICATED", "ONEVibe capture authentication is invalid", 401);
    }
    let grant: OneVibeCaptureGrant;
    try { grant = captureGrantSchema.parse(JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"))); }
    catch { throw new OneComputerError("UNAUTHENTICATED", "ONEVibe capture authentication is invalid", 401); }
    if (new Date(grant.expiresAt) <= now) throw new OneComputerError("ONEVIBE_CAPTURE_EXPIRED", "ONEVibe capture authorization has expired", 401);
    return grant;
  }

  private sign(payload: string) {
    return createHmac("sha256", this.secret).update(`onecomputer:onevibe-vcr:${payload}`).digest("base64url");
  }
}
