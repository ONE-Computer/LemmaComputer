# Agent instance identity contract

`agent_id` is the stable catalogue/policy identity. `agent_instance_id` is the server-generated UUID for one actual agent execution. Consumers must not substitute one for the other.

Control creates an instance before browser, channel, scheduled, CLI, or Desktop execution. The runtime may supply only a launch nonce; it never supplies the UUID. A reconnect to a still-running Desktop or CLI process keeps the same UUID, while a new process launch receives a new UUID.

The authoritative record is `agent_instances`, tenant-scoped by tenant, owner, workspace, and access generation. It snapshots catalogue and logical agent identities, signed policy version/hash, workspace image evidence when available, provider/process identity, lifecycle timestamps, bounded termination reason, and cleanup evidence.

The canonical correlation field for #63 is `agent_instance_id`:

- `activity_events.agent_instance_id`
- `governed_operations.agent_instance_id` (and therefore its approval and receipt chain)
- `ai_usage_attempt_admissions.agent_instance_id`
- `McpPolicyRequest.agentInstanceId` and signed `UsageTaskBinding.agentInstanceId`

New tool and usage paths validate that the UUID is running and matches tenant, owner, workspace, access generation, and logical agent before accepting it. Unknown, stale, forged, cross-workspace, and cross-tenant values fail closed. Historical rows retain `NULL`, represented as `legacy_no_instance`; no identity is fabricated.

Restart, stop, and terminate close all active records for the owned workspace with their respective bounded reason. Reconciliation closes stale pre-start launches and records running processes whose cleanup cannot be confirmed as `reconciled_abandoned` plus `PROCESS_CLEANUP_UNCONFIRMED`.

Long-lived Kasm/VNC containers, loopback brokers, chat adapters, and the Hermes gateway are infrastructure processes, not agent instances. Their request-local or child agent executions carry the UUID.
