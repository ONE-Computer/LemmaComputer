import type { FastifyInstance } from "fastify";
import {
  LemmaComputerError,
  platformRoleAllowsAction,
  platformSupportElevationRequestSchema,
  tenantIdentifierSchema,
  type PlatformAction,
} from "@lemmacomputer/contracts";
import type {
  PlatformOperatorSession,
  PostgresPlatformOperatorStore,
} from "@lemmacomputer/workspace-store";
import {
  platformIncidentSeveritySchema,
  platformIncidentStatusSchema,
  platformTenantLifecycleStateSchema,
  workspaceNodeEndpointSchema,
  workspaceNodeIdSchema,
  workspaceNodeStateSchema,
  workspaceNodeTlsServerNameSchema,
} from "@lemmacomputer/workspace-store";
import { z } from "zod";
import { renderPlatformOperatorUi } from "./platform-operator-ui.js";
import type { PlatformSecurityAlertDispatcherStatus } from "./platform-security-alert-dispatcher.js";
import type { PlatformTenantCleanupDispatcherStatus } from "./platform-tenant-cleanup-dispatcher.js";

export interface PlatformOperatorAuthenticationBoundary {
  begin(returnPath?: string): Promise<{ location: string; cookie: string }>;
  beginStepUp(cookieHeader: string | undefined, returnPath?: string): Promise<{ location: string; cookie: string }>;
  complete(input: { state?: string; code?: string; error?: string; cookie?: string }): Promise<{
    session: PlatformOperatorSession;
    returnPath: string;
    cookie: string;
    clearStateCookie: string;
  }>;
  completeStepUp(input: { state?: string; code?: string; error?: string; cookie?: string }): Promise<{
    session: PlatformOperatorSession;
    returnPath: string;
    clearStateCookie: string;
  }>;
  authenticate(cookieHeader: string | undefined): Promise<PlatformOperatorSession | null>;
  logout(cookieHeader: string | undefined, correlationId: string): Promise<string | string[]>;
}

export type PlatformOperatorStoreBoundary = Pick<PostgresPlatformOperatorStore,
  | "requestElevation"
  | "listElevations"
  | "approveElevation"
  | "revokeElevation"
  | "readTenantDiagnostics"
  | "listSecurityAlerts"
  | "listTenantCleanupJobs"
  | "listAuditEvents"
  | "listTenantLifecycle"
  | "updateTenantLifecycle"
  | "getServiceHealth"
  | "listIncidents"
  | "createIncident"
  | "updateIncident"
  | "listPlatformConfiguration"
  | "setPlatformConfiguration"
  | "listWorkspaceNodes"
  | "registerWorkspaceNode"
  | "updateWorkspaceNodeState"
  | "listTenantWorkspaceNodeAssignments"
  | "assignTenantWorkspaceNode"
>;

const identifierSchema = z.uuid();

