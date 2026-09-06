"""Control-only, secret-safe model discovery inside the credential custodian.

No model registration, inference, cloud deployment, or policy mutation occurs
here. Every upstream destination is derived from a reviewed provider protocol.
"""
import asyncio
import hashlib
import importlib.abc
import importlib.machinery
import json
import re
import secrets
import sys
from datetime import datetime, timezone
from decimal import Decimal

MODEL_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,179}$")
AZURE_ENDPOINT = re.compile(r"^https://[a-z0-9][a-z0-9-]{1,62}\.(?:openai\.azure\.com|services\.ai\.azure\.com)/openai/v1/?$")
PROVIDERS = {"openai", "anthropic", "glm", "foundry", "vertex", "bedrock"}
MAX_MODELS = 2000
PUBLIC_CATALOG = None
PUBLIC_CATALOG_AT = 0


async def refresh_metadata():
    global PUBLIC_CATALOG, PUBLIC_CATALOG_AT
    import time
    import httpx
    if time.monotonic() - PUBLIC_CATALOG_AT < 3600:
        return
    PUBLIC_CATALOG_AT = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            data = await read_json(client, "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json", {})
        if isinstance(data, dict) and all(isinstance(v, dict) for v in data.values()):
            PUBLIC_CATALOG = data
    except Exception:
        pass  # Keep the bundled metadata; exact IDs never depend on this feed.



def valid_id(value):
    return isinstance(value, str) and MODEL_ID.fullmatch(value) and not any(x in value for x in ("..", "//")) and value not in {"__proto__", "prototype", "constructor"}


def route_for(provider, model_id):
    prefix = {"glm": "zai", "vertex": "vertex_ai", "foundry": "openai", "bedrock": "bedrock/converse"}.get(provider, provider)
    return prefix + "/" + model_id


def metadata(provider, model_id, raw=None):
    import litellm
    raw = raw or {}
    route = route_for(provider, model_id)
    prices = PUBLIC_CATALOG or litellm.model_cost
    info = prices.get(route) or prices.get(model_id) or {}
    if provider == "foundry":
        info = prices.get("azure/" + model_id) or prices.get("azure_ai/" + model_id) or info
    if provider == "vertex":
        info = prices.get("vertex_ai-anthropic/" + model_id) or info
    if provider == "bedrock":
        info = prices.get("bedrock/" + model_id) or info
    result = {"id": model_id, "displayName": str(raw.get("display_name") or raw.get("displayName") or model_id)[:200],
              "source": "litellm" if info else "provider" if raw else "manual", "capabilities": {}}
    publisher = raw.get("owned_by") or raw.get("publisher")
    if isinstance(publisher, str):
        result["publisher"] = publisher[:100]
    for key, source in (("vision", "supports_vision"), ("tools", "supports_function_calling"), ("streaming", "supports_streaming")):
        if isinstance(info.get(source), bool):
            result["capabilities"][key] = info[source]
    if isinstance(info.get("mode"), str):
        result["mode"] = info["mode"][:40]
    for key, source in (("contextTokens", "max_input_tokens"), ("outputTokens", "max_output_tokens")):
        value = info.get(source)
        if isinstance(value, int) and 0 < value <= 100000000:
            result[key] = value
    for key, source in (("inputUsdPerMillion", "input_cost_per_token"), ("outputUsdPerMillion", "output_cost_per_token")):
        value = info.get(source)
        if isinstance(value, (int, float)) and 0 <= value < 1000:
            result[key] = float(Decimal(str(value)) * 1000000)
    return result


def registry_models(provider):
    import litellm
    prefixes = {"foundry": ("azure/", "azure_ai/"), "vertex": ("vertex_ai/", "vertex_ai-anthropic/"),
                "bedrock": ("bedrock/", "bedrock/converse/"), "glm": ("zai/",)}.get(provider, (provider + "/",))
    ids = set()
    for route, info in (PUBLIC_CATALOG or litellm.model_cost).items():
        if info.get("litellm_provider") == {"vertex": "vertex_ai", "glm": "zai"}.get(provider, provider) and "/" not in route and valid_id(route) and info.get("mode") in ("chat", "responses"):
            ids.add(route)
        for prefix in sorted(prefixes, key=len, reverse=True):
            if route.startswith(prefix):
                model_id = route[len(prefix):]
                if valid_id(model_id) and info.get("mode") in ("chat", "responses"):
                    ids.add(model_id)
                break
    return sorted(ids)[:MAX_MODELS]


