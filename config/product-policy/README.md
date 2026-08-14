# Legacy product policy artifacts

The files in this directory are retained only to verify and interpret policy
history written by the retired protected-baseline implementation. They are not
loaded during Control startup and do not restrict a new or existing
organization.

A new organization has no organization workspace policy. All product-supported
workspace profiles, agents, applications, and service levels are available by
default. An owner or administrator with `policy.manage` may create the first
organization policy, then append later immutable versions. The newest
organization-owned version applies to every member of that organization; there
is no separate per-member protected-policy assignment.

No product-release signer is required to create or edit an organization policy.
The historical public key and signed v1 envelope remain checked in so old audit
records can still be authenticated. They must not be treated as an active
ceiling or reintroduced into runtime policy resolution.

This retirement is intentionally separate from runtime workspace grant
signing. Control still signs the concrete runtime policy bundle delivered to a
workspace so the controller and egress services can verify that grant.
