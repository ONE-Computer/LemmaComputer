import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresProviderSettingsStore } from "@onecomputer/workspace-store";

const connectionString = process.env.PROVIDER_SETTINGS_TEST_DATABASE_URL;

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