async def read_json(client, url, headers, params=None):
    # Never follow a provider redirect with tenant credentials.
    async with client.stream("GET", url, headers=headers, params=params) as response:
        response.raise_for_status()
        chunks = bytearray()
        async for chunk in response.aiter_bytes():
            chunks.extend(chunk)
            if len(chunks) > 4 * 1024 * 1024:
                raise ValueError("Catalog response too large")
        return json.loads(chunks)


def google_token(raw):
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request
    value = json.loads(raw)
    allowed = {"type", "project_id", "private_key_id", "private_key", "client_email", "client_id", "auth_uri", "token_uri", "auth_provider_x509_cert_url", "client_x509_cert_url", "universe_domain"}
    if value.get("type") != "service_account" or value.get("token_uri") != "https://oauth2.googleapis.com/token" or set(value) - allowed:
        raise ValueError("Invalid service account")
    credentials = service_account.Credentials.from_service_account_info(value, scopes=["https://www.googleapis.com/auth/cloud-platform"])
    credentials.refresh(Request())
    return credentials.token


async def discover(provider, config, credentials, model_ids=None):
    import httpx
    await refresh_metadata()
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if provider == "vertex" and config.get("vertex", {}).get("authMethod") == "api-key":
        # The API-key endpoint has no account model-list API. Do not exchange
        # this key for OAuth credentials or send it to publisher discovery.
        ids = model_ids if model_ids is not None else registry_models(provider)
        models = [dict(metadata(provider, mid), observedAt=now) for mid in ids
                  if re.fullmatch(r"gemini-[a-zA-Z0-9._-]+", mid)]
        return {"models": models, "fetchedAt": now, "source": "litellm",
                "warning": "Showing Gemini catalog metadata. API-key access is checked when you apply your selection."}
    if model_ids is not None:
        return {"models": [dict(metadata(provider, mid), observedAt=now) for mid in model_ids], "fetchedAt": now, "source": "litellm"}
    models = {mid: metadata(provider, mid) for mid in registry_models(provider)}
    source, warning = "litellm", None
    try:
        api_key = credentials.get("api_key")
        headers, url, params = {}, None, {}
        if provider == "openai" and api_key:
            url, headers = "https://api.openai.com/v1/models", {"Authorization": "Bearer " + api_key}
        elif provider == "anthropic" and api_key:
            url, headers, params = "https://api.anthropic.com/v1/models", {"x-api-key": api_key, "anthropic-version": "2023-06-01"}, {"limit": 1000}
        elif provider == "glm" and api_key:
            url, headers = "https://api.z.ai/api/paas/v4/models", {"Authorization": "Bearer " + api_key}
        elif provider == "foundry" and api_key:
            endpoint = config.get("foundry", {}).get("endpoint", "")
            if not AZURE_ENDPOINT.fullmatch(endpoint):
                raise ValueError("Invalid endpoint")
            url, headers = endpoint.rstrip("/") + "/models", {"api-key": api_key}
        elif provider == "vertex" and credentials.get("vertex_credentials"):
            project = config.get("vertex", {}).get("projectId", "")
            if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
                raise ValueError("Invalid project")
            token = await asyncio.to_thread(google_token, credentials["vertex_credentials"])
            url = "https://us-central1-aiplatform.googleapis.com/v1/publishers/*/models"
            headers = {"Authorization": "Bearer " + token, "x-goog-user-project": project}
            params = {"listAllVersions": "true", "pageSize": 1000}
        if url:
            async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
                for _ in range(10):
                    page = await read_json(client, url, headers, params)
                    for raw in page.get("data", page.get("publisherModels", [])):
                        mid = raw.get("id")
                        if provider == "vertex":
                            match = re.fullmatch(r"publishers/([^/]+)/models/(.+)", raw.get("name", ""))
                            if not match:
                                continue
                            publisher, name = match.groups()
                            # Partner publishers use different LiteLLM transports.
                            mid = name if publisher in {"google", "anthropic", "mistralai", "ai21"} else publisher + "/" + name
                            raw = {**raw, "publisher": publisher}
                        if valid_id(mid):
                            entry = metadata(provider, mid, raw)
                            if entry.get("mode") not in (None, "chat", "responses"):
                                continue
                            models[mid] = entry
                        if len(models) >= MAX_MODELS:
                            break
                    if len(models) >= MAX_MODELS:
                        warning = "Catalog reached its display limit. Add an exact model ID if a model is missing."
                        break
                    token = page.get("nextPageToken")
                    if token:
                        params = {**params, "pageToken": token}
                    elif page.get("has_more") and page.get("last_id"):
                        params = {**params, "after_id": page["last_id"]}
                    else:
                        break
                source = "mixed"
        else:
            warning = "Showing gateway catalog metadata. Account access and regional availability are checked when you apply your selection."
    except Exception:
        # Provider exceptions may contain credentials, URLs or response bodies.
        warning = "Account discovery is unavailable. Showing gateway catalog metadata; you can also add an exact model ID."
    return {"models": [dict(v, observedAt=now) for _, v in sorted(models.items())][:MAX_MODELS], "fetchedAt": now,
            "source": source, **({"warning": warning} if warning else {})}


