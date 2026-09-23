# AWS deployment reference design

**Status: proposal for production planning.** This repository has no reviewed
AWS infrastructure code or ECS deployment command. The supplied
[AWS diagram and short go-live path](../guides/aws-go-live.md) show a candidate,
not an assessed AWS account. Select the access mode and infrastructure design,
implement it as reviewed IaC, and qualify the live environment before calling
it production-ready.

The same product build supports customer-managed single-tenant and
LemmaComputer-hosted multi-organization profiles. Both require tenant scoping.

## Proposed placement

| Boundary | Candidate placement | Reason |
| --- | --- | --- |
| Browser entry | One public or internal HTTPS ALB to workspace ingress | One canonical origin; private service ports remain private |
| Stateless services | Separate ECS Fargate services in application subnets | Separate task roles, security groups, and deployment lifecycles |
| Controlled outbound | Separate model, remote-MCP, Microsoft, channel, and identity egress paths | Keep user-influenced destinations apart from fixed provider paths |
| Product/customer/operator state | Three logical PostgreSQL databases in a Control trust domain | Distinct roles, migration jobs, and auth boundaries |
| LiteLLM state | Separate PostgreSQL gateway trust domain | Isolate provider and OAuth credential custody |
| User workspaces | Private EC2 workspace node with node-local Docker/KasmVNC | Control uses mTLS node API, never the Docker socket |

For hosted production, put workspace compute in a separate account or at
least a separate VPC. Control records sticky workspace-to-node ownership;
it does not load-balance stateful workspace calls. See
[Workspace node](workspace-node.md) and [ADR 0006](../adr/0006-hosted-c-minus-workspace-node-placement-and-trust.md).

AWS WAF filters inbound HTTP at the ALB. Security groups restrict workload
connections. A routed firewall or approved NGFW inspects selected network
paths; the application-aware model, MCP, and workspace proxies still enforce
hostname and policy. These controls are complementary.

## Network and ingress

Choose **public hosted access** with Route 53, ACM, an internet-facing ALB,
and WAF, or **private access** with an internal ALB and the customer's VPN or
corporate network. In either mode the browser must resolve and reach the same
canonical HTTPS origin after a provider redirects it for OAuth. The ALB sends
only to workspace ingress. LiteLLM `:4000`, its administrator interface, and
the M365 bridge `:3000` have no public target group or public address.

Workspace ingress admits the exact MCP `GET /oauth/mcp/callback` and Microsoft
`GET /m365/authorize` relay paths. Register the canonical MCP callback with
connector providers. Customer login callbacks belong to embedded Better Auth;
Microsoft 365 connector consent is a separate registration. See
[MCP networking](mcp-networking.md).

Plan separate subnet classes across at least two Availability Zones:

| Class | Internet route | Intended placement |
| --- | --- | --- |
| Public ingress | Internet gateway | ALB only |
| Isolated application | No general NAT route | Ingress, Web, Control, LiteLLM, scheduler, consent |
| Controlled egress | Through reviewed inspection/NAT path | Distinct provider/MCP/M365/channel proxies or clients |
| Isolated database | None | Private PostgreSQL subnet groups |
| Workspace compute | Governed per-workspace egress only | Node, relays, sandboxes |

An isolated Fargate service still needs private paths for image pulls, logs,
and secrets. For current Fargate platforms, plan ECR API/Docker endpoints,
the S3 gateway endpoint for image layers, and endpoints for CloudWatch Logs
and Secrets Manager where those services are used. Add KMS or SSM endpoints
when the design needs them. AWS documents the
[ECR endpoint requirements](https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html).

If Network Firewall is used, route both directions through the same firewall
endpoint. [AWS documents the asymmetric-routing failure](https://docs.aws.amazon.com/network-firewall/latest/developerguide/asymmetric-routing.html).
Do not give isolated Control or LiteLLM tasks broad internet routes merely to
make an identity or connector callback work. Name the egress owner and policy
for every outbound path.

## Service and secret boundaries

Separate ECS tasks when their network or credential authority differs. In
particular, LiteLLM must not share a task network namespace with a model or
remote-MCP egress proxy. Use distinct task roles and execution roles, with
least-privilege access to only that service's images, secrets, logs, and AWS
APIs. Control-to-LiteLLM administration should use private mTLS; remote
Control-to-workspace-node calls require mTLS plus the internal application
credential.

Use distinct database runtime and migration roles. Product, customer-auth,
platform-auth, and LiteLLM are **four logical databases** in the coordinated
restore set; the first three can share a Control PostgreSQL trust domain while
the gateway uses another. Keep database instances non-public, encrypted,
backed up, and restore-tested. Application containers check schema
compatibility and do not migrate. Run explicit product, customer-auth, and
platform-auth migration jobs before the new Control service starts; include
the gateway's supported schema upgrade path in the release plan.

Store workload secrets in an approved secret manager with scoped policies and
matching backup/rotation procedures. ECS task-launch secret injection requires
a controlled new task deployment to pick up changed values. Never log or bake
secrets into images or task definitions.

## Logs and availability

Use multi-AZ placement for ingress, data, and stateless services where the
chosen availability target requires it. Pin image digests and the exact
qualified release; retain rollback images and confirm schema compatibility
before an image rollback. Scale workers only after their lease semantics are
qualified.

WAF logging can redact query strings, but that does not sanitize other log
streams. AWS ALB access logs preserve the client's request URI and can capture
an OAuth authorization code; restrict, encrypt, and review their retention and
downstream export. See [WAF log redaction](https://docs.aws.amazon.com/waf/latest/developerguide/logging-management.html)
and [ALB access-log fields](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html).
Collect service, database, network, firewall, IAM, and application audit events
with tested retention and alerts for public exposure, route drift, failed
callbacks, denied egress, secret access, and disabled logging.

## Deployment phases and release gates

1. Decide profile, public/private origin, Region, tenancy, AZ count, RTO/RPO,
   data residency, and workspace boundary. Record infrastructure choices in
   an ADR.
2. Build reviewed IaC for networking, identities, private endpoints,
   databases, secrets, logging, and backup. Test a coordinated restore.
3. Deploy private services and node integration first. Prove workload
   authentication and no-direct-egress rules before opening browser ingress.
4. Add the one canonical HTTPS ingress and exact OAuth registrations.
5. Run repository release qualification and explicit migrations, then exercise
   real sign-in, model, MCP, M365, channel, workspace, consent, and denial paths.
   Test WAF, firewall, secret rotation, logging, failure, and rollback on the
   target environment.

The repository's tests and this design do not establish live AWS route tables,
security groups, WAF, roles, restore, or provider flows. Record the exact IaC
revision, image digests, deployed settings, and observed results separately.
