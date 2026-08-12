import { randomUUID } from "node:crypto";
import {
  LemmaComputerError,
  canonicalJson,
  toolAuditAdmissionInputSchema,
  toolAuditAdmissionRecordInputSchema,
  toolAuditAdmissionSchema,
  toolAuditTerminalInputSchema,
  toolAuditTerminalRecordSchema,
  toolAuditTargetSummarySchema,
  type ToolAuditAdmission,
  type ToolAuditAdmissionInput,
  type ToolAuditAdmissionRecordInput,
  type ToolAuditTargetSummary,
  type ToolAuditTargetDescriptor,
  type ManagedToolAuditTargetType,
  type ToolAuditTerminalInput,
  type ToolAuditTerminalRecord,
} from "@lemmacomputer/contracts";

const secretAssignments = /\b(password|passwd|secret|token|api[-_ ]?key|client[-_ ]?secret|authorization)\s*[:=]\s*([^\s,;]+)/giu;
const bearerTokens = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/giu;
const structuredTokens = /\b(?:sk|pk|ghp|github_pat|xox[baprs]|pat)[-_][A-Za-z0-9_-]{12,}\b/giu;
const jsonWebTokens = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const longOpaqueTokens = /\b[A-Za-z0-9_-]{40,}\b/gu;
const pemMaterial = /-----BEGIN [^-]{1,80}-----[\s\S]*?-----END [^-]{1,80}-----/gu;

const safeTargetLabel = (value: string) => {
  let normalized = value.normalize("NFKC").replace(pemMaterial, "[redacted]");
  try {
    const url = new URL(normalized);
    normalized = `${url.protocol}//${url.host}`;
  } catch {
    // Human-facing filenames, recipients, and destinations are ordinarily not URLs.
  }
  normalized = normalized
    .replace(secretAssignments, (_match, name: string) => `${name}=[redacted]`)
    .replace(bearerTokens, "[redacted]")
    .replace(structuredTokens, "[redacted]")
    .replace(jsonWebTokens, "[redacted]")
    .replace(longOpaqueTokens, "[redacted]")
    .replace(/[\u0000-\u001f\u007f<>]/gu, " ")
    .replace(/javascript\s*:/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized === "[redacted]") return null;
  return normalized.length <= 150 ? normalized : `${normalized.slice(0, 149)}…`;
};

const targetTypeLabels: Record<ManagedToolAuditTargetType, string> = {
  recipient: "Recipient",
  chat: "Chat",
  channel: "Channel",
  file: "File",
  folder: "Folder",
  event: "Event",
  message: "Message",
  item: "Item",
  destination: "Destination",
};

/**
 * Produces the only free-text field accepted by the tool audit store. Generic
 * connectors never contribute arguments or provider results to this summary.
 */
export const buildToolAuditTargetSummary = (descriptor: ToolAuditTargetDescriptor): ToolAuditTargetSummary => {
  if (descriptor.provenance === "generic_template") {
    return toolAuditTargetSummarySchema.parse({
      targetType: "connector",
      text: "Connector tool invocation",
      provenance: "generic_template",
      redacted: false,
    });
  }
  const safe = safeTargetLabel(descriptor.target);
  const label = targetTypeLabels[descriptor.targetType];
  return toolAuditTargetSummarySchema.parse({
    targetType: descriptor.targetType,
    text: safe ? `${label}: ${safe}` : `${label} target`,
    provenance: "managed_schema",
    redacted: safe !== descriptor.target.normalize("NFKC").trim(),
  });
};

type AuditScope = Pick<ToolAuditAdmission, "tenantId" | "subjectId" | "workspaceId" | "agentInstanceId">;
type FinalizeToolAuditInput = AuditScope & ToolAuditTerminalInput & { invocationId: string };
type AdmissionResult = {
  status: "created" | "duplicate";
  admission: ToolAuditAdmission;
  terminal: ToolAuditTerminalRecord | null;
};
type TerminalResult = { status: "created" | "duplicate"; record: ToolAuditTerminalRecord };

const cloneAdmission = (value: ToolAuditAdmission): ToolAuditAdmission => structuredClone(value);
const cloneTerminal = (value: ToolAuditTerminalRecord): ToolAuditTerminalRecord => structuredClone(value);
const sourceKey = (input: Pick<ToolAuditAdmissionRecordInput, "tenantId" | "sourceSystem" | "sourceInvocationId">) => (
  canonicalJson([input.tenantId, input.sourceSystem, input.sourceInvocationId])
);
const terminalSemantic = (value: Pick<ToolAuditTerminalRecord, "outcome" | "latencyMs" | "failureClass">) => canonicalJson({
  outcome: value.outcome,
  latencyMs: value.latencyMs,
  failureClass: value.failureClass,
});
const scopeMatches = (record: ToolAuditAdmission, scope: AuditScope) => (
  record.tenantId === scope.tenantId
  && record.subjectId === scope.subjectId
  && record.workspaceId === scope.workspaceId
  && record.agentInstanceId === scope.agentInstanceId
);
const fixedPolicyOutcome = (decision: ToolAuditAdmission["policyDecision"]) => (
  decision === "deny" ? "denied" as const
    : decision === "approval_required" ? "approval_required" as const
      : null
);

