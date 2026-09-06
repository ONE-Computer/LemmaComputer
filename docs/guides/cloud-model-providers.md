# Cloud model providers

Azure AI Foundry (`foundry`) and Google Vertex AI (`vertex`) are configured in
**AI control plane → Models & routing → Connect account**. Both deployment
profiles use the same tenant-scoped configuration and credential lifecycle.

## Supported configuration

| Provider | Initial approved models | Required fields | LiteLLM mapping |
| --- | --- | --- | --- |
| Azure AI Foundry | GPT-4.1, GPT-4.1 mini | Azure resource OpenAI v1 endpoint, deployment name for each selected base model, resource API key | `openai/<deployment-name>` with `api_base` ending in `/openai/v1/`; encrypted `api_key` credential |
| Google Vertex AI | Gemini 2.5 Flash, Gemini 2.5 Pro | Google Cloud project ID, location, service-account JSON credential | `vertex_ai/<model-id>` with `vertex_project`, `vertex_location`; encrypted `vertex_credentials` JSON string |

Azure accepts public resource endpoints under `openai.azure.com` or
`services.ai.azure.com`, with the `/openai/v1/` path. The request's model is the
Azure **deployment name**; the reviewed base model remains separate accounting
and routing metadata. Sovereign-cloud endpoints and arbitrary gateways are not
part of this initial implementation.

Vertex requires the API enabled, appropriate service-account access to the
selected project, and model availability in the selected location. Supported
location choices are `global`, `us-central1`, `us-east5`, `europe-west1`,
`europe-west4`, and `asia-southeast1`; connection validation probes every selected
model. `global` is not a regional residency guarantee. The emissions grid is a
separate accounting assumption and does not control inference location.

The Google credential field accepts service-account JSON only. It rejects
filenames, ambient application-default credentials, user OAuth credentials,
external-account/executable federation configurations, non-Google token URLs,
and unknown fields. This keeps a tenant's configuration from selecting the
shared gateway's ambient identity or arbitrary credential sources. Managed
identity and workload identity federation need a separately governed onboarding
path; they are not enabled by leaving the credential blank.

Credentials remain write-only and are sent only to LiteLLM's private credential
API. LiteLLM encrypts them in its database; Control stores validated endpoint,
project, location, deployment selections, fingerprint, and lifecycle state.
Model records contain `litellm_credential_name`, never the raw credential.
Workspaces continue to receive scoped gateway keys and governed service classes.
This extends the existing credential-custody design; it does not implement the
separate external-secret Provider Connections work tracked in issue #15.

Re-enter the credential to rotate it or change enabled models. Disconnect before
changing the Azure endpoint/existing deployment names or Vertex project/location.
Cloud target identity participates in deployment IDs, so a different target
cannot inherit an old target's rate-card match or routing approval. Connection
success does not publish prices or assign Lite/Balanced/Pro routes: configure
pricing, model limits, routing approval, and rollout separately.

## API and LiteLLM research

Checked against official documentation on 2026-09-06:

- Microsoft recommends the [OpenAI v1-compatible route for new Foundry integrations](https://learn.microsoft.com/en-us/azure/foundry/how-to/integrate-with-other-apps).
  The older `/models` inference route is not the basis for this integration.
- [Azure deployment documentation](https://learn.microsoft.com/en-ie/azure/ai-foundry/foundry-models/how-to/create-model-deployments?view=foundry)
  identifies the deployment name as the `model` value. The v1 route does not
  require the dated `api-version` used by the older Azure OpenAI API.
- LiteLLM supports [OpenAI-compatible endpoints](https://docs.litellm.ai/docs/providers/openai_compatible),
  [Azure OpenAI's `azure/` provider](https://docs.litellm.ai/docs/providers/azure/),
  and the distinct [`azure_ai/` provider](https://docs.litellm.ai/docs/providers/azure_ai).
  This implementation deliberately uses the OpenAI-compatible v1 format.
- [Google's Vertex quickstart](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart)
  describes project/location/publisher model requests; [LiteLLM Vertex documentation](https://docs.litellm.ai/docs/providers/vertex)
  documents `vertex_ai/`, project/location configuration, and JSON credentials.
- Model capability references: [Azure model catalog](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure),
  [Gemini 2.5 Flash](https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash),
  [Gemini 2.5 Pro](https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-pro).

Foundry and Model Garden are broader catalogs than this initial approved set.
[LiteLLM Vertex partner support](https://docs.litellm.ai/docs/providers/vertex_partner)
includes Claude, Mistral, Llama and other model families with different routes.
Azure also has distinct endpoint families, including Anthropic-compatible
Claude. These are compatibility candidates, not automatically qualified product
models. Adding them requires reviewed capabilities, exact route mapping, and
transport/usage tests; no generic arbitrary-model or arbitrary-endpoint entry is
exposed here.

## Verification and deployment

`npm run qualify:providers` uses the repository-pinned LiteLLM **1.93.0** image:

- a network-disabled container checks the actual Azure v1 and Vertex Gemini
  translation using mocked HTTP and Google token acquisition;
- isolated LiteLLM/PostgreSQL services check tenant-scoped cloud credential and
  model administration, with cloud inference probes mocked;
- database dumps, read payloads, and logs are checked for credential sentinels;
- existing provider lifecycle and scoped gateway-call checks remain in place.

Run `npm run verify:quick`, `npm run verify:db`, and the focused
`npm run test:e2e -- tests/e2e/model-routing.spec.ts` for implementation changes.
The forward-only migration expands provider, lifecycle, and routing constraints
and validates cloud metadata without rewriting rows. Apply it through the
explicit migration job before starting updated Control; startup never migrates.
Older application versions do not understand these provider identifiers and may
refuse the newer schema. Prefer a forward fix; any rollback needs an explicitly
compatible application/schema plan or a tested backup restore. Do not reverse
the migration.

These checks do **not** prove a customer's Azure/GCP permissions, quotas, regional
availability, streaming/tool behavior on live models, or end-to-end agent
qualification. Those require credentialed cloud testing. Do not label this
change as a completed production cloud qualification.