def register(proxy):
    from fastapi import HTTPException, Request
    from litellm.proxy.common_utils.encrypt_decrypt_utils import decrypt_value_helper
    from litellm.repositories.credentials_repository import CredentialsRepository

    async def catalog(request: Request):
        master = proxy.master_key
        auth = request.headers.get("authorization", "")
        if not isinstance(master, str) or not master or not secrets.compare_digest(auth, "Bearer " + master):
            raise HTTPException(403, "Control authorization is required")
        try:
            body = await request.body()
            if len(body) > 24000:
                raise ValueError()
            data = json.loads(body)
            if set(data) - {"tenantId", "provider", "configuration", "apiKey", "modelIds", "useSavedCredential"}:
                raise ValueError()
            provider, tenant = data["provider"], data["tenantId"]
            if provider not in PROVIDERS or not isinstance(tenant, str) or not 1 <= len(tenant) <= 256:
                raise ValueError()
            ids = data.get("modelIds")
            if ids is not None and (not isinstance(ids, list) or not 1 <= len(ids) <= 64 or not all(valid_id(mid) for mid in ids)):
                raise ValueError()
            credentials = {}
            if data.get("apiKey"):
                if not isinstance(data["apiKey"], str) or len(data["apiKey"]) > 16384:
                    raise ValueError()
                google_key = (data.get("configuration") or {}).get("vertex", {}).get("authMethod") == "api-key"
                credentials = {"vertex_credentials" if provider == "vertex" and not google_key else "api_key": data["apiKey"]}
            elif ids is None and data.get("useSavedCredential") is True:
                # Read the current encrypted row, not a possibly stale worker cache.
                import base64
                tenant_hash = base64.urlsafe_b64encode(hashlib.sha256(("lemmacomputer:provider-route:" + tenant).encode()).digest()).decode().rstrip("=")[:18]
                name = "lemmacomputer-provider-" + tenant_hash + "-" + provider
                item = await CredentialsRepository(proxy.prisma_client).find_by_name(name)
                if item:
                    credentials = {key: decrypt_value_helper(value, key, exception_type="debug") for key, value in item.credential_values.items()}
            result = await asyncio.wait_for(discover(provider, data.get("configuration") or {}, credentials, ids), timeout=45)
            from fastapi.responses import JSONResponse
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception:
            raise HTTPException(502, "Model discovery could not be completed") from None

    proxy.app.add_api_route("/lemmacomputer/model-catalog", catalog, methods=["POST"], include_in_schema=False)


class CatalogLoader(importlib.abc.Loader):
    def __init__(self, original):
        self.original = original

    def create_module(self, spec):
        return self.original.create_module(spec)

    def exec_module(self, module):
        self.original.exec_module(module)
        register(module)


class CatalogFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != "litellm.proxy.proxy_server":
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec and spec.loader:
            spec.loader = CatalogLoader(spec.loader)
        return spec


def install():
    if not any(isinstance(f, CatalogFinder) for f in sys.meta_path):
        sys.meta_path.insert(0, CatalogFinder())
