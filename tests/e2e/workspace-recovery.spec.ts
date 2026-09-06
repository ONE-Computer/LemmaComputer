import { expect, test } from "@playwright/test";

test("workspace cards retain their positions across reordered status refreshes", async ({ page }) => {
  let listRequests = 0;
  await page.route("**/api/v1/workspaces", async (route) => {
    listRequests += 1;
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        workspaces: listRequests === 1 ? payload.workspaces : [...payload.workspaces].reverse(),
      },
    });
  });

  await page.clock.install();
  await page.goto("/");
  const cards = page.locator(".workspace-overview-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.locator("h2")).toHaveText(["Acme Workspace", "Research", "Product"]);

  await page.clock.fastForward(10_000);
  await expect.poll(() => listRequests).toBeGreaterThanOrEqual(2);
  await expect(cards.locator("h2")).toHaveText(["Acme Workspace", "Research", "Product"]);
});

test("workspace creation is shown only when the organization grants workspace.create", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      user: { id: "member-alex", displayName: "Alex Member", email: "alex@acme.test" },
      tenant: { id: "acme", displayName: "Acme" },
      roles: ["member"],
      capabilities: ["organization.read", "workspace.use"],
      resourceCapabilities: [],
    },
  }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create workspace" })).toHaveCount(0);

  await page.unroute("**/api/v1/auth/session");
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      user: { id: "member-alex", displayName: "Alex Member", email: "alex@acme.test" },
      tenant: { id: "acme", displayName: "Acme" },
      roles: ["member"],
      capabilities: ["organization.read", "workspace.use", "workspace.create"],
      resourceCapabilities: [],
    },
  }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Create workspace" })).toBeVisible();
});

test("administrators get exact recovery links for provider, model-route, and pricing setup", async ({ page }) => {
  let failure = {
    status: 409,
    code: "PROVIDER_NOT_CONFIGURED",
    message: "That provider is not configured",
  };
  await page.route("**/api/v1/workspaces", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: failure.status,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: failure.code, message: failure.message, retryable: false } }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Create workspace" }).click();
  const prompt = page.getByRole("dialog", { name: "Create workspace" });
  await prompt.getByLabel("Workspace name").fill("Recovery links");
  await prompt.getByRole("button", { name: "Continue to configuration" }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("A model provider has not been connected for this workspace.");
  const providerLink = alert.getByRole("link", { name: "Set up a workspace provider" });
  await expect(providerLink).toHaveAttribute("href", "?view=ai-control-plane&section=models-providers&focus=provider");
  await expect(providerLink).toHaveCSS("text-decoration-line", "underline");

  failure = {
    status: 503,
    code: "MODEL_TIER_ROUTE_UNAVAILABLE",
    message: "No ready route is available for that model tier",
  };
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(alert).toContainText("No model route is ready for this workspace.");
  await expect(alert.getByRole("link", { name: "Configure model routes" })).toHaveAttribute(
    "href",
    "?view=ai-control-plane&section=models-providers&focus=route",
  );

  failure = {
    status: 422,
    code: "MODEL_TIER_PRICING_UNAVAILABLE",
    message: "Pricing is not ready for that model tier",
  };
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(alert).toContainText("Approved pricing is missing for this workspace's model route.");
  const pricingLink = alert.getByRole("link", { name: "Set up pricing" });
  await expect(pricingLink).toHaveAttribute("href", "?view=ai-control-plane&section=models-providers&focus=pricing");
  await pricingLink.click();
  await expect(page).toHaveURL(/\?view=ai-control-plane&section=models-providers&focus=pricing$/);
  await expect(page.getByRole("heading", { name: "Models & routing", exact: true })).toBeVisible();
});

