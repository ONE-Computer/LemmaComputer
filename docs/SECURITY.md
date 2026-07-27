# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/ONE-Computer/onecomputer/security/advisories/new).
Do not include provider keys, OAuth tokens, employee data, approval documents,
database dumps, or other live secrets in the report. Use synthetic evidence and
offer to share sensitive details through an agreed secure channel.

Include, when possible:

- affected commit or release;
- impacted service and trust boundary;
- prerequisites and a minimal reproduction;
- expected and observed behavior;
- impact, including credential, tenant, workspace, or approval scope;
- suggested mitigation.

Do not open a public issue until maintainers confirm that disclosure is safe.

## High-impact areas

Reports are especially valuable for:

- provider, OAuth, signing, channel, or infrastructure credential exposure;
- cross-tenant, cross-user, or cross-workspace access;
- signed-policy bypass or projection mismatch;
- MCP policy fail-open behavior;
- OpenVTC proof, identity, expiry, or operation-binding bypass;
- execution-lease replay or argument substitution;
- egress policy or DNS/SNI bypass;
- workspace escape or unauthorized Docker/Kasm access;
- sensitive prompt, response, argument, callback, or token logging.

## Deployment responsibility

The root Compose stack is a loopback-bound reference deployment. Operators are
responsible for TLS, reverse-proxy authentication, secret management, database
security, backups, network policy, monitoring, and incident response before
network exposure. Review
[Production considerations](operations.md#production-considerations).
