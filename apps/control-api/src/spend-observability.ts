import { createHash } from "node:crypto";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import type { SpendRange, SpendReport } from "@lemmacomputer/workspace-store";
import { z } from "zod";

const dateTime = z.string().datetime({ offset: true });
const boundedId = z.string().trim().min(1).max(512);
const querySchema = z.strictObject({
  from: dateTime.optional(),
  to: dateTime.optional(),
  asOf: dateTime.optional(),
  teamId: z.string().uuid().optional(),
  userId: boundedId.optional(),
  workspaceId: boundedId.optional(),
  agentId: boundedId.optional(),
  sessionId: boundedId.optional(),
  taskId: boundedId.optional(),
  turnId: boundedId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/).optional(),
  format: z.enum(["csv", "json"]).optional(),
});

export const parseUnpricedUsageAcknowledgement = (input: unknown, now = new Date()) => {
  const parsed = z.strictObject({ receivedBefore: dateTime }).parse(input ?? {});
  const receivedBefore = new Date(parsed.receivedBefore);
  if (receivedBefore.getTime() > now.getTime() + 60_000) {
    throw new LemmaComputerError("COST_COVERAGE_BASELINE_INVALID", "The acknowledgement cutoff cannot be in the future", 400);
  }
  return { receivedBefore };
};

type CursorSnapshot = {
  from: string; to: string; asOf: string;
  teamId?: string; userId?: string; workspaceId?: string; agentId?: string;
  sessionId?: string; taskId?: string; turnId?: string;
};
type ParsedSpendQuery = {
  range: SpendRange;
  limit: number;
  offset: number;
  format?: "csv" | "json";
  signature: string;
  snapshot: CursorSnapshot;
};

const stable = (value: Record<string, unknown>) => JSON.stringify(
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))),
);
const signatureFor = (snapshot: CursorSnapshot) => createHash("sha256").update(stable(snapshot)).digest("hex");
const invalidCursor = () => new LemmaComputerError("SPEND_CURSOR_INVALID", "The spend cursor is invalid for this view", 400);
const decodeCursor = (cursor: string) => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) || value.length !== 4 || value[0] !== 1
      || !Number.isSafeInteger(value[1]) || value[1] < 0
      || typeof value[2] !== "string" || !value[3] || typeof value[3] !== "object" || Array.isArray(value[3])
    ) throw invalidCursor();
    const snapshot = value[3] as CursorSnapshot;
    const parsed = querySchema.pick({
      from: true, to: true, asOf: true, teamId: true, userId: true, workspaceId: true,
      agentId: true, sessionId: true, taskId: true, turnId: true,
    }).safeParse(snapshot);
    if (!parsed.success || !snapshot.from || !snapshot.to || !snapshot.asOf || value[2] !== signatureFor(snapshot)) throw invalidCursor();
    return { offset: value[1] as number, signature: value[2] as string, snapshot };
  } catch (error) {
    if (error instanceof LemmaComputerError) throw error;
    throw invalidCursor();
  }
};

export const parseSpendQuery = (input: unknown, now = new Date()): ParsedSpendQuery => {
  const parsed = querySchema.parse(input ?? {});
  const cursor = parsed.cursor ? decodeCursor(parsed.cursor) : null;
  const snapshot: CursorSnapshot = cursor?.snapshot ?? (() => {
    const asOf = parsed.asOf ? new Date(parsed.asOf) : now;
    const to = parsed.to ? new Date(parsed.to) : asOf;
    const from = parsed.from ? new Date(parsed.from) : new Date(to.getTime() - 30 * 86_400_000);
    return {
      from: from.toISOString(), to: to.toISOString(), asOf: asOf.toISOString(),
      ...(parsed.teamId ? { teamId: parsed.teamId } : {}),
      ...(parsed.userId ? { userId: parsed.userId } : {}),
      ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
      ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      ...(parsed.turnId ? { turnId: parsed.turnId } : {}),
    };
  })();
  const from = new Date(snapshot.from);
  const to = new Date(snapshot.to);
  const asOf = new Date(snapshot.asOf);
  const duration = to.getTime() - from.getTime();
  if (duration <= 0 || duration > 366 * 86_400_000 || asOf.getTime() < from.getTime()) {
    throw new LemmaComputerError("SPEND_RANGE_INVALID", "Choose a date range of up to 366 days", 400);
  }
  const range: SpendRange = {
    from,
    to,
    receivedBefore: asOf,
    ...(snapshot.teamId ? { teamId: snapshot.teamId } : {}),
    ...(snapshot.userId ? { userId: snapshot.userId } : {}),
    ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
    ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
    ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    ...(snapshot.taskId ? { taskId: snapshot.taskId } : {}),
    ...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
  };
  return {
    range, limit: parsed.limit, offset: cursor?.offset ?? 0, format: parsed.format,
    signature: cursor?.signature ?? signatureFor(snapshot), snapshot,
  };
};

const cursorFor = (offset: number, query: Pick<ParsedSpendQuery, "signature" | "snapshot">) => (
  Buffer.from(JSON.stringify([1, offset, query.signature, query.snapshot])).toString("base64url")
);

export const paginateSpendReport = (report: SpendReport, query: Pick<ParsedSpendQuery, "offset" | "limit" | "signature" | "snapshot">) => {
  if (query.offset > report.tasks.length) throw invalidCursor();
  const tasks = report.tasks.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + tasks.length;
  return {
    report: { ...report, tasks },
    page: {
      limit: query.limit,
      returnedTasks: tasks.length,
      totalTasks: report.tasks.length,
      nextCursor: nextOffset < report.tasks.length ? cursorFor(nextOffset, query) : null,
    },
  };
};