test("members are told to contact an administrator without receiving configuration links", async ({ page }) => {
  let failure = {
    status: 409,
    code: "PROVIDER_NOT_CONFIGURED",
    message: "That provider is not configured",
  };
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      user: { id: "member-alex", displayName: "Alex Member", email: "alex@acme.test" },
      tenant: { id: "acme", displayName: "Acme" },
      roles: ["member"],
      capabilities: ["organization.read", "workspace.use", "workspace.create", "workspace.manage_own"],
      resourceCapabilities: [],
    },
  }));
  await page.route("**/api/v1/workspaces", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { workspaces: [] } });
      return;
    }
    await route.fulfill({
      status: failure.status,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: failure.code, message: failure.message, retryable: false } }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Create workspace" }).click();
  const prompt = page.getByRole("dialog", { name: "Create workspace" });
  await prompt.getByLabel("Workspace name").fill("Member recovery");
  await prompt.getByRole("button", { name: "Continue to configuration" }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Contact your administrator to connect one.");
  await expect(alert.getByRole("link")).toHaveCount(0);

  failure = {
    status: 503,
    code: "MODEL_TIER_ROUTE_UNAVAILABLE",
    message: "No ready route is available for that model tier",
  };
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(alert).toContainText("Contact your administrator to configure one.");
  await expect(alert.getByRole("link")).toHaveCount(0);

  failure = {
    status: 422,
    code: "MODEL_TIER_PRICING_UNAVAILABLE",
    message: "Pricing is not ready for that model tier",
  };
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(alert).toContainText("Contact your administrator to add it.");
  await expect(alert.getByRole("link")).toHaveCount(0);
});

test("workspace deletion separates runtime removal from durable-content retention", async ({ page }) => {
  const workspaceId = "3c536c1f-6a31-427d-af8f-dbb0c63f8d70";
  let deletionRequest = null;
  await page.route(`**/api/v1/workspaces/${workspaceId}/deletion-impact`, (route) => route.fulfill({
    json: {
      conversations: 3,
      artifacts: 2,
      protectedConversations: 1,
      protectedArtifacts: 1,
    },
  }));
  await page.route(`**/api/v1/workspaces/${workspaceId}`, async (route) => {
    deletionRequest = route.request().postDataJSON();
    await route.fulfill({ status: 204, body: "" });
  });

  await page.goto("/");
  const workspace = page.getByRole("article", { name: "Research" });
  await workspace.getByRole("button", { name: "Delete" }).click();

  const dialog = page.getByRole("dialog", { name: "Delete Research?" });
  await expect(dialog.getByRole("radio", { name: /^Keep chats and artifacts/ })).toBeChecked();
  await expect(dialog).toContainText("3 chats and 2 artifacts will be preserved");
  await dialog.getByText("Delete eligible chats and artifacts", { exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /^Delete eligible chats and artifacts/ })).toBeChecked();
  await expect(dialog).toContainText("2 protected items will not be deleted");
  await dialog.getByRole("button", { name: "Delete and stage content" }).click();

  await expect(workspace).toHaveCount(0);
  await expect(page.getByText("Research deleted. Eligible chats and artifacts were staged for deletion.")).toBeVisible();
  expect(deletionRequest).toEqual({ contentDisposition: "delete" });
});

