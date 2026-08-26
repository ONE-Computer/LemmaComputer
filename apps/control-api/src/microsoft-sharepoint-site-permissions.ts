type SharePointSiteTarget = {
  hostname: string;
  sitePath: string;
};

export type MicrosoftSharePointSiteGrant = {
  graphSiteId: string;
  permissionId: string;
};

export interface MicrosoftSharePointSitePermissionGateway {
  grantRead(input: SharePointSiteTarget & { providerTenantId?: string | null; connectorClientId: string }): Promise<MicrosoftSharePointSiteGrant>;
  revoke(input: SharePointSiteTarget & {
    providerTenantId?: string | null;
    connectorClientId: string;
    graphSiteId?: string | null;
    permissionId?: string | null;
  }): Promise<{ revoked: boolean }>;
}

type MicrosoftSharePointSitePermissionOptions = {
  fallbackProviderTenantId: string;
  administrationClientId: string;
  administrationClientSecret: string;
  connectorDisplayName?: string;
  fetch?: typeof globalThis.fetch;
};

type MicrosoftCloud = {
  loginOrigin: string;
  graphOrigin: string;
};

const microsoftCloudFor = (hostname: string): MicrosoftCloud => {
  if (hostname.endsWith(".sharepoint.us")) {
    return { loginOrigin: "https://login.microsoftonline.us", graphOrigin: "https://graph.microsoft.us" };
  }
  if (hostname.endsWith(".sharepoint.cn")) {
    return { loginOrigin: "https://login.chinacloudapi.cn", graphOrigin: "https://microsoftgraph.chinacloudapi.cn" };
  }
  if (hostname.endsWith(".sharepoint.de")) {
    return { loginOrigin: "https://login.microsoftonline.de", graphOrigin: "https://graph.microsoft.de" };
  }
  return { loginOrigin: "https://login.microsoftonline.com", graphOrigin: "https://graph.microsoft.com" };
};

const directoryId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const applicationId = directoryId;

const encodedSitePath = (sitePath: string) => sitePath
  .replace(/^\/+|\/+$/g, "")
  .split("/")
  .map((segment) => encodeURIComponent(segment))
  .join("/");

const objectValue = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const identities = (permission: Record<string, unknown>) => {
  const candidates = [
    permission.grantedToIdentitiesV2,
    permission.grantedToIdentities,
    permission.grantedToV2 ? [permission.grantedToV2] : [],
    permission.grantedTo ? [permission.grantedTo] : [],
  ];
  return candidates.flatMap((candidate) => Array.isArray(candidate) ? candidate : []);
};

const permissionTargetsApplication = (permission: Record<string, unknown>, clientId: string) => identities(permission).some((identity) => {
  const application = objectValue(objectValue(identity).application);
  return typeof application.id === "string" && application.id.toLowerCase() === clientId.toLowerCase();
});

const rolesAreReadOnly = (permission: Record<string, unknown>) => (
  Array.isArray(permission.roles)
  && permission.roles.length === 1
  && permission.roles[0] === "read"
);

const providerMessage = (payload: unknown, fallback: string) => {
  const error = objectValue(objectValue(payload).error);
  const message = typeof error.message === "string" ? error.message.trim() : "";
  return (message || fallback).slice(0, 260);
};

export class MicrosoftSharePointSitePermissionClient implements MicrosoftSharePointSitePermissionGateway {
  private readonly fetch: typeof globalThis.fetch;
  private readonly connectorDisplayName: string;

  constructor(private readonly options: MicrosoftSharePointSitePermissionOptions) {
    if (!directoryId(options.fallbackProviderTenantId)) throw new Error("Microsoft 365 site administration tenant ID must be a directory GUID");
    if (!applicationId(options.administrationClientId)) throw new Error("Microsoft 365 site administration client ID must be an application GUID");
    if (!options.administrationClientSecret) throw new Error("Microsoft 365 site administration client secret is required");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.connectorDisplayName = options.connectorDisplayName ?? "LemmaComputer Workplace Connector";
  }

  async grantRead(input: SharePointSiteTarget & { providerTenantId?: string | null; connectorClientId: string }) {
    if (!applicationId(input.connectorClientId)) throw new Error("Microsoft 365 connector client ID must be an application GUID");
    const context = await this.context(input);
    const graphSite = await this.resolveSite(context, input);
    const existing = await this.applicationPermission(context, graphSite.id, input.connectorClientId);
    if (existing) {
      if (!rolesAreReadOnly(existing)) {
        const updated = await this.graphJson(context, `/v1.0/sites/${encodeURIComponent(graphSite.id)}/permissions/${encodeURIComponent(String(existing.id))}`, {
          method: "PATCH",
          body: JSON.stringify({ roles: ["read"] }),
        }, "Microsoft could not reduce the existing SharePoint grant to read-only access");
        const permissionId = typeof objectValue(updated).id === "string" ? String(objectValue(updated).id) : String(existing.id);
        return { graphSiteId: graphSite.id, permissionId };
      }
      return { graphSiteId: graphSite.id, permissionId: String(existing.id) };
    }
    const created = objectValue(await this.graphJson(context, `/v1.0/sites/${encodeURIComponent(graphSite.id)}/permissions`, {
      method: "POST",
      body: JSON.stringify({
        roles: ["read"],
        grantedToIdentities: [{
          application: {
            id: input.connectorClientId,
            displayName: this.connectorDisplayName,
          },
        }],
      }),
    }, "Microsoft could not grant this application access to the SharePoint site"));
    if (typeof created.id !== "string" || !created.id) throw new Error("Microsoft returned a SharePoint grant without a permission identifier");
    return { graphSiteId: graphSite.id, permissionId: created.id };
  }

