import Fastify from "fastify";
import { LemmaComputerError, executeScheduleRunSchema } from "@lemmacomputer/contracts";
import { PostgresScheduleStore, type ScheduleStore } from "@lemmacomputer/workspace-store";
import { z } from "zod";

const envSchema = z.object({
  SCHEDULER_HOST: z.string().default("127.0.0.1"),
  SCHEDULER_PORT: z.coerce.number().int().positive().default(4103),
  SCHEDULER_INTERNAL_TOKEN: z.string().min(32),
  CONTROL_URL: z.string().url().default("http://127.0.0.1:4100"),
  DATABASE_URL: z.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
  CLAIM_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  CLAIM_LEASE_MS: z.coerce.number().int().min(30_000).max(15 * 60_000).default(120_000),
});

export interface ScheduleControlClient {
  execute(runId: string, leaseToken: string): Promise<void>;
}

export class HttpScheduleControlClient implements ScheduleControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async execute(runId: string, leaseToken: string) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/internal/v1/schedules/runs/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lemmacomputer-scheduler-token": this.internalToken,
        },
        body: JSON.stringify(executeScheduleRunSchema.parse({ runId, leaseToken })),
        signal: AbortSignal.timeout(15 * 60_000),
      });
    } catch {
      throw new LemmaComputerError("SCHEDULE_CONTROL_UNAVAILABLE", "LemmaComputer Control is unavailable", 503, true);
    }
    if (!response.ok) {
      throw new LemmaComputerError(
        "SCHEDULE_EXECUTION_REJECTED",
        "LemmaComputer rejected the scheduled run",
        response.status,
        response.status >= 500,
      );
    }
  }
}

export class SchedulerWorker {
  constructor(
    private readonly store: ScheduleStore,
    private readonly control: ScheduleControlClient,
    private readonly claimLimit = 10,
    private readonly claimLeaseMs = 120_000,
  ) {}

  async pollOnce(now = new Date()) {
    const claimed = await this.store.claimDueScheduleRuns(now, this.claimLimit, this.claimLeaseMs);
    const outcomes = await Promise.allSettled(claimed.map(({ run }) => {
      if (!run.leaseToken) throw new Error("Claimed schedule run has no lease token");
      return this.control.execute(run.id, run.leaseToken);
    }));
    return {
      claimed: claimed.length,
      completed: outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      failed: outcomes.filter((outcome) => outcome.status === "rejected").length,
    };
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const env = envSchema.parse(process.env);
  const store = PostgresScheduleStore.fromConnectionString(env.DATABASE_URL);
  const worker = new SchedulerWorker(
    store,
    new HttpScheduleControlClient(env.CONTROL_URL, env.SCHEDULER_INTERNAL_TOKEN),
    env.CLAIM_LIMIT,
    env.CLAIM_LEASE_MS,
  );
  const app = Fastify({ logger: true });
  app.get("/healthz", async () => ({ status: "ok" }));
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const result = await worker.pollOnce();
      if (result.claimed) app.log.info({ event: "schedule_poll", ...result }, "scheduled runs processed");
    } catch (error) {
      app.log.error({
        err: {
          name: error instanceof Error ? error.name : "UnknownError",
          code: error instanceof LemmaComputerError ? error.code : "SCHEDULE_POLL_FAILED",
        },
      }, "schedule polling failed");
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(poll, env.POLL_INTERVAL_MS);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await store.close();
  });
  await app.listen({ host: env.SCHEDULER_HOST, port: env.SCHEDULER_PORT });
  await poll();
}