test("an authenticated member can create and manage only their own workspace", async ({ page }) => {
  const workspaceId = "3c536c1f-6a31-427d-af8f-dbb0c63f8d71";
  let createdWorkspace = null;
  let releaseCreation = () => {};
  const creationReleased = new Promise<void>((resolve) => { releaseCreation = resolve; });

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      user: { id: "member-alex", displayName: "Alex Member", email: "alex@acme.test" },
      tenant: { id: "acme", displayName: "Acme" },
      roles: ["member"],
      capabilities: ["organization.read", "workspace.use", "workspace.create", "workspace.manage_own"],
      resourceCapabilities: [],
    },
  }));
  await page.route("**/api/v1/workspaces", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { workspaces: createdWorkspace ? [createdWorkspace] : [] } });
      return;
    }
    const input = route.request().postDataJSON();
    await creationReleased;
    createdWorkspace = {
      id: workspaceId,
      grantId: input.grantId,
      state: "provisioning",
      readiness: { identity: "checking", network: "checking", models: "checking", tools: "checking" },
      applications: ["google-chrome"],
      agents: [{ id: "hermes-desktop", displayName: "Hermes Agent Desktop", clientVersion: "0.17.0", agentId: "agent-alex:demo", state: "starting" }],
      policyAssignment: { version: 4, hash: "a".repeat(64) },
      profile: {
        id: "disposable-open-v1",
        client: "LemmaComputer open workspace",
        clientVersion: "disposable-open-v1",
        modelAlias: "lemmacomputer-openai",
        executionMode: "disposable-open",
        egressMode: "full-web",
        persistence: "persistent-home",
        network: "gateway-only",
      },
    };
    await route.fulfill({ status: 201, json: createdWorkspace });
  });
  await page.route("**/api/v1/sandbox-settings**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        availableProfiles: [payload.availableProfiles[0], {
          id: "kasm-persistent-standard",
          displayName: "Qualification workspace (legacy)",
          description: "Retained only for pinned compatibility.",
          executionMode: "managed",
        }],
      },
    });
  });

  await page.goto("/");
  await expect(page.getByText("No workspaces yet")).toBeVisible();
  await page.getByRole("button", { name: "Create workspace" }).click();
  const prompt = page.getByRole("dialog", { name: "Create workspace" });
  await prompt.getByLabel("Workspace name").fill("Demo workspace");
  await prompt.getByRole("button", { name: "Continue to configuration" }).click();
  await expect(page.getByRole("heading", { name: "Demo Workspace" })).toBeVisible();
  await expect(page.getByText("Your organization currently allows Restricted workspace access.", { exact: false })).toBeVisible();
  await expect(page.getByText("Qualification workspace (legacy)", { exact: true })).toHaveCount(0);
  await expect(page.getByText("open workspace for non-sensitive work", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Create workspace" }).click();

  const progress = page.locator(".workspace-creation-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("aria-busy", "true");
  await expect(progress.getByRole("heading", { name: "Demo Workspace" })).toBeVisible();
  await expect(progress).toContainText(/Securing the workspace boundary|Applying approved apps and model routes|Starting governed services|Checking the final connections/);
  await expect(page.getByRole("button", { name: "Building workspace…" })).toBeDisabled();
  releaseCreation();

  const card = page.getByRole("article", { name: "Demo Workspace" });
  await expect(card).toContainText("Preparing");
  await expect(card.getByRole("button", { name: "Manage configuration" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Restart" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Stop" })).toBeVisible();
});

test("keeps a retryable workspace start in Preparing instead of Needs attention", async ({ page }) => {
  let attempts = 0;
  const idempotencyKeys: string[] = [];
  await page.route("**/api/v1/workspaces", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts += 1;
    idempotencyKeys.push((await route.request().allHeaders())["idempotency-key"] ?? "");
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "DOCKER_UNAVAILABLE", message: "Docker is reconciling workspace networking", retryable: true } }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "3c536c1f-6a31-427d-af8f-dbb0c63f8d70",
        grantId: "sandbox-research",
        state: "provisioning",
        readiness: { identity: "checking", network: "checking", models: "checking", tools: "checking" },
        applications: ["google-chrome"],
        agents: [{ id: "hermes-desktop", displayName: "Hermes Agent Desktop", clientVersion: "0.17.0", agentId: "agent-alex:research", state: "starting" }],
        policyAssignment: { version: 4, hash: "a".repeat(64) },
        profile: {
          id: "disposable-open-v1",
          client: "LemmaComputer open workspace",
          clientVersion: "disposable-open-v1",
          modelAlias: "lemmacomputer-openai",
          executionMode: "disposable-open",
          egressMode: "full-web",
          persistence: "persistent-home",
          network: "gateway-only",
        },
      }),
    });
  });

  await page.goto("/");
  const card = page.getByRole("article", { name: "Research" });
  await expect(card).toContainText("Stopped");
  await card.getByRole("button", { name: "Start workspace" }).click();

  await expect.poll(() => attempts).toBe(2);
  expect(idempotencyKeys[0]).toBeTruthy();
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  await expect(card).toContainText("Preparing");
  await expect(page.getByText("Needs attention", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("workspace model route tiers persist after save and refresh", async ({ page }) => {
  await page.goto("/");
  const workspace = page.getByRole("article", { name: "Research" });
  await workspace.getByRole("button", { name: "Manage configuration" }).click();

  await expect(page.getByRole("heading", { name: "Default model mode" })).toBeVisible();
  await expect(page.getByText("Choose the default quality and cost mode for this workspace. You can choose a different mode for each conversation in Chat.")).toBeVisible();
  const modelRoutes = page.getByRole("radiogroup", { name: "Default model mode" });
  await expect(modelRoutes.getByRole("radio")).toHaveCount(3);
  await expect(modelRoutes.getByText("Auto", { exact: true })).toHaveCount(0);
  await modelRoutes.getByText("Pro", { exact: true }).click();
  await expect(modelRoutes.getByRole("radio", { name: /^Pro/ })).toBeChecked();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByText("Workspace configuration saved. Restart the workspace to apply changes.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Your workspaces" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Restart required" })).toHaveCount(0);

  await page.reload();
  await page.getByRole("article", { name: "Research" }).getByRole("button", { name: "Manage configuration" }).click();
  await expect(page.getByRole("radiogroup", { name: "Default model mode" }).getByRole("radio", { name: /^Pro/ })).toBeChecked();
});

test("workspace configuration shows only published organization routes", async ({ page }) => {
  await page.route("**/api/v1/sandbox-settings**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        requestedServiceClass: "lite",
        availableServiceClasses: payload.availableServiceClasses.filter(({ value }: { value: string }) => value === "lite" || value === "pro"),
      },
    });
  });

  await page.goto("/");
  await page.getByRole("article", { name: "Research" }).getByRole("button", { name: "Manage configuration" }).click();

  const modelRoutes = page.getByRole("radiogroup", { name: "Default model mode" });
  await expect(modelRoutes.getByRole("radio")).toHaveCount(2);
  await expect(modelRoutes.getByRole("radio", { name: /^Lite/ })).toBeChecked();
  await expect(modelRoutes.getByRole("radio", { name: /^Pro/ })).toBeVisible();
  await expect(modelRoutes.getByText("Balanced", { exact: true })).toHaveCount(0);
});

