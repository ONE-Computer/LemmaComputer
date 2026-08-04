import {
  LemmaComputerError,
  channelBrokerCredentialOwnerSchema,
  channelBrokerOwnerSchema,
  channelBrokerSaveConnectionSchema,
  channelBrokerSaveCredentialSchema,
  saveTelegramChannelConnectionSchema,
  saveTelegramCredentialSchema,
  telegramChannelConnectionStatusSchema,
  telegramCredentialListSchema,
  telegramCredentialStatusSchema,
  type IdentityContext,
  type TelegramChannelConnectionStatus,
  type TelegramCredentialStatus,
} from "@lemmacomputer/contracts";

export interface ChannelBrokerManagementClient {
  listCredentials(identity: IdentityContext): Promise<{ credentials: TelegramCredentialStatus[] }>;
  saveCredential(identity: IdentityContext, input: unknown, credentialId?: string): Promise<TelegramCredentialStatus>;
  deleteCredential(identity: IdentityContext, credentialId: string): Promise<void>;
  status(identity: IdentityContext, workspaceId: string): Promise<TelegramChannelConnectionStatus | null>;
  save(identity: IdentityContext, input: unknown): Promise<TelegramChannelConnectionStatus>;
  disconnect(identity: IdentityContext, workspaceId: string): Promise<void>;
}

export class HttpChannelBrokerManagementClient implements ChannelBrokerManagementClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-lemmacomputer-channel-token": this.internalToken,
        },
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new LemmaComputerError("CHANNEL_BROKER_UNAVAILABLE", "Messaging connections are unavailable", 503, true);
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const publicStatus = response.status === 400 ? 400 : 503;
      throw new LemmaComputerError(
        "CHANNEL_BROKER_REJECTED",
        response.status === 400 ? "The Telegram connection is invalid" : "Messaging connections are unavailable",
        publicStatus,
        publicStatus >= 500,
      );
    }
    return payload;
  }

  async listCredentials(identity: IdentityContext) {
    return telegramCredentialListSchema.parse(await this.request("/internal/v1/credentials", {
      method: "POST",
      body: JSON.stringify(channelBrokerOwnerSchema.parse({ identity })),
    }));
  }

  async saveCredential(identity: IdentityContext, raw: unknown, credentialId?: string) {
    const input = saveTelegramCredentialSchema.parse(raw);
    return telegramCredentialStatusSchema.parse(await this.request("/internal/v1/credentials/telegram", {
      method: credentialId ? "PUT" : "POST",
      body: JSON.stringify(channelBrokerSaveCredentialSchema.parse({ identity, ...input, ...(credentialId ? { credentialId } : {}) })),
    }));
  }

  async deleteCredential(identity: IdentityContext, credentialId: string) {
    await this.request("/internal/v1/credentials/telegram", {
      method: "DELETE",
      body: JSON.stringify(channelBrokerCredentialOwnerSchema.parse({ identity, credentialId })),
    });
  }

  async status(identity: IdentityContext, workspaceId: string) {
    const payload = await this.request("/internal/v1/connections/telegram/status", {
      method: "POST",
      body: JSON.stringify(channelBrokerOwnerSchema.parse({ identity, workspaceId })),
    });
    return payload ? telegramChannelConnectionStatusSchema.parse(payload) : null;
  }

  async save(identity: IdentityContext, raw: unknown) {
    const input = saveTelegramChannelConnectionSchema.parse(raw);
    return telegramChannelConnectionStatusSchema.parse(await this.request("/internal/v1/connections/telegram", {
      method: "PUT",
      body: JSON.stringify(channelBrokerSaveConnectionSchema.parse({ identity, ...input })),
    }));
  }

  async disconnect(identity: IdentityContext, workspaceId: string) {
    await this.request("/internal/v1/connections/telegram", {
      method: "DELETE",
      body: JSON.stringify(channelBrokerOwnerSchema.parse({ identity, workspaceId })),
    });
  }
}
