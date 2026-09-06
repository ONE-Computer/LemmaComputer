"""Network-disabled tests of the actual pinned gateway discovery boundary."""
import asyncio
import json
import sys
from unittest.mock import patch

sys.path.insert(0, "/catalog")
import lemmacomputer_model_catalog as catalog
catalog.install()
import litellm
import litellm.proxy.proxy_server as proxy
import httpx

async def main():
    assert any(route.path == "/lemmacomputer/model-catalog" for route in proxy.app.routes)
    proxy.master_key = "catalog-qualification-master"
    headers = {"Authorization": "Bearer " + proxy.master_key}
    source = {"vertex_ai/claude-sonnet-5": {"mode": "chat", "supports_function_calling": True, "max_input_tokens": 200000},
              "openai/gpt-future": {"mode": "chat", "input_cost_per_token": 0.000002}}
    catalog.PUBLIC_CATALOG = source
    async def no_refresh():
        pass
    with patch.object(catalog, "refresh_metadata", no_refresh):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=proxy.app), base_url="http://gateway") as client:
            body = {"tenantId": "tenant-alpha", "provider": "vertex", "modelIds": ["claude-sonnet-5", "deepseek-ai/future"]}
            assert (await client.post("/lemmacomputer/model-catalog", json=body)).status_code == 403
            assert (await client.post("/lemmacomputer/model-catalog", json=body, headers={"Authorization": "Bearer workspace-key"})).status_code == 403
            response = await client.post("/lemmacomputer/model-catalog", json=body, headers=headers)
            assert response.status_code == 200, response.text
            data = response.json()
            assert data["models"][0]["capabilities"]["tools"] is True
            assert "outputTokens" not in data["models"][0]
            assert data["models"][1]["source"] == "manual"
            for bad in ["../secrets", "https://attacker.test", "__proto__"]:
                response = await client.post("/lemmacomputer/model-catalog", json={**body, "modelIds": [bad]}, headers=headers)
                assert response.status_code == 502
                assert bad not in response.text

        requested = []
        async def read(client, url, headers, params=None):
            requested.append((url, headers, params))
            if "raw.githubusercontent" in url:
                raise AssertionError("Public metadata refresh was disabled")
            if params and params.get("after_id"):
                return {"data": [{"id": "claude-opus-5", "display_name": "Claude Opus 5"}]}
            return {"data": [{"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5"}], "has_more": True, "last_id": "claude-sonnet-5"}
        with patch.object(catalog, "read_json", read):
            result = await catalog.discover("anthropic", {}, {"api_key": "sentinel-provider-secret"})
            assert len(requested) == 2
            assert requested[0][0] == "https://api.anthropic.com/v1/models"
            assert requested[0][1]["x-api-key"] == "sentinel-provider-secret"
            assert {model["id"] for model in result["models"]} >= {"claude-sonnet-5", "claude-opus-5"}
            assert "sentinel-provider-secret" not in json.dumps(result)
            requested.clear()
            result = await catalog.discover("foundry", {"foundry": {"endpoint": "http://127.0.0.1/secrets"}}, {"api_key": "sentinel-provider-secret"})
            assert not requested
            assert "warning" in result
            assert "sentinel-provider-secret" not in json.dumps(result)
        for credential in [{"type": "external_account", "credential_source": {"executable": {"command": "bad"}}}, {"type": "service_account", "token_uri": "https://attacker.test"}]:
            try:
                catalog.google_token(json.dumps(credential))
                raise AssertionError("Unsafe Google credential accepted")
            except ValueError:
                pass
    print("Pinned catalog endpoint: master authorization, model metadata, pagination, unknown metadata, secret redaction and destination boundaries passed.")

asyncio.run(main())