export function registerPlatformOperatorRoutes(
  app: FastifyInstance,
  options: {
    authentication: PlatformOperatorAuthenticationBoundary;
    store: PlatformOperatorStoreBoundary;
    securityAlertDelivery?: { status(): PlatformSecurityAlertDispatcherStatus };
    tenantCleanupDelivery?: { status(): PlatformTenantCleanupDispatcherStatus };
    approvalConfigured: boolean;
    sessionFor(request: object): PlatformOperatorSession;
  },
) {
  const requireAction = (request: object, action: PlatformAction) => {
    const session = options.sessionFor(request);
    if (!platformRoleAllowsAction(session.roles, action)) {
      throw new LemmaComputerError("PLATFORM_OPERATOR_FORBIDDEN", "Platform operator authority is required", 403);
    }
    return session;
  };

  app.get<{ Querystring: { return?: string } }>("/v1/platform/auth/login", async (request, reply) => {
    const started = await options.authentication.begin(request.query.return);
    return reply.code(302).header("set-cookie", started.cookie).header("location", started.location).send();
  });

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    "/v1/platform/auth/callback",
    async (request, reply) => {
      try {
        const completed = await options.authentication.complete({ ...request.query, cookie: request.headers.cookie });
        reply.header("set-cookie", [completed.cookie, completed.clearStateCookie]);
        return reply.code(303).header("location", completed.returnPath).send();
      } catch (error) {
        const code = error instanceof LemmaComputerError ? error.code : "PLATFORM_OIDC_FAILED";
        request.log.warn({ code }, "Platform workforce callback rejected");
        return reply.code(303).header("location", "/platform/sign-in?error=not-completed").send();
      }
    },
  );

  app.get<{ Querystring: { return?: string } }>("/v1/platform/auth/step-up", async (request, reply) => {
    const started = await options.authentication.beginStepUp(request.headers.cookie, request.query.return);
    return reply.code(302).header("set-cookie", started.cookie).header("location", started.location).send();
  });

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    "/v1/platform/auth/step-up/callback",
    async (request, reply) => {
      try {
        const completed = await options.authentication.completeStepUp({ ...request.query, cookie: request.headers.cookie });
        return reply.code(303).header("set-cookie", completed.clearStateCookie).header("location", completed.returnPath).send();
      } catch (error) {
        const code = error instanceof LemmaComputerError ? error.code : "PLATFORM_STEP_UP_FAILED";
        request.log.warn({ code }, "Platform workforce step-up callback rejected");
        return reply.code(303).header("location", "/api/v1/platform/ui?error=step-up-not-completed").send();
      }
    },
  );

  app.get("/v1/platform/auth/session", async (request) => {
    const session = options.sessionFor(request);
    return { operator: session.principal, roles: session.roles };
  });

  app.post("/v1/platform/auth/logout", async (request, reply) => reply
    .code(204)
    .header("set-cookie", await options.authentication.logout(request.headers.cookie, request.id))
    .send());

  app.get("/v1/platform/ui", async (request, reply) => reply
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("x-frame-options", "DENY")
    .send(renderPlatformOperatorUi(options.sessionFor(request))));

  app.get("/v1/platform/tenants", async (request) => {
    const session = requireAction(request, "tenant.lifecycle.read");
    return { tenants: await options.store.listTenantLifecycle(session) };
  });

  app.patch<{ Params: { tenantId: string } }>("/v1/platform/tenants/:tenantId/lifecycle", async (request) => {
    const session = requireAction(request, "tenant.lifecycle.manage");
    const input = z.strictObject({
      lifecycleState: platformTenantLifecycleStateSchema,
      reason: z.string().trim().min(12).max(1000),
    }).parse(request.body ?? {});
    return {
      tenant: await options.store.updateTenantLifecycle(session, {
        tenantId: tenantIdentifierSchema.parse(request.params.tenantId),
        ...input,
        correlationId: request.id,
      }),
    };
  });

  app.get("/v1/platform/workspace-nodes", async (request) => {
    const session = requireAction(request, "platform.config.read");
    return { nodes: await options.store.listWorkspaceNodes(session) };
  });

  app.post("/v1/platform/workspace-nodes", async (request, reply) => {
    const session = requireAction(request, "platform.config.manage");
    const input = z.strictObject({
      id: workspaceNodeIdSchema,
      endpointUrl: workspaceNodeEndpointSchema,
      tlsServerName: workspaceNodeTlsServerNameSchema,
      reason: z.string().trim().min(12).max(1000),
    }).parse(request.body ?? {});
    return reply.code(201).send({
      node: await options.store.registerWorkspaceNode(session, { ...input, correlationId: request.id }),
    });
  });

  app.patch<{ Params: { workspaceNodeId: string } }>("/v1/platform/workspace-nodes/:workspaceNodeId/state", async (request) => {
    const session = requireAction(request, "platform.config.manage");
    const input = z.strictObject({
      state: workspaceNodeStateSchema,
      reason: z.string().trim().min(12).max(1000),
    }).parse(request.body ?? {});
    return {
      node: await options.store.updateWorkspaceNodeState(session, {
        workspaceNodeId: workspaceNodeIdSchema.parse(request.params.workspaceNodeId),
        ...input,
        correlationId: request.id,
      }),
    };
  });

  app.get("/v1/platform/workspace-node-assignments", async (request) => {
    const session = requireAction(request, "platform.config.read");
    return { assignments: await options.store.listTenantWorkspaceNodeAssignments(session) };
  });

  app.put<{ Params: { tenantId: string } }>("/v1/platform/tenants/:tenantId/workspace-node", async (request) => {
    const session = requireAction(request, "platform.config.manage");
    const input = z.strictObject({
      workspaceNodeId: workspaceNodeIdSchema,
      reason: z.string().trim().min(12).max(1000),
      backfillUnplacedWorkspaces: z.boolean().default(false),
    }).parse(request.body ?? {});
    return await options.store.assignTenantWorkspaceNode(session, {
      tenantId: tenantIdentifierSchema.parse(request.params.tenantId),
      ...input,
      correlationId: request.id,
    });
  });

  app.get("/v1/platform/service-health", async (request) => {
    const session = requireAction(request, "service.health.read");
    return { health: await options.store.getServiceHealth(session) };
  });

  app.get("/v1/platform/incidents", async (request) => {
    const session = requireAction(request, "incident.read");
    return { incidents: await options.store.listIncidents(session) };
  });

  app.post("/v1/platform/incidents", async (request, reply) => {
    const session = requireAction(request, "incident.manage");
    const input = z.strictObject({
      title: z.string().trim().min(4).max(200),
      summary: z.string().trim().min(12).max(4000),
      severity: platformIncidentSeveritySchema,
    }).parse(request.body ?? {});
    return reply.code(201).send({
      incident: await options.store.createIncident(session, { ...input, correlationId: request.id }),
    });
  });

  app.patch<{ Params: { incidentId: string } }>("/v1/platform/incidents/:incidentId", async (request) => {
    const session = requireAction(request, "incident.manage");
    const input = z.strictObject({
      title: z.string().trim().min(4).max(200).optional(),
      summary: z.string().trim().min(12).max(4000).optional(),
      severity: platformIncidentSeveritySchema.optional(),
      status: platformIncidentStatusSchema.optional(),
    }).refine((value) => Object.values(value).some((entry) => entry !== undefined), "At least one incident field is required").parse(request.body ?? {});
    return {
      incident: await options.store.updateIncident(session, {
        incidentId: identifierSchema.parse(request.params.incidentId),
        ...input,
        correlationId: request.id,
      }),
    };
  });

  app.get("/v1/platform/configuration", async (request) => {
    const session = requireAction(request, "platform.config.read");
    return { configuration: await options.store.listPlatformConfiguration(session) };
  });

  app.put<{ Params: { key: string } }>("/v1/platform/configuration/:key", async (request) => {
    const session = requireAction(request, "platform.config.manage");
    const input = z.strictObject({
      value: z.json(),
      reason: z.string().trim().min(12).max(1000),
    }).parse(request.body ?? {});
    return {
      configuration: await options.store.setPlatformConfiguration(session, {
        key: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/).max(200).parse(request.params.key),
        ...input,
        correlationId: request.id,
      }),
    };
  });

  app.post("/v1/platform/support/elevations", async (request, reply) => {
    const session = requireAction(request, "support.elevation.request");
    const input = platformSupportElevationRequestSchema.parse(request.body ?? {});
    const elevation = await options.store.requestElevation(session, input, {
      approvalConfigured: options.approvalConfigured,
      correlationId: request.id,
    });
    return reply.code(201).send({ elevation });
  });

  app.get<{ Querystring: { status?: "pending" | "active" | "expired" | "revoked" } }>(
    "/v1/platform/support/elevations",
    async (request) => {
      const session = requireAction(request, "support.elevation.read");
      const filter = z.strictObject({
        status: z.enum(["pending", "active", "expired", "revoked"]).optional(),
      }).parse(request.query);
      return { elevations: await options.store.listElevations(session, filter) };
    },
  );

  app.post<{ Params: { elevationId: string } }>(
    "/v1/platform/support/elevations/:elevationId/approve",
    async (request) => {
      const session = requireAction(request, "support.elevation.approve");
      return {
        elevation: await options.store.approveElevation(
          session,
          identifierSchema.parse(request.params.elevationId),
          request.id,
        ),
      };
    },
  );

  app.post<{ Params: { elevationId: string } }>(
    "/v1/platform/support/elevations/:elevationId/revoke",
    async (request) => {
      const session = requireAction(request, "support.elevation.revoke");
      return {
        elevation: await options.store.revokeElevation(
          session,
          identifierSchema.parse(request.params.elevationId),
          request.id,
        ),
      };
    },
  );

  app.get<{ Params: { tenantId: string }; Querystring: { elevationId?: string } }>(
    "/v1/platform/tenants/:tenantId/diagnostics",
    async (request) => {
      const session = requireAction(request, "support.elevation.use");
      const input = z.strictObject({ elevationId: z.uuid() }).parse(request.query);
      const diagnostics = await options.store.readTenantDiagnostics(session, {
        elevationId: input.elevationId,
        targetOrganizationId: tenantIdentifierSchema.parse(request.params.tenantId),
        correlationId: request.id,
      });
      if (!diagnostics) {
        throw new LemmaComputerError("PLATFORM_SUPPORT_ELEVATION_DENIED", "Tenant diagnostics access is not valid", 403);
      }
      return { diagnostics, correlationId: request.id };
    },
  );

  app.get<{ Querystring: { targetOrganizationId?: string; operatorId?: string } }>(
    "/v1/platform/audit",
    async (request) => {
      requireAction(request, "platform.audit.read");
      const filter = z.strictObject({
        targetOrganizationId: tenantIdentifierSchema.optional(),
        operatorId: z.uuid().optional(),
      }).parse(request.query);
      return { events: await options.store.listAuditEvents(filter) };
    },
  );

  app.get<{ Querystring: { status?: "pending" | "delivering" | "retry" | "delivered" | "escalated" } }>(
    "/v1/platform/security-alerts",
    async (request) => {
      requireAction(request, "platform.audit.read");
      const filter = z.strictObject({
        status: z.enum(["pending", "delivering", "retry", "delivered", "escalated"]).optional(),
      }).parse(request.query);
      return { alerts: await options.store.listSecurityAlerts(filter) };
    },
  );

  app.get("/v1/platform/security-alert-delivery", async (request) => {
    requireAction(request, "platform.audit.read");
    if (!options.securityAlertDelivery) {
      throw new LemmaComputerError("PLATFORM_SECURITY_ALERT_DELIVERY_UNAVAILABLE", "Security alert delivery is unavailable", 503, true);
    }
    return { delivery: options.securityAlertDelivery.status() };
  });

  app.get("/v1/platform/tenant-cleanup", async (request) => {
    requireAction(request, "platform.audit.read");
    if (!options.tenantCleanupDelivery) {
      throw new LemmaComputerError("PLATFORM_TENANT_CLEANUP_UNAVAILABLE", "Tenant cleanup delivery is unavailable", 503, true);
    }
    return {
      delivery: options.tenantCleanupDelivery.status(),
      jobs: await options.store.listTenantCleanupJobs(),
    };
  });
}
