import { createHmac } from "node:crypto";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import type {
  ClaimedPlatformSecurityAlert,
  PlatformSecurityAlert,
  PostgresPlatformOperatorStore,
} from "@lemmacomputer/workspace-store";

export type PlatformSecurityAlertDeliveryStore = Pick<PostgresPlatformOperatorStore,
  | "claimSecurityAlerts"
  | "completeSecurityAlert"
  | "failSecurityAlert"
  | "listSecurityAlerts"
>;

export interface PlatformSecurityAlertDeliveryAdapter {
  deliver(alert: PlatformSecurityAlert, signal: AbortSignal): Promise<void>;
}

export type PlatformSecurityAlertDispatcherStatus = {
  state: "stopped" | "healthy" | "degraded";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  escalatedAlerts: number;
};

export class PlatformSecurityAlertDispatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = true;
  private currentStatus: PlatformSecurityAlertDispatcherStatus = {
    state: "stopped",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    escalatedAlerts: 0,
  };

  constructor(
    private readonly store: PlatformSecurityAlertDeliveryStore,
    private readonly adapter: PlatformSecurityAlertDeliveryAdapter,
    private readonly config: {
      pollIntervalMs?: number;
      deliveryTimeoutMs?: number;
      batchSize?: number;
      baseRetryMs?: number;
      maxRetryMs?: number;
      now?: () => Date;
    } = {},
  ) {}

  status() { return { ...this.currentStatus }; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.currentStatus = { ...this.currentStatus, state: "healthy" };
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    this.currentStatus = { ...this.currentStatus, state: "stopped" };
  }

  async flush(now = this.now()) {
    const claimed = await this.store.claimSecurityAlerts({ limit: this.config.batchSize ?? 10, now });
    for (const alert of claimed) await this.deliverOne(alert, now);
    const escalated = await this.store.listSecurityAlerts({ status: "escalated" });
    this.currentStatus = {
      ...this.currentStatus,
      state: escalated.length || this.currentStatus.lastError ? "degraded" : "healthy",
      escalatedAlerts: escalated.length,
    };
  }

  private async deliverOne(alert: ClaimedPlatformSecurityAlert, attemptedAt: Date) {
    this.currentStatus = { ...this.currentStatus, lastAttemptAt: attemptedAt.toISOString() };
    try {
      await this.adapter.deliver(alert, AbortSignal.timeout(this.config.deliveryTimeoutMs ?? 15_000));
      await this.store.completeSecurityAlert(alert.id, alert.leaseToken, this.now());
      this.currentStatus = {
        ...this.currentStatus,
        state: "healthy",
        lastSuccessAt: this.now().toISOString(),
        lastError: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof LemmaComputerError && error.code === "PLATFORM_SECURITY_ALERT_LEASE_LOST") {
        this.currentStatus = { ...this.currentStatus, state: "degraded", lastError: message };
        return;
      }
      const delay = Math.min(
        this.config.maxRetryMs ?? 5 * 60_000,
        (this.config.baseRetryMs ?? 5_000) * 2 ** Math.max(0, alert.attemptCount - 1),
      );
      await this.store.failSecurityAlert(alert.id, alert.leaseToken, {
        error: message,
        failedAt: this.now(),
        retryAt: new Date(this.now().getTime() + delay),
      });
      this.currentStatus = { ...this.currentStatus, state: "degraded", lastError: message };
    }
  }

  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      const run = this.flush().catch((error) => {
        this.currentStatus = {
          ...this.currentStatus,
          state: "degraded",
          lastError: error instanceof Error ? error.message : String(error),
        };
      });
      this.inFlight = run;
      void run.finally(() => {
        if (this.inFlight === run) this.inFlight = undefined;
        if (!this.stopped) this.schedule(this.config.pollIntervalMs ?? 5_000);
      });
    }, delay);
    this.timer.unref?.();
  }

  private now() { return this.config.now?.() ?? new Date(); }
}

export class SignedWebhookPlatformSecurityAlertAdapter implements PlatformSecurityAlertDeliveryAdapter {
  constructor(
    private readonly destination: string,
    private readonly secret: string,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {
    const url = new URL(destination);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("Platform security alert webhook must be an HTTPS URL without embedded credentials or fragments");
    }
    if (secret.length < 32) throw new Error("Platform security alert webhook secret must be at least 32 characters");
  }

  async deliver(alert: PlatformSecurityAlert, signal: AbortSignal) {
    const body = JSON.stringify({
      schemaVersion: 1,
      event: "platform.break-glass",
      alertId: alert.id,
      correlationId: alert.correlationId,
      payload: alert.payload,
      createdAt: alert.createdAt,
    });
    const signature = createHmac("sha256", this.secret).update(body).digest("hex");
    const response = await this.request(this.destination, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-lemmacomputer-alert-signature": `sha256=${signature}`,
      },
      body,
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Security alert destination returned HTTP ${response.status}`);
    }
  }
}
