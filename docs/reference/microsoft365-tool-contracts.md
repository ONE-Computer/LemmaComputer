# Microsoft 365 agent tool contracts

LemmaComputer does not expose the broad schema published by
`@softeria/ms-365-mcp-server` directly to workspace agents. The managed
connector bridge projects contract version 1 for the 38 tools in
`m365ToolCatalog`; Control independently validates the same bounded calls
before Microsoft Graph execution.

This contract is identical in customer-managed, hosted, and development
worktree deployments. Claude Desktop, Claude CLI, Codex CLI, Hermes Desktop,
and Hermes CLI all discover it through
`lemmacomputer-connectors-stdio.py`. An upstream Microsoft 365 tool that lacks
a reviewed profile is omitted from discovery and cannot be called.

## Qualified surface

| Service | Read workflow | Protected write workflow |
| --- | --- | --- |
| Outlook mail | list folders and recent messages, then read by `messageId` | draft, update, move, send, reply, forward, or delete with resolved IDs and strictly typed message bodies |
| Calendar | list calendars or series, or read occurrences using an explicit `startDateTime` and `endDateTime` window | create, update, or delete with resolved IDs, explicit timezone-bearing start/end values, and bounded event fields |
| OneDrive | resolve a drive and item, search by a bounded filename query, and read exact metadata | create, upload, move, copy, or delete using resolved IDs and governed human-facing audit metadata |
| Teams | resolve chats, teams, channels, and messages in sequence | send or reply using resolved IDs and a bounded HTML message body |

Raw OData `filter`, `search`, `orderby`, `skip`, and `count` fields are not
part of the agent contract. Neither are Graph paths, arbitrary headers,
unbounded pagination, or upstream response-shaping flags. The few constant
metadata fields used by a governed workflow, such as the exact OneDrive
`select=id,name,eTag,parentReference` value, are enumerated rather than free
form.

Calendar `get-calendar-view` accepts only:

- `startDateTime` and `endDateTime` as explicit ISO 8601 values with an offset;
- optional `timezone`; and
- optional bounded `top`.

The window must be ordered and no longer than 93 days. A request for today's
calendar therefore requires one canonical tool call, not trial-and-error OData
generation.

## Failure contract

Control rejects invalid arguments before provider execution where possible.
The policy response and workspace bridge expose only a bounded category,
optional field name, safe corrective message, and retryability flag. Categories
are `invalid_argument`, `unsupported_option`, `authentication_failure`,
`policy_denial`, `provider_rejection`, `timeout`, and `unknown_failure`.
Argument values, provider payloads, credentials, and personal Microsoft 365
content are never included in this diagnostic metadata.

The request-local agent process identity is carried in reserved MCP metadata at
`params._meta.lemmacomputer.agentInstanceId`. The bridge accepts only a
canonical lowercase UUIDv4, captures it before dispatching the concurrent tool
call, and forwards it in `x-lemmacomputer-agent-instance-id`. A malformed
present value fails closed. Startup environment identity remains a compatibility
fallback for the existing per-process Claude and Codex bridges.

## Review and dependency upgrades

The Softeria dependency remains exactly pinned in
`integrations/ms365-mcp/package.json` and its lockfile. Evidence in
`config/product-policy/microsoft365-tool-contract-evidence.v1.json` records two
independent boundaries:

1. hashes of each pinned upstream endpoint definition; and
2. hashes of the effective workspace projection and Control schemas.

Run the credential-free qualification after installing the pinned connector:

```bash
npm ci --prefix integrations/ms365-mcp
npm run qualify:microsoft365-contracts
```

Any upstream or LemmaComputer contract change fails qualification. Review the
definition and capability diff, update the affected focused fixtures, increment
the contract version for an incompatible agent-facing change, then explicitly
regenerate the evidence:

```bash
npm run qualify:microsoft365-contracts -- --write
npm run qualify:microsoft365-contracts
```

Do not regenerate evidence merely to make a failure pass.

## Safe live read qualification

Static and credential-free tests cannot establish that a real delegated
Microsoft connection is healthy. For release qualification, connect a test
account, create a disposable workspace, select each of Claude, Codex, and
Hermes in turn, and request “show my calendar today” in the account's trusted
timezone. The Activity record must show exactly one
`Microsoft365 get calendar view` action and no failed attempts. Retain only the
tool name, contract/evidence hashes, outcome, and timestamp; do not export event
content. A write qualification uses a disposable draft and still requires the
normal signed approval path.
