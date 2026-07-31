import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { OneComputerError } from "@onecomputer/contracts";
import { PostgresTeamStore } from "@onecomputer/workspace-store";

const connectionString = process.env.TEAM_TEST_DATABASE_URL;

test("PostgreSQL Teams preserve tenant boundaries, default history, and permission independence", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString });
  const first = PostgresTeamStore.fromConnectionString(connectionString!);
  const second = PostgresTeamStore.fromConnectionString(connectionString!);
  const suffix = crypto.randomUUID();
  const tenantId = `team-tenant-${suffix}`;
  const outsiderTenantId = `team-outsider-${suffix}`;
  const administratorId = `team-admin-${suffix}`;
  const memberId = `team-member-${suffix}`;
  const otherMemberId = `team-other-member-${suffix}`;
  const outsiderId = `team-outsider-user-${suffix}`;
  try {
    await pool.query(
      `INSERT INTO tenants (id,external_tenant_id,display_name)
       VALUES ($1,$2,'Team tenant'),($3,$4,'Outsider tenant')`,
      [tenantId, `external-${tenantId}`, outsiderTenantId, `external-${outsiderTenantId}`],
    );
    await pool.query(
      `INSERT INTO users (id,tenant_id,email,display_name)
       VALUES
         ($1,$4,$5,'Team Administrator'),
         ($2,$4,$6,'Team Member'),
         ($3,$4,$7,'Other Team Member'),
         ($8,$9,$10,'Outsider')`,
      [
        administratorId,
        memberId,
        otherMemberId,
        tenantId,
        `${administratorId}@example.test`,
        `${memberId}@example.test`,
        `${otherMemberId}@example.test`,
        outsiderId,
        outsiderTenantId,
        `${outsiderId}@example.test`,
      ],
    );
    await pool.query(
      `INSERT INTO user_roles (user_id,role,assigned_by)
       VALUES ($1,'employee',$1),($1,'administrator',$1),($2,'employee',$1),($3,'employee',$1),($4,'employee',$4)`,
      [administratorId, memberId, otherMemberId, outsiderId],
    );
    const permissionBaseline = await pool.query(
      `SELECT
         (SELECT count(*) FROM user_roles WHERE user_id=$1)::integer AS roles,
         (SELECT count(*) FROM policy_assignments WHERE tenant_id=$2 AND user_id=$1)::integer AS policies,
         (SELECT count(*) FROM capability_assignments ca
           JOIN policy_assignments pa ON pa.id=ca.policy_assignment_id
           WHERE pa.tenant_id=$2 AND pa.user_id=$1)::integer AS capabilities`,
      [memberId, tenantId],
    );

    const finance = await first.createTeam({
      tenantId,
      createdBy: administratorId,
      displayName: "Finance",
      description: "Finance allocation",
      ownerUserId: administratorId,
      costCenterCode: "CC-100",
    });
    assert.equal(finance.displayName, "Finance");
    assert.equal(finance.costCenterCode, "CC-100");

    await assert.rejects(
      first.updateTeam({
        tenantId,
        teamId: finance.id,
        updatedBy: administratorId,
        displayName: "  unallocated  ",
      }),
      (error) => error instanceof OneComputerError && error.code === "TEAM_NAME_RESERVED",
    );
    await assert.rejects(
      pool.query("UPDATE allocation_units SET display_name='Unallocated' WHERE tenant_id=$1 AND id=$2", [tenantId, finance.id]),
      (error) => Boolean(error && typeof error === "object" && "code" in error && error.code === "23514"),
    );

    const renamed = await first.updateTeam({
      tenantId,
      teamId: finance.id,
      updatedBy: administratorId,
      displayName: "Finance and Operations",
      ownerUserId: otherMemberId,
    });
    assert.equal(renamed.displayName, "Finance and Operations");
    assert.equal(renamed.ownerUserId, otherMemberId);
    await assert.rejects(
      first.updateTeam({
        tenantId,
        teamId: finance.id,
        updatedBy: administratorId,
        displayName: "Unallocated",
      }),
      (error) => error instanceof OneComputerError && error.code === "TEAM_NAME_RESERVED",
    );

    const engineering = await first.createTeam({
      tenantId,
      createdBy: administratorId,
      displayName: "Engineering",
      description: "Engineering allocation",
      ownerUserId: administratorId,
      costCenterCode: null,
    });
    const research = await first.createTeam({
      tenantId,
      createdBy: administratorId,
      displayName: "Research",
      description: "Research allocation",
      ownerUserId: administratorId,
      costCenterCode: "CC-300",
    });

    const noDefaultTeam = await first.createTeam({
      tenantId,
      createdBy: administratorId,
      displayName: "Temporary allocation",
      description: "Archived before use",
      ownerUserId: administratorId,
      costCenterCode: null,
    });
    await first.archiveTeam({ tenantId, teamId: noDefaultTeam.id, archivedBy: administratorId });
    assert.equal((await pool.query(
      "SELECT id FROM allocation_units WHERE tenant_id=$1 AND is_rollout_fallback AND status='active'",
      [tenantId],
    )).rowCount, 0);
    assert.equal(await first.getCurrentDefaultSpendingTeam(tenantId, otherMemberId), null);

    const future = new Date(Date.now() + 60_000);
    await assert.rejects(
      first.assignMembership({ tenantId, teamId: finance.id, userId: otherMemberId, assignedBy: administratorId, effectiveFrom: future }),
      (error) => error instanceof OneComputerError && error.code === "TEAM_MEMBERSHIP_FUTURE_UNSUPPORTED",
    );
    await assert.rejects(
      first.setDefaultSpendingTeam({ tenantId, teamId: finance.id, userId: otherMemberId, assignedBy: administratorId, effectiveFrom: future }),
      (error) => error instanceof OneComputerError && error.code === "TEAM_DEFAULT_FUTURE_UNSUPPORTED",
    );

    const initialMembership = await first.assignMembership({
      tenantId,
      teamId: finance.id,
      userId: memberId,
      assignedBy: administratorId,
      makeDefault: true,
    });
    assert.equal(initialMembership.isDefaultSpendingTeam, true);
    const existingDefaultMembership = await first.assignMembership({
      tenantId,
      teamId: finance.id,
      userId: memberId,
      assignedBy: administratorId,
    });
    assert.equal(existingDefaultMembership.isDefaultSpendingTeam, true);
    await first.assignMembership({
      tenantId,
      teamId: engineering.id,
      userId: memberId,
      assignedBy: administratorId,
    });
    await first.setDefaultSpendingTeam({
      tenantId,
      teamId: engineering.id,
      userId: memberId,
      assignedBy: administratorId,
    });
    assert.equal(await first.removeMembership({
      tenantId,
      teamId: finance.id,
      userId: memberId,
      removedBy: administratorId,
    }), true);
    const financeHistory = (await first.getTeam(tenantId, finance.id))!.memberships;
    assert.equal(financeHistory.length, 1);
    assert.ok(financeHistory[0]!.effectiveTo);
    assert.equal(financeHistory[0]!.isDefaultSpendingTeam, false);

    await Promise.all([
      first.setDefaultSpendingTeam({
        tenantId,
        teamId: research.id,
        userId: memberId,
        assignedBy: administratorId,
      }),
      second.setDefaultSpendingTeam({
        tenantId,
        teamId: engineering.id,
        userId: memberId,
        assignedBy: administratorId,
      }),
    ]);
    const activeDefaults = await pool.query(
      `SELECT allocation_unit_id FROM default_spending_team_assignments
       WHERE tenant_id=$1 AND user_id=$2 AND effective_to IS NULL`,
      [tenantId, memberId],
    );
    assert.equal(activeDefaults.rowCount, 1);
    const defaultHistory = await pool.query(
      `SELECT allocation_unit_id,effective_from,effective_to
       FROM default_spending_team_assignments
       WHERE tenant_id=$1 AND user_id=$2 ORDER BY effective_from`,
      [tenantId, memberId],
    );
    assert.ok((defaultHistory.rowCount ?? 0) >= 3);
    assert.equal(defaultHistory.rows.filter((row) => row.effective_to === null).length, 1);

    assert.equal(await first.getTeam(outsiderTenantId, finance.id), null);
    await assert.rejects(
      first.updateTeam({
        tenantId: outsiderTenantId,
        teamId: finance.id,
        updatedBy: outsiderId,
        displayName: "Stolen",
      }),
      (error) => error instanceof OneComputerError && error.code === "TEAM_NOT_FOUND",
    );
    await assert.rejects(
      first.createTeam({
        tenantId,
        createdBy: administratorId,
        displayName: "Cross tenant",
        description: "",
        ownerUserId: outsiderId,
        costCenterCode: "OUTSIDER-CODE",
      }),
      (error) => error instanceof OneComputerError && error.code === "TEAM_OWNER_NOT_FOUND",
    );
    await assert.rejects(
      first.assignMembership({
        tenantId: outsiderTenantId,
        teamId: finance.id,
        userId: outsiderId,
        assignedBy: outsiderId,
      }),
      (error) => error instanceof OneComputerError && error.code === "TEAM_NOT_FOUND",
    );
    await assert.rejects(
      first.setDefaultSpendingTeam({
        tenantId: outsiderTenantId,
        teamId: finance.id,
        userId: outsiderId,
        assignedBy: outsiderId,
      }),
      (error) => error instanceof OneComputerError && error.code === "TEAM_NOT_FOUND",
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO allocation_memberships (
           id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by
         ) VALUES ($1,$2,$3,$4,now(),$4)`,
        [crypto.randomUUID(), outsiderTenantId, finance.id, outsiderId],
      ),
      (error) => error instanceof Error
        && "code" in error
        && (error as Error & { code?: string }).code === "23503",
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO default_spending_team_assignments (
           id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by
         ) VALUES ($1,$2,$3,$4,now(),$4)`,
        [crypto.randomUUID(), outsiderTenantId, finance.id, outsiderId],
      ),
      (error) => error instanceof Error
        && "code" in error
        && (error as Error & { code?: string }).code === "23503",
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO allocation_memberships (
           id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by
         ) VALUES ($1,$2,$3,$4,now(),$5)`,
        [crypto.randomUUID(), tenantId, finance.id, outsiderId, administratorId],
      ),
      (error) => error instanceof Error
        && "code" in error
        && (error as Error & { code?: string }).code === "23503",
    );
    assert.equal((await first.listTeams(outsiderTenantId, true)).some((team) => team.costCenterCode === "CC-100"), false);

    const [fallback, administratorFallback] = await Promise.all([
      first.resolveDefaultSpendingTeam({ tenantId, userId: otherMemberId, actorUserId: administratorId }),
      second.resolveDefaultSpendingTeam({ tenantId, userId: administratorId, actorUserId: administratorId }),
    ]);
    assert.equal(fallback.displayName, "Unallocated");
    assert.equal(fallback.isRolloutFallback, true);
    assert.equal(administratorFallback.id, fallback.id);
    assert.equal((await pool.query(
      "SELECT id FROM allocation_units WHERE tenant_id=$1 AND is_rollout_fallback AND status='active'",
      [tenantId],
    )).rowCount, 1);

    const membershipRaceTeam = await first.createTeam({
      tenantId,
      createdBy: administratorId,
      displayName: "Membership race",
      description: "",
      ownerUserId: administratorId,
      costCenterCode: null,
    });
    const membershipRace = await Promise.allSettled([
      first.archiveTeam({ tenantId, teamId: membershipRaceTeam.id, archivedBy: administratorId }),
      second.assignMembership({
        tenantId,
        teamId: membershipRaceTeam.id,
        userId: otherMemberId,
        assignedBy: administratorId,
      }),
    ]);
    assert.equal(membershipRace[0].status, "fulfilled");
    if (membershipRace[1].status === "rejected") {
      assert.ok(
        membershipRace[1].reason instanceof OneComputerError
        && membershipRace[1].reason.code === "TEAM_NOT_FOUND",
      );
    }
    assert.equal((await pool.query(
      `SELECT count(*)::integer AS count FROM allocation_memberships
       WHERE tenant_id=$1 AND allocation_unit_id=$2 AND effective_to IS NULL`,
      [tenantId, membershipRaceTeam.id],
    )).rows[0].count, 0);

    const defaultRaceTeam = await first.createTeam({
      tenantId,
      createdBy: administratorId,
      displayName: "Default race",
      description: "",
      ownerUserId: administratorId,
      costCenterCode: null,
    });
    const defaultRace = await Promise.allSettled([
      first.archiveTeam({ tenantId, teamId: defaultRaceTeam.id, archivedBy: administratorId }),
      second.setDefaultSpendingTeam({
        tenantId,
        teamId: defaultRaceTeam.id,
        userId: memberId,
        assignedBy: administratorId,
      }),
    ]);
    assert.equal(defaultRace[0].status, "fulfilled");
    if (defaultRace[1].status === "rejected") {
      assert.ok(
        defaultRace[1].reason instanceof OneComputerError
        && defaultRace[1].reason.code === "TEAM_NOT_FOUND",
      );
    }
    assert.equal((await pool.query(
      `SELECT count(*)::integer AS count FROM default_spending_team_assignments
       WHERE tenant_id=$1 AND allocation_unit_id=$2 AND effective_to IS NULL`,
      [tenantId, defaultRaceTeam.id],
    )).rows[0].count, 0);

    const currentDefaultId = String(activeDefaults.rows[0]!.allocation_unit_id);
    const archived = await first.archiveTeam({
      tenantId,
      teamId: currentDefaultId,
      archivedBy: administratorId,
    });
    assert.equal(archived.status, "archived");
    assert.ok(archived.memberships.some((membership) => membership.userId === memberId));
    assert.ok(archived.memberships.every((membership) => membership.effectiveTo));
    const afterArchive = await first.resolveDefaultSpendingTeam({
      tenantId,
      userId: memberId,
      actorUserId: administratorId,
    });
    assert.equal(afterArchive.id, fallback.id);

    const permissionAfter = await pool.query(
      `SELECT
         (SELECT count(*) FROM user_roles WHERE user_id=$1)::integer AS roles,
         (SELECT count(*) FROM policy_assignments WHERE tenant_id=$2 AND user_id=$1)::integer AS policies,
         (SELECT count(*) FROM capability_assignments ca
           JOIN policy_assignments pa ON pa.id=ca.policy_assignment_id
           WHERE pa.tenant_id=$2 AND pa.user_id=$1)::integer AS capabilities`,
      [memberId, tenantId],
    );
    assert.deepEqual(permissionAfter.rows[0], permissionBaseline.rows[0]);

    const audit = await first.listAuditEvents(tenantId);
    assert.ok(audit.some((event) => event.action === "team.created"));
    assert.ok(audit.some((event) => event.action === "default_spending_team.changed"));
    const serializedAudit = JSON.stringify(audit);
    assert.equal(serializedAudit.includes("Finance and Operations"), false);
    assert.equal(serializedAudit.includes("CC-100"), false);
  } finally {
    await Promise.all([first.close(), second.close(), pool.end()]);
  }
});
