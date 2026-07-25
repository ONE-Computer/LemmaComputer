# 008: extend the egress firewall to FQDN and CIDR L3/L4 rules

Status: `planned (deferred at user request)`

Priority: P1
Depends on: 002
Unblocks: —

## Outcome

An administrator can define and attach a genuinely network-level, default-deny
egress security group. Each ordered rule can allow or deny an exact FQDN,
domain suffix, IPv4 CIDR, or IPv6 CIDR using TCP, UDP, or ICMP with the
appropriate single-port, port-range, or any-port semantics. The selected rule
is enforced outside the Kasm workspace; it is not only a browser or HTTP proxy
filter.

## In scope

- Extend the versioned egress-policy contract and UI to support typed
  destinations: exact FQDN, domain suffix, IPv4 CIDR, and IPv6 CIDR.
- Support protocol-aware rules: TCP and UDP with `any`, single-port, and
  inclusive port-range forms; ICMP with no port field.
- Add explicit ordered allow/deny actions while retaining an implicit terminal
  deny, rule priority, and immutable security-group versions.
- Preserve the existing HTTPS/HTTP experiences as compatible TCP presets where
  appropriate, without silently broadening an existing rule.
- Compile CIDR and non-web protocol rules into an external L3/L4 enforcement
  point in addition to the existing FQDN/proxy path. A workspace must not
  bypass the rule through direct sockets, alternate DNS, a sidecar, or an
  outbound tunnel.
- Show destination type, normalized destination, protocol, port semantics,
  action, precedence, workspace attachment, and effective state in the
  firewall rules table and focused create/manage flows.
- Validate and normalize IP/CIDR and FQDN input before a policy version is
  saved; explain rejected inputs in the UI and audit evidence.

## Out of scope

- Inbound firewalling, public address publishing, NAT configuration, VPN/SD-WAN,
  TLS interception, IPS, malware inspection, or a full FortiGate replacement.
- A UI-only CIDR field backed by an unenforced proxy exception.
- Allowing private, loopback, link-local, multicast, metadata, host-control,
  Docker, cross-workspace, or tenant-control destinations unless a later issue
  explicitly declares and enforces such a route.

## Required implementation

- Introduce a canonical rule schema with a destination discriminator and
  protocol-specific port representation. Migrate current domain/HTTPS rules
  deterministically and retain their effective meaning.
- Establish one ordered evaluation model: first matching rule wins, followed by
  the implicit deny. Record the matched rule/version in auditable enforcement
  decisions without logging payloads or credentials.
- Keep FQDN matching and CIDR matching separate and explicit. Protect FQDN
  resolution against DNS rebinding and prevent DNS or direct-IP traffic from
  escaping the effective group.
- Use an enforcement mechanism outside the workspace that covers TCP, UDP, and
  ICMP consistently. Unknown protocols, destinations, invalid CIDRs, failed
  DNS resolution, stale policy, and unavailable enforcement fail closed.
- Maintain tenant, owner, workspace, and security-group attachment checks;
  policy changes still require a stopped workspace and produce a new immutable
  group version.
- Provide scoped metrics/audit records for allowed, denied, invalid, and
  unmatched flows, excluding raw request bodies, credentials, and sensitive
  workspace content.

## Required verification

- [ ] Contract and migration tests show existing domain/HTTPS rules keep their
      prior behavior and are not widened.
- [ ] Validation tests cover exact FQDNs, domain suffixes, IPv4 CIDRs, IPv6
      CIDRs, malformed input, prohibited ranges, ports, ranges, and ICMP's
      lack of ports.
- [ ] A live workspace can reach an allowed TCP CIDR/port and an allowed UDP
      CIDR/port only when its attached policy permits it.
- [ ] The same workspace is denied for an unmatched CIDR, a non-matching port,
      a forbidden protocol, an invalid/unknown destination, and the implicit
      terminal deny.
- [ ] First-match ordering and explicit deny override later allow rules;
      changing ordering creates a distinct immutable version.
- [ ] Bypass probes for direct sockets, DNS changes/rebinding, literal IPs,
      proxy removal, alternate resolvers, tunnels, link-local/metadata,
      host-control, Docker, and cross-workspace routes fail closed.
- [ ] Tenant, user, workspace, and agent isolation holds for policy reads,
      writes, attachments, enforcement, and audit entries.
- [ ] Stopped/running workspace, policy update, restart, reconnect, stale
      policy, enforcement restart, concurrency, and degraded-state behavior is
      explicit and fails closed where enforcement is unavailable.
- [ ] Logs, UI screenshots, artifacts, and audit records contain no
      credentials, request/response bodies, or sensitive workspace data.

## Evidence required

- A rule-schema migration fixture and before/after effective-policy evidence.
- Redacted L3/L4 flow matrix covering allowed and denied TCP, UDP, ICMP, IPv4,
  IPv6, FQDN, and prohibited-destination cases.
- External enforcement topology inspection proving the CIDR path cannot depend
  on cooperative workspace configuration.
- A bypass-probe report with commands, expected result, actual result, and the
  matched rule or deny reason.
- A UI capture of typed destination, action, protocol, port semantics, ordered
  precedence, workspace attachment, and immutable version state.

## Stop conditions

- The available topology cannot enforce CIDR or non-web protocols outside the
  workspace without a direct bypass; do not ship the corresponding UI control.
- Product direction is needed on rule action/ordering semantics, allowed CIDR
  classes, or domain-suffix/wildcard behavior before implementation.
- Required enforcement would weaken the V2 trust invariants or expose an
  undeclared control-plane route.

## Completion record

Not complete. Deferred at the user's request on 2026-07-25.
