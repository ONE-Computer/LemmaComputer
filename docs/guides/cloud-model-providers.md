# Model providers and dynamic discovery

Use **AI control plane → Models & routing → Connect account / Manage account**.
All six providers (OpenAI, Anthropic, Z.ai, Bedrock, Azure Foundry, Google Vertex)
accept model IDs as data. Releases do not need to enumerate each new model.
The old model profiles remain only to preserve existing route identities and
legacy metadata; they are not an allowlist for new selections.

## Select models

1. Connect using the provider's credential and resource/project/region fields.
2. Search the catalog by name or publisher, optionally filtering by capability.
3. Select models, or use **Add by model ID** for an exact provider identifier,
   including its version or inference-profile suffix.
4. For Azure, supply the actual deployment name and choose OpenAI-compatible or
   Anthropic (Claude) API format. Model names and deployment names are separate.
5. Apply changes. Existing connected accounts may leave the credential blank.
6. Review prices, configured limits, and Lite/Balanced/Pro assignments separately.

Up to 64 selected models per account are supported. Search narrows the first
100 displayed matches in a bounded catalog of up to 2,000 entries. Model IDs
are bounded, validated strings, never arbitrary gateway parameters or URLs.
Provider keys remain write-only; changing selected models does not require
re-entering a saved key. Disconnect before changing an active cloud target.

Catalogs refresh when opened after their one-hour cache expires, every hour
while the editor is open, or immediately with **Refresh models**. Refresh does
not enable models, change existing selections, rewrite rates, or publish routes.
An unavailable discovery API leaves manual entry and existing selections usable.

## Discovery and metadata sources

| Provider | Discovery | Inference configuration |
| --- | --- | --- |
| OpenAI | Account `/v1/models`, supplemented with LiteLLM metadata | `openai/<model-id>` |
| Anthropic | Paginated account `/v1/models`, supplemented with LiteLLM metadata | `anthropic/<model-id>` |
| Z.ai | Account `/api/paas/v4/models` when supported; LiteLLM fallback | `zai/<model-id>` |
| Bedrock | LiteLLM catalog; API-key credentials do not grant the IAM control-plane discovery API | `bedrock/converse/<model-or-inference-profile-id>` and configured region |
| Azure Foundry | Resource `/openai/v1/models` plus LiteLLM catalog; this does not enumerate deployment names | OpenAI: `openai/<deployment-name>` at the resource `/openai/v1/`; Claude: `anthropic/<deployment-name>` at the same resource `/anthropic` |
| Google Vertex | Model Garden publisher catalog plus LiteLLM catalog | `vertex_ai/<model-id>`; publisher-qualified IDs such as `deepseek-ai/<model-id>` use the partner transport, with project and location |

The gateway refreshes public LiteLLM metadata hourly from its official published
JSON, with the installed version's bundled metadata as an offline fallback.
This feed is discovery metadata only: refreshing it never changes active gateway
routes, prices, or protocol implementations. Account discovery and the public
metadata feed can fail independently. The UI distinguishes reference metadata
from successful access and displays unknown capabilities/limits explicitly.

Capabilities, known token limits, and reference USD prices are projected from
LiteLLM metadata. Selected metadata is snapshotted in tenant-owned settings.
Complete valid limits initialize a new deployment's configuration; existing
limits and published prices remain unchanged. Pricing starts with reference
amounts where available and still needs explicit review and publication. Public
catalog prices are not evidence of a customer's negotiated rate or regional SKU.

Discovery is not entitlement or universal protocol compatibility. Marketplace
acceptance, regional availability, quota, deployment, model-specific
authentication, and the installed LiteLLM adapter still determine usability.
The Vertex publisher catalog can contain deployable models that need dedicated
compute; this integration does not deploy compute or automatically configure
custom prediction containers. Azure deployment names remain an administrator
input unless they match the model identifier. Sovereign Azure clouds and
arbitrary gateway endpoints are outside the supported endpoint contract.

