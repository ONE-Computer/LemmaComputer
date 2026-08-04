import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { LemmaComputerError, type IdentityContext } from "@lemmacomputer/contracts";
import {
  managedProviderDeploymentDescriptors,
  managedProviderModels,
  type ManagedProviderConfiguration,
  type ManagedProviderOperation,
  type ManagedProviderRoute,
  type ProviderAdministrationGateway,
} from "@lemmacomputer/litellm-adapter";
import { PostgresProviderSettingsStore, type SessionPrincipal } from "@lemmacomputer/workspace-store";
import { ProviderSettingsService } from "../apps/control-api/src/provider-settings.js";

const connectionString = process.env.PROVIDER_SETTINGS_TEST_DATABASE_URL;

type Deferred = { promise: Promise<void>; resolve: () => void };

const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

class DelayedProviderAdministration implements ProviderAdministrationGateway {
  configureGate: Deferred | null = null;
  configureStarted: Deferred | null = null;
  deleted: ManagedProviderOperation[] = [];

  async configureManagedProvider(input: ManagedProviderConfiguration): Promise<ManagedProviderRoute> {
    if (input.provider !== "openai") throw new Error("test gateway only supports OpenAI");
    if (this.configureGate) {
      this.configureStarted?.resolve();
      await this.configureGate.promise;
    }
    const configuration = input.modelIds ? { modelIds: input.modelIds } : { modelId: input.modelId };
    return {
      modelIds: managedProviderModels.openai.map((model) => `${input.tenantId}-openai-${model.alias}`),
      deployments: managedProviderDeploymentDescriptors(input.tenantId, input.provider, configuration),
      credentialFingerprint: `fp_${input.tenantId}_openai_lifecycle`,
      configuration,
    };
  }

  async testManagedProvider() {}

  async deleteManagedProvider(input: ManagedProviderOperation) {
    this.deleted.push({ ...input, existingModelIds: [...input.existingModelIds] });
  }
}

test("PostgreSQL provider settings persist only approved emissions regions", {
  skip: !connectionString,
}, async () => {
  const tenantId = `provider-settings-test-${randomUUID()}`;
  const store = PostgresProviderSettingsStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query(
      "INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Provider settings test')",
      [tenantId, `external-${tenantId}`],
    );
    const saved = await store.saveProviderSetting({
      tenantId,
      provider: "openai",
      modelIds: ["deployment-openai"],
      configuration: { modelIds: ["gpt-5.6-terra"], emissionsRegion: "sg" },
      state: "active",
      credentialFingerprint: "fp_providerregiontest",
      lastTestedAt: new Date(),
      lastErrorCode: null,
      updatedBy: "provider-settings-test",
    });
    assert.deepEqual(saved.configuration, {
      modelIds: ["gpt-5.6-terra"],
      emissionsRegion: "sg",
    });
    assert.deepEqual((await store.getProviderSetting(tenantId, "openai"))?.configuration,
      saved.configuration);

    await assert.rejects(
      pool.query(
        "UPDATE provider_settings SET configuration=configuration || '{\"emissionsRegion\":\"eu\"}'::jsonb WHERE tenant_id=$1 AND provider='openai'",
        [tenantId],
      ),
      /provider_settings_configuration_safe_check/,
    );
    await assert.rejects(
      pool.query(
        "UPDATE provider_settings SET configuration=configuration || '{\"unexpected\":true}'::jsonb WHERE tenant_id=$1 AND provider='openai'",
        [tenantId],
      ),
      /provider_settings_configuration_safe_check/,
    );
  } finally {
    await pool.query("DELETE FROM provider_settings WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    await Promise.all([store.close(), pool.end()]);
  }
});