test("workspace configuration pre-empts unavailable AI setup without blocking a base workspace", async ({ page }) => {
  await page.route("**/api/v1/sandbox-settings**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        modelAlias: null,
        agentIds: [],
        availableModels: [],
        availableServiceClasses: [],
      },
    });
  });

  await page.goto("/");
  await page.getByRole("article", { name: "Research" }).getByRole("button", { name: "Manage configuration" }).click();

  const agents = page.locator('section[aria-labelledby="sandbox-agents-heading"]');
  await expect(agents).toHaveAttribute("aria-disabled", "true");
  await expect(agents.getByText("AI agents unavailable", { exact: true })).toBeVisible();
  await expect(agents.getByRole("checkbox")).not.toHaveCount(0);
  for (const checkbox of await agents.getByRole("checkbox").all()) await expect(checkbox).toBeDisabled();

  const modelModes = page.locator('section[aria-labelledby="sandbox-model-heading"]');
  await expect(modelModes).toHaveAttribute("aria-disabled", "true");
  await expect(modelModes.getByText("Model modes unavailable", { exact: true })).toBeVisible();
  await expect(modelModes.getByRole("radiogroup")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review models & routing" }).first()).toHaveAttribute(
    "href",
    "?view=ai-control-plane&section=models-providers",
  );
  await expect(page.getByRole("alert", { name: /Workspace configuration unavailable/ })).toHaveCount(0);
});