The reference gateway egress policy permits Azure resource domains, Google's
token endpoint, Vertex global plus `us-central1`, `us-east5`, `europe-west1`,
`europe-west4`, and `asia-southeast1`, and Bedrock `us-east-1`, `us-west-2`,
`eu-west-1`, and `ap-southeast-1`. Other regions also need an operator-approved
exact regional hostname in the deployment's gateway egress policy. This network
boundary is independent of model discovery and remains enforced during probes.

## Validation and custody

Control authenticates the administrator, checks `provider.manage` for the exact
provider, derives the tenant from the session, and calls the private gateway
catalog endpoint. Only the gateway master credential authorizes that endpoint.
The gateway derives the tenant credential name itself and reads/decrypts its
current encrypted database record. No decrypted saved credential returns to
Control, Web, a workspace, or a catalog cache. Preview credentials supplied in
the editor are transient and never enter product persistence or cache keys.
Disabled accounts and changed preview targets cannot reuse saved credentials.

Google intake accepts service-account JSON with a fixed Google token endpoint;
files, ambient credentials, external/executable federation, and arbitrary token
URLs remain rejected. Provider redirects are not followed. Discovery fetches
use fixed official provider hosts or a validated Azure resource hostname.

Applying selections first creates isolated candidate routes. Every selected
upstream model receives a text-inference check. New model identities that declare
tool or streaming support additionally receive a streaming check, with a forced
harmless tool call when tools are declared. Unknown capability metadata remains
unknown rather than assuming tool/vision support. A text connection check does
not qualify every model feature or native agent reasoning control.

Only after candidate validation are stable routes changed. Candidate cleanup
never deletes a reused stable credential. Existing model IDs retain their route
identities, and new IDs include a collision-resistant hash. Cloud target identity
also participates in route IDs, so another endpoint, protocol, project, or region
cannot inherit an old target's price/routing approval. All model registration and
credential lifecycle operations remain behind the existing tenant lifecycle fence.

## Migration and deployment

`01M1TBFB6H32N0HXDTRF3SM4XH_dynamic_provider_model_catalog` expands the safe
metadata constraint and bounded selection/cleanup capacities, and adds
`provider_model_catalogs` keyed by tenant and provider. It rewrites no existing
rows. Constraint changes take bounded validation locks. Both customer-managed
and hosted use this same forward-only migration and tenant-scoped store.

Deploy the gateway image and Control/Web together, using explicit migration jobs.
Older application versions cannot interpret newly selected arbitrary models;
application rollback after new selections requires restoring the matching backup
or reconciling selections to the older release's supported shape. Do not roll
back migration files or modify their checksums.

## Verification

Required commands:

- `npm run verify:quick`
- `npm run verify:db`
- `npm run test:e2e -- tests/e2e/model-routing.spec.ts`
- `npm run qualify:providers`

Provider qualification uses the pinned LiteLLM 1.93.0 image, disposable databases,
and fixture credentials. Network-disabled tests check the private catalog's
master authorization, pagination, metadata projection, redaction, and destination
boundaries, plus actual Azure OpenAI/Claude and Vertex Gemini/Claude/DeepSeek
wire translation. Cloud inference/token acquisition is mocked. This is not
live cloud entitlement, quota, or newest-model availability qualification.

## Integration references

Checked on 2026-09-06:

- [Azure resource models API](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/models)
- [Azure project deployments API](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/aiproject): a separate discovery/authentication surface from the resource API key used here.
- [Azure Claude Messages API](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude): supports the `x-api-key` header and resource Anthropic endpoint.
- [Google Model Garden listing](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-garden/use-models)
- [LiteLLM Vertex partner transports](https://docs.litellm.ai/docs/providers/vertex_partner)
- [LiteLLM model management](https://docs.litellm.ai/docs/proxy/model_management)
- [LiteLLM published model metadata](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