test("PostgreSQL lifecycle fencing survives concurrent Control instances and keeps disable dominant", {
  skip: !connectionString,
}, async () => {
  const tenantId = `provider-lifecycle-test-${randomUUID()}`;
  const identity: IdentityContext = {
    tenantId,
    subjectId: "provider-lifecycle-admin",
    audience: "lemmacomputer-control",
  };
  const actor: SessionPrincipal = {
    userId: identity.subjectId,
    tenantId,
    email: "provider-lifecycle-admin@example.test",
    displayName: "Provider lifecycle administrator",
    tenantDisplayName: "Provider lifecycle test",
    roles: ["administrator"],
    identity,
  };
  const firstStore = PostgresProviderSettingsStore.fromConnectionString(connectionString!);
  const secondStore = PostgresProviderSettingsStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  const gateway = new DelayedProviderAdministration();
  const first = new ProviderSettingsService(firstStore, gateway);
  const revokeStarted = deferred();
  const second = new ProviderSettingsService(secondStore, gateway, {
    revokeWorkspaceGrants: async () => {
      revokeStarted.resolve();
      return { revoked: 0, failed: 0 };
    },
  });
  try {
    await pool.query(
      "INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Provider lifecycle test')",
      [tenantId, `external-${tenantId}`],
    );
    await first.configure(actor, {
      provider: "openai",
      apiKey: "sk-provider-lifecycle-initial-never-log-0001",
      modelId: "gpt-5.6-terra",
    });

    gateway.configureGate = deferred();
    gateway.configureStarted = deferred();
    const rotation = first.configure(actor, {
      provider: "openai",
      apiKey: "sk-provider-lifecycle-rotation-never-log-0002",
      modelId: "gpt-5.6-sol",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await gateway.configureStarted.promise;

    const disable = second.disable(actor, "openai");
    await revokeStarted.promise;
    const fencedBeforeRotationCompletes = await secondStore.getProviderSetting(tenantId, "openai");
    assert.equal(fencedBeforeRotationCompletes?.state, "disabled");
    gateway.configureGate.resolve();
    const disabled = await disable;
    assert.equal(disabled.provider.state, "disabled");
    const rotationError = await rotation;
    assert.ok(rotationError instanceof LemmaComputerError);
    assert.equal(rotationError.code, "PROVIDER_LIFECYCLE_FENCED");

    const setting = await secondStore.getProviderSetting(tenantId, "openai");
    const lifecycle = await secondStore.getProviderLifecycle(tenantId, "openai");
    assert.equal(setting?.state, "disabled");
    assert.deepEqual(setting?.modelIds, []);
    assert.equal(lifecycle?.desiredState, "disabled");
    assert.equal(lifecycle?.reconciliationStatus, "not_required");
    assert.ok(gateway.deleted.length >= 1, "the disabled route must be removed after the fenced rotation finishes");

    const eventsBeforeRetry = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM provider_lifecycle_events WHERE tenant_id=$1 AND provider='openai'",
      [tenantId],
    );
    const reconciled = await second.reconcile(actor, "openai");
    assert.equal(reconciled.provider.state, "disabled");
    const eventsAfterRetry = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM provider_lifecycle_events WHERE tenant_id=$1 AND provider='openai'",
      [tenantId],
    );
    assert.equal(eventsAfterRetry.rows[0]?.count, eventsBeforeRetry.rows[0]?.count,
      "reconciliation retries must not duplicate an already-recorded lifecycle phase");
  } finally {
    await pool.query("DELETE FROM provider_lifecycle_fences WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM provider_settings WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    await Promise.all([firstStore.close(), secondStore.close(), pool.end()]);
  }
});

test("PostgreSQL disable epoch blocks a configure from another Control instance until it completes", {
  skip: !connectionString,
}, async () => {
  const tenantId = `provider-disable-epoch-test-${randomUUID()}`;
  const identity: IdentityContext = {
    tenantId,
    subjectId: "provider-disable-epoch-admin",
    audience: "lemmacomputer-control",
  };
  const actor: SessionPrincipal = {
    userId: identity.subjectId,
    tenantId,
    email: "provider-disable-epoch-admin@example.test",
    displayName: "Provider disable epoch administrator",
    tenantDisplayName: "Provider disable epoch test",
    roles: ["administrator"],
    identity,
  };
  const firstStore = PostgresProviderSettingsStore.fromConnectionString(connectionString!);
  const secondStore = PostgresProviderSettingsStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  const gateway = new DelayedProviderAdministration();
  const first = new ProviderSettingsService(firstStore, gateway);
  const revocationStarted = deferred();
  const releaseRevocation = deferred();
  const second = new ProviderSettingsService(secondStore, gateway, {
    revokeWorkspaceGrants: async () => {
      revocationStarted.resolve();
      await releaseRevocation.promise;
      return { revoked: 0, failed: 0 };
    },
  });
  try {
    await pool.query(
      "INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Provider disable epoch test')",
      [tenantId, `external-${tenantId}`],
    );
    await first.configure(actor, {
      provider: "openai",
      apiKey: "sk-provider-disable-epoch-initial-never-log-0001",
      modelId: "gpt-5.6-terra",
    });

    const disabling = second.disable(actor, "openai");
    await revocationStarted.promise;
    const reconfigure = first.configure(actor, {
      provider: "openai",
      apiKey: "sk-provider-disable-epoch-race-never-log-0002",
      modelId: "gpt-5.6-sol",
    });
    try {
      await assert.rejects(
        reconfigure,
        (error: unknown) => error instanceof LemmaComputerError && error.code === "PROVIDER_LIFECYCLE_FENCED",
      );
    } finally {
      releaseRevocation.resolve();
      await disabling;
    }

    const disabled = await secondStore.getProviderSetting(tenantId, "openai");
    assert.equal(disabled?.state, "disabled");
    assert.deepEqual(disabled?.modelIds, []);
    const reenabled = await first.configure(actor, {
      provider: "openai",
      apiKey: "sk-provider-disable-epoch-explicit-never-log-0003",
      modelId: "gpt-5.6-sol",
    });
    assert.equal(reenabled.state, "active");
  } finally {
    await pool.query("DELETE FROM provider_lifecycle_fences WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM provider_settings WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    await Promise.all([firstStore.close(), secondStore.close(), pool.end()]);
  }
});
