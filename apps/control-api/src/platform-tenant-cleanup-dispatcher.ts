import { LemmaComputerError } from "@lemmacomputer/contracts";
import type { GatewayClient } from "@lemmacomputer/litellm-adapter";
import type {
  ClaimedPlatformTenantCleanupJob,
  PlatformTenantCleanupJob,
  PostgresPlatformOperatorStore,
} from "@lemmacomputer/workspace-store";
import type { ControllerClient } from "./service.js";

export type PlatformTenantCleanupStore = Pick<PostgresPlatformOperatorStore,
  | "claimTenantCleanupJobs"
  | "renewTenantCleanupLease"
  | "recordTenantCleanupProgress"
  | "completeTenantCleanupJob"
  | "failTenantCleanupJob"
  | "listTenantCleanupJobs"
>;

export interface PlatformTenantCleanupAdapter {
  destroyWorkspace(workspaceId: string, providerId: string | null): Promise<void>;
  revokeGateway(workspaceId: string, accessGeneration: number): Promise<void>;
  purgeWorkspace(workspaceId: string, accessGeneration: number): Promise<void>;
}

export type PlatformTenantCleanupDispatcherStatus = {
  state: "stopped" | "healthy" | "degraded";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  escalatedJobs: number;
};

export class ControlPlaneTenantCleanupAdapter implements PlatformTenantCleanupAdapter {
  constructor(private readonly controller: ControllerClient, private readonly gateway?: GatewayClient) {}

  async destroyWorkspace(workspaceId: string, providerId: string | null) {
    if (!providerId) return;
    try {
      await this.controller.destroyWorkspace(workspaceId, providerId);
    } catch (error) {
      if (error instanceof LemmaComputerError && error.statusCode === 404) return;
      throw error;
    }
  }

  async revokeGateway(workspaceId: string, accessGeneration: number) {
    if (!this.gateway) return;
    await this.gateway.revokeWorkspace(workspaceId, accessGeneration);
  }

  async purgeWorkspace(workspaceId: string, accessGeneration: number) {
    await this.controller.purgeWorkspace(workspaceId, accessGeneration);
  }
}

export class PlatformTenantCleanupDispatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = true;
  private currentStatus: PlatformTenantCleanupDispatcherStatus = {
    state: "stopped",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    escalatedJobs: 0,
  };

  constructor(
    private readonly store: PlatformTenantCleanupStore,
    private readonly adapter: PlatformTenantCleanupAdapter,
    private readonly config: {
      pollIntervalMs?: number;
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
    const jobs = await this.store.claimTenantCleanupJobs({ limit: this.config.batchSize ?? 10, now });
    for (const job of jobs) await this.deliver(job, now);
    const escalated = await this.store.listTenantCleanupJobs({ status: "escalated" });
    this.currentStatus = {
      ...this.currentStatus,
      state: escalated.length || this.currentStatus.lastError ? "degraded" : "healthy",
      escalatedJobs: escalated.length,
    };
  }

  private async deliver(job: ClaimedPlatformTenantCleanupJob, attemptedAt: Date) {
    this.currentStatus = { ...this.currentStatus, lastAttemptAt: attemptedAt.toISOString() };
    try {
      let current: PlatformTenantCleanupJob = job;
      if (!current.controllerDestroyedAt) {
        current = await this.store.renewTenantCleanupLease(job.id, job.leaseToken, job.accessGeneration, this.now());
        await this.adapter.destroyWorkspace(job.workspaceId, job.providerId);
        current = await this.store.recordTenantCleanupProgress(job.id, job.leaseToken, "controller", this.now());
      }
      if (!current.gatewayRevokedAt) {
        current = await this.store.renewTenantCleanupLease(job.id, job.leaseToken, job.accessGeneration, this.now());
        await this.adapter.revokeGateway(job.workspaceId, job.accessGeneration);
        current = await this.store.recordTenantCleanupProgress(job.id, job.leaseToken, "gateway", this.now());
      }
      if (current.action === "close" && !current.storagePurgedAt) {
        current = await this.store.renewTenantCleanupLease(job.id, job.leaseToken, job.accessGeneration, this.now());
        await this.adapter.purgeWorkspace(job.workspaceId, job.accessGeneration);
        await this.store.recordTenantCleanupProgress(job.id, job.leaseToken, "storage", this.now());
      }
      await this.store.completeTenantCleanupJob(job.id, job.leaseToken, this.now());
      this.currentStatus = { ...this.currentStatus, state: "healthy", lastSuccessAt: this.now().toISOString(), lastError: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof LemmaComputerError && error.code === "PLATFORM_TENANT_CLEANUP_LEASE_LOST") {
        this.currentStatus = { ...this.currentStatus, state: "degraded", lastError: message };
        return;
      }
      const delay = Math.min(
        this.config.maxRetryMs ?? 5 * 60_000,
        (this.config.baseRetryMs ?? 5_000) * 2 ** Math.max(0, job.attemptCount - 1),
      );
      await this.store.failTenantCleanupJob(job.id, job.leaseToken, {
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
        this.currentStatus = { ...this.currentStatus, state: "degraded", lastError: error instanceof Error ? error.message : String(error) };
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