  async revoke(input: SharePointSiteTarget & {
    providerTenantId?: string | null;
    connectorClientId: string;
    graphSiteId?: string | null;
    permissionId?: string | null;
  }) {
    if (!applicationId(input.connectorClientId)) throw new Error("Microsoft 365 connector client ID must be an application GUID");
    const context = await this.context(input);
    const resolvedSite = await this.resolveSite(context, input);
    if (input.graphSiteId && input.graphSiteId !== resolvedSite.id) {
      throw new Error("Microsoft resolved a different SharePoint site than the stored grant");
    }
    const graphSiteId = resolvedSite.id;
    // Re-resolve the permission by connector application identity before
    // deleting it. A stale or damaged local permission id must never delete a
    // different application's site grant.
    const permission = await this.applicationPermission(context, graphSiteId, input.connectorClientId);
    if (!permission?.id) return { revoked: false };
    const response = await this.fetch(`${context.cloud.graphOrigin}/v1.0/sites/${encodeURIComponent(graphSiteId)}/permissions/${encodeURIComponent(String(permission.id))}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${context.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return { revoked: false };
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(providerMessage(payload, `Microsoft could not revoke the SharePoint grant (${response.status})`));
    }
    return { revoked: true };
  }

  private async context(input: SharePointSiteTarget & { providerTenantId?: string | null }) {
    const providerTenantId = input.providerTenantId || this.options.fallbackProviderTenantId;
    if (!directoryId(providerTenantId)) throw new Error("This organization is not bound to a Microsoft Entra directory");
    const cloud = microsoftCloudFor(input.hostname);
    const body = new URLSearchParams({
      client_id: this.options.administrationClientId,
      client_secret: this.options.administrationClientSecret,
      grant_type: "client_credentials",
      scope: `${cloud.graphOrigin}/.default`,
    });
    const response = await this.fetch(`${cloud.loginOrigin}/${encodeURIComponent(providerTenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null);
    const accessToken = typeof objectValue(payload).access_token === "string" ? String(objectValue(payload).access_token) : "";
    if (!response.ok || !accessToken) {
      throw new Error(providerMessage(payload, `Microsoft site administration authentication failed (${response.status})`));
    }
    return { accessToken, cloud };
  }

  private async resolveSite(
    context: { accessToken: string; cloud: MicrosoftCloud },
    input: SharePointSiteTarget,
  ) {
    const payload = objectValue(await this.graphJson(
      context,
      `/v1.0/sites/${encodeURIComponent(input.hostname)}:/${encodedSitePath(input.sitePath)}?$select=id,webUrl`,
      { method: "GET" },
      "Microsoft could not find that SharePoint site",
    ));
    if (typeof payload.id !== "string" || typeof payload.webUrl !== "string") {
      throw new Error("Microsoft returned an invalid SharePoint site response");
    }
    const resolved = new URL(payload.webUrl);
    const requestedPath = `/${input.sitePath}`.replace(/\/+$/, "").toLowerCase();
    if (resolved.hostname.toLowerCase() !== input.hostname.toLowerCase() || resolved.pathname.replace(/\/+$/, "").toLowerCase() !== requestedPath) {
      throw new Error("Microsoft resolved a different SharePoint site than the one requested");
    }
    return { id: payload.id, webUrl: payload.webUrl };
  }

  private async applicationPermission(context: { accessToken: string; cloud: MicrosoftCloud }, graphSiteId: string, connectorClientId: string) {
    let path: string | null = `/v1.0/sites/${encodeURIComponent(graphSiteId)}/permissions`;
    for (let page = 0; path && page < 10; page += 1) {
      const payload = objectValue(await this.graphJson(context, path, { method: "GET" }, "Microsoft could not read the SharePoint site grants"));
      const permissions = Array.isArray(payload.value) ? payload.value.map(objectValue) : [];
      const existing = permissions.find((permission) => permission.id && permissionTargetsApplication(permission, connectorClientId));
      if (existing) return existing;
      const nextLink = typeof payload["@odata.nextLink"] === "string" ? new URL(payload["@odata.nextLink"] as string) : null;
      if (nextLink && nextLink.origin !== context.cloud.graphOrigin) throw new Error("Microsoft returned an invalid SharePoint permission continuation URL");
      path = nextLink ? `${nextLink.pathname}${nextLink.search}` : null;
    }
    return null;
  }

  private async graphJson(
    context: { accessToken: string; cloud: MicrosoftCloud },
    path: string,
    init: RequestInit,
    fallback: string,
  ) {
    const response = await this.fetch(`${context.cloud.graphOrigin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${context.accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(providerMessage(payload, `${fallback} (${response.status})`));
    return payload;
  }
}
