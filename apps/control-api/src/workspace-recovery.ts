import type { IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import type { WorkspaceRecord, WorkspaceStore } from "@lemmacomputer/workspace-store";
import type { WorkspaceService } from "./service.js";

/** A bounded, tenant-reauthorized scan. Operation claims serialize multiple Control replicas. */
export class WorkspaceRecoveryWorker {
  private running = false;
  private cursor: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly service: Pick<WorkspaceService, "recover">,
    private readonly authorize: (workspace: WorkspaceRecord) => Promise<{ identity: IdentityContext; policy: RuntimePolicy } | null>,
    private readonly report: (result: { checked: number; denied: number; failed: number }) => void,
  ) {}

  async runOnce() {
    if (this.running || this.stopped) return;
    this.running = true;
    const result = { checked: 0, denied: 0, failed: 0 };
    try {
      const candidates = await this.store.listRecoveryCandidates(this.cursor, 20);
      for (const workspace of candidates) {
        if (this.stopped) break;
        this.cursor = workspace.id;
        result.checked++;
        try {
          const authorized = await this.authorize(workspace);
          if (!authorized || authorized.identity.tenantId !== workspace.tenantId
            || authorized.identity.subjectId !== workspace.subjectId) {
            result.denied++;
            continue;
          }
          await this.service.recover(workspace, authorized.identity, authorized.policy);
        } catch {
          // Dependency/policy failures never mint credentials using cached authorization.
          result.failed++;
        }
      }
      if (candidates.length < 20) this.cursor = undefined;
    } catch {
      result.failed++;
    } finally {
      this.running = false;
      this.report(result);
    }
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    // Start only once Control is listening: new runtimes must be able to reach it.
    void this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, 15_000);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