test("workspace configuration can save a base workspace with no applications or AI agents", async ({ page }) => {
  let savedConfiguration: Record<string, unknown> | null = null;
  await page.route("**/api/v1/sandbox-settings**", async (route) => {
    if (route.request().method() === "PUT") {
      savedConfiguration = route.request().postDataJSON();
    }
    await route.continue();
  });

  await page.goto("/");
  await page.getByRole("article", { name: "Research" }).getByRole("button", { name: "Manage configuration" }).click();

  const applications = page.locator('section[aria-labelledby="sandbox-applications-heading"]');
  const agents = page.locator('section[aria-labelledby="sandbox-agents-heading"]');
  for (const checkbox of await applications.getByRole("checkbox").all()) {
    if (await checkbox.isChecked()) await checkbox.uncheck({ force: true });
  }
  for (const checkbox of await agents.getByRole("checkbox").all()) {
    if (await checkbox.isChecked()) await checkbox.uncheck({ force: true });
  }
  await expect(applications.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await expect(agents.locator('input[type="checkbox"]:checked')).toHaveCount(0);

  await expect(page.getByText("No additional applications selected. The base managed desktop will still launch.")).toBeVisible();
  await expect(page.getByText("No AI agents selected. This workspace does not require a model provider or receive AI credentials.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Default model mode" })).toHaveCount(0);
  await expect(page.getByText(/Schema v2 .* base workspace/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save configuration" })).toBeEnabled();
  await page.getByRole("button", { name: "Save configuration" }).click();

  await expect.poll(() => savedConfiguration).not.toBeNull();
  expect(savedConfiguration).toMatchObject({
    applicationIds: [],
    agentIds: [],
    modelAlias: null,
  });
});

test("workspace configuration distinguishes policy-disabled agents from unqualified clients", async ({ page }) => {
  await page.route("**/api/v1/sandbox-settings**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        agentIds: payload.agentIds.filter((id: string) => id !== "claude-cli"),
        availableAgents: payload.availableAgents.filter((agent: { id: string }) => agent.id !== "claude-cli"),
      },
    });
  });

  await page.goto("/");
  await page.getByRole("article", { name: "Research" }).getByRole("button", { name: "Manage configuration" }).click();

  const claudeCli = page.locator(".agent-family").filter({ hasText: "Claude" }).locator(".agent-choice.unavailable").filter({ hasText: "CLI" });
  await expect(claudeCli).toContainText("Disabled by organization policy");
  await expect(claudeCli).toContainText("This client is not allowed by the active organization policy.");

  const codexCli = page.locator(".agent-family").filter({ hasText: "OpenAI" }).locator(".agent-choice.unavailable").filter({ hasText: "Codex CLI" });
  await expect(codexCli).toContainText("Coming soon");
  await expect(codexCli).toContainText("This client is awaiting governance qualification.");
});

for (const initial of ["failed", "stopped"] as const) {
  test(`background recovery updates cards while the selected workspace is ${initial}`, async ({ page }) => {
    let recovered = false;
    let requests = 0;
    await page.route("**/api/v1/workspaces", async (route) => {
      requests++;
      const response = await route.fetch();
      const payload = await response.json();
      await route.fulfill({ response, json: {
        ...payload,
        workspaces: payload.workspaces.map((workspace, index) => ({
          ...workspace,
          state: recovered && index === 1 ? "ready" : initial,
          failureCode: !recovered && initial === "failed" ? "WORKSPACE_HEALTHCHECK_FAILED" : null,
        })),
      } });
    });
    await page.clock.install();
    await page.goto("/");
    const cards = page.locator(".workspace-overview-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(1)).toContainText(initial === "failed" ? "Needs attention" : "Stopped");
    recovered = true;
    const baseline = requests;
    await page.clock.fastForward(10_000);
    await expect.poll(() => requests).toBeGreaterThan(baseline);
    await expect(cards.nth(1)).toContainText("Ready");
    await expect(cards.first()).toContainText(initial === "failed" ? "Needs attention" : "Stopped");
  });
}
