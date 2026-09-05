# Model deployment limits

Organization administrators can select a model in **Models & routing**, then
choose **Model limits → Edit**. Enter the provider deployment's actual context
window and maximum output in tokens; these are capacity declarations, not a way
to purchase or enlarge a model's context window. Output must be smaller than the
context window. Existing route values prefill the editor; unknown values remain
blank rather than being inferred from a product tier.

The metadata belongs to the tenant's concrete provider deployment. It is stored
without credentials and survives provider-key rotation. An unassigned model can
be configured before it is priced or assigned. Existing route drafts must be
saved or discarded before limits can be edited.

Saving a routed model republishes the organization mapping with the stored
limits, preserves its billing currency, and uses the existing route activation
and workspace restart flow. Running workspaces can be interrupted; the dialog
discloses this before saving. A partial activation failure is reported separately
from successful metadata storage and can be retried by saving again. Future
mapping saves apply stored limits even if a client's route draft is stale.

Control projects allowed tier limits into signed runtime policy. The workspace
broker exposes them in model discovery for every agent. Hermes receives
per-alias context metadata, enables its native compression, and uses the main
governed route for summarization. Its global output setting uses the smallest
allowed output ceiling so switching tiers cannot inherit an oversized setting.
Other harnesses retain their native context-management behavior; advertising
metadata does not guarantee a third-party harness consumes it. Routing always
enforces the selected deployment's limits, including room for the response.

## Deployment

Apply the forward-only `allow_provider_model_limits` migration through the normal
explicit migration job. It expands the provider JSON allowlist and validates the
new numeric metadata, without rewriting existing rows or storing secrets.
Build/deploy the Web and Control services and a new workspace image together.
Existing workspace containers need the new image on their next start to receive
the Hermes configuration and broker metadata changes. Do not roll Control back
to a reader that predates the new metadata after administrators have saved limits.

Both hosted and customer-managed profiles use the same tenant-scoped records,
validation, migration, and runtime projection. No live provider maximum is probed
or silently assumed to be one million tokens.
