# Retired product policy evidence

The public verification key and signed Office Worker v1 envelope are retained
so historical policy and audit records can still be authenticated. They are
archival records from the retired protected-baseline implementation. Control
does not load these files at startup or apply their constraints to new
workspaces. The [historical verification test](../../../tests/product-policy-release-artifact.test.ts)
checks the signature and detects tampering.

Current workspace policy is organization-owned; Control separately signs the
runtime grant delivered to each workspace.