export class InMemoryToolAuditStore {
  private readonly admissions = new Map<string, ToolAuditAdmission>();
  private readonly terminals = new Map<string, ToolAuditTerminalRecord>();
  private readonly invocationBySource = new Map<string, string>();
  private readonly admissionSemantics = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  admit(inputValue: ToolAuditAdmissionInput): AdmissionResult {
    const input = toolAuditAdmissionInputSchema.parse(inputValue);
    const { target, ...facts } = input;
    const persistedInput = toolAuditAdmissionRecordInputSchema.parse({
      ...facts,
      targetSummary: buildToolAuditTargetSummary(target),
    });
    const key = sourceKey(persistedInput);
    const semantic = canonicalJson(persistedInput);
    const existingId = this.invocationBySource.get(key);
    if (existingId) {
      if (this.admissionSemantics.get(existingId) !== semantic) {
        throw new LemmaComputerError(
          "TOOL_AUDIT_IDEMPOTENCY_CONFLICT",
          "The tool invocation source identity was already bound to different compliance facts",
          409,
        );
      }
      const existingTerminal = this.terminals.get(existingId) ?? null;
      const admission = this.admissions.get(existingId) ?? existingTerminal;
      if (!admission) throw new Error("Tool audit source index is inconsistent");
      return {
        status: "duplicate",
        admission: cloneAdmission(admission),
        terminal: existingTerminal ? cloneTerminal(existingTerminal) : null,
      };
    }

    const admittedAt = this.now().toISOString();
    const admission = toolAuditAdmissionSchema.parse({ ...persistedInput, invocationId: randomUUID(), admittedAt });
    this.invocationBySource.set(key, admission.invocationId);
    this.admissionSemantics.set(admission.invocationId, semantic);
    this.admissions.set(admission.invocationId, admission);

    const immediateOutcome = fixedPolicyOutcome(admission.policyDecision);
    if (!immediateOutcome) return { status: "created", admission: cloneAdmission(admission), terminal: null };
    const terminal = this.createTerminal(admission, {
      outcome: immediateOutcome,
      latencyMs: 0,
      failureClass: null,
    }, this.now());
    return { status: "created", admission: cloneAdmission(admission), terminal: cloneTerminal(terminal) };
  }

  finalize(inputValue: FinalizeToolAuditInput): TerminalResult {
    const terminal = toolAuditTerminalInputSchema.parse({
      outcome: inputValue.outcome,
      latencyMs: inputValue.latencyMs,
      failureClass: inputValue.failureClass,
    });
    const input = {
      ...inputValue,
      ...terminal,
    };
    const existing = this.terminals.get(input.invocationId);
    if (existing) {
      if (!scopeMatches(existing, input)) this.notFound();
      if (terminalSemantic(existing) !== terminalSemantic(input)) {
        throw new LemmaComputerError(
          "TOOL_AUDIT_TERMINAL_CONFLICT",
          "Terminal compliance evidence is append-only and cannot be replaced",
          409,
        );
      }
      return { status: "duplicate", record: cloneTerminal(existing) };
    }
    const admission = this.admissions.get(input.invocationId);
    if (!admission || !scopeMatches(admission, input)) this.notFound();
    if (admission.policyDecision !== "allow") {
      throw new LemmaComputerError("TOOL_AUDIT_TERMINAL_CONFLICT", "Policy terminals are recorded during admission", 409);
    }
    const record = this.createTerminal(admission, input, this.now());
    return { status: "created", record: cloneTerminal(record) };
  }

  reconcileUnconfirmed(staleBefore: Date, completedAt = this.now()) {
    let count = 0;
    for (const admission of [...this.admissions.values()]) {
      if (admission.policyDecision !== "allow" || Date.parse(admission.admittedAt) > staleBefore.getTime()) continue;
      const latencyMs = Math.min(7 * 24 * 60 * 60 * 1_000, Math.max(0, completedAt.getTime() - Date.parse(admission.admittedAt)));
      this.createTerminal(admission, {
        outcome: "unconfirmed",
        latencyMs,
        failureClass: "TOOL_AUDIT_TERMINAL_EVIDENCE_MISSING",
      }, completedAt);
      count += 1;
    }
    return count;
  }

  getPending(tenantId: string, invocationId: string) {
    const admission = this.admissions.get(invocationId);
    return admission?.tenantId === tenantId ? cloneAdmission(admission) : null;
  }

  getTerminal(tenantId: string, invocationId: string) {
    const record = this.terminals.get(invocationId);
    return record?.tenantId === tenantId ? cloneTerminal(record) : null;
  }

  listTerminal(tenantId: string) {
    return [...this.terminals.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt) || right.invocationId.localeCompare(left.invocationId))
      .map(cloneTerminal);
  }

  private createTerminal(admission: ToolAuditAdmission, input: ToolAuditTerminalInput, completedAt: Date) {
    const record = toolAuditTerminalRecordSchema.parse({
      ...admission,
      ...input,
      completedAt: completedAt.toISOString(),
    });
    this.terminals.set(record.invocationId, record);
    this.admissions.delete(record.invocationId);
    return record;
  }

  private notFound(): never {
    throw new LemmaComputerError("TOOL_AUDIT_INVOCATION_NOT_FOUND", "Tool invocation audit admission was not found", 404);
  }
}
