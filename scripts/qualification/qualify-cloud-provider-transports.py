"""Credential-free wire-format checks against the pinned LiteLLM image.

All HTTP uses MockTransport and the container runs without networking. This
proves translation, not Azure/GCP account authorization or model availability.
"""
import asyncio
import json
from unittest.mock import patch

import httpx
import litellm
from openai import AsyncOpenAI
from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler
from litellm.llms.vertex_ai.vertex_llm_base import VertexBase

requests = []

def respond(request):
    requests.append(request)
    if request.url.host == "aiplatform.googleapis.com" and "/projects/" not in request.url.path:
        body = json.loads(request.content)
        part = {"functionCall": {"name": "record_ok", "args": {}}} if body.get("tools") else {"text": "OK"}
        payload = {"candidates": [{"content": {"role": "model", "parts": [part]}, "finishReason": "STOP", "index": 0}], "usageMetadata": {"promptTokenCount": 2, "candidatesTokenCount": 1, "totalTokenCount": 3}}
        if "streamGenerateContent" in request.url.path:
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text="data: " + json.dumps(payload) + "\n\n")
        return httpx.Response(200, json=payload)
    if "/anthropic" in request.url.path or "publishers/anthropic/" in request.url.path:
        return httpx.Response(200, json={"id": "claude-fixture", "type": "message", "role": "assistant", "model": "company-primary", "content": [{"type": "text", "text": "OK"}], "stop_reason": "end_turn", "usage": {"input_tokens": 2, "output_tokens": 1}})
    if request.url.host.endswith("openai.azure.com") or "endpoints/openapi" in request.url.path:
        return httpx.Response(200, json={"id": "azure-fixture", "object": "chat.completion", "created": 1, "model": "company-gpt", "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}})
    return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text": "OK"}]}, "finishReason": "STOP", "index": 0}], "usageMetadata": {"promptTokenCount": 2, "candidatesTokenCount": 1, "totalTokenCount": 3}})

async def fake_token(self, credentials, project_id, custom_llm_provider):
    assert credentials == '{"fixture":true}'
    assert project_id == "example-project"
    return "fixture-google-token", project_id

async def main():
    # Match production: genuine OpenAI routes use Responses, but Azure v1
    # chat routes must retain their native API and authenticated probe context.
    litellm.route_all_chat_openai_to_responses = True
    transport = httpx.MockTransport(respond)
    async with httpx.AsyncClient(transport=transport) as http_client:
        azure_client = AsyncOpenAI(api_key="fixture-azure-key", base_url="https://example-resource.openai.azure.com/openai/v1/", http_client=http_client)
        with patch("litellm.llms.azure.common_utils.AsyncOpenAI", return_value=azure_client) as azure_constructor:
            response = await litellm.acompletion(model="azure/company-gpt", messages=[{"role": "user", "content": "Reply OK"}], api_key="fixture-azure-key", api_base="https://example-resource.openai.azure.com", api_version="v1")
        assert azure_constructor.call_args.kwargs["base_url"] == "https://example-resource.openai.azure.com/openai/v1/"
        assert response.choices[0].message.content == "OK"
        assert str(requests[-1].url) == "https://example-resource.openai.azure.com/openai/v1/chat/completions"
        assert json.loads(requests[-1].content)["model"] == "company-gpt"
        assert requests[-1].headers["authorization"] == "Bearer fixture-azure-key"
        handler = AsyncHTTPHandler()
        await handler.client.aclose()
        handler.client = http_client
        google_key_params = dict(model="gemini/gemini-2.5-flash", api_key="fixture-google-api-key",
                                 api_base="https://aiplatform.googleapis.com/v1/publishers/google",
                                 messages=[{"role": "user", "content": "Reply OK"}], client=handler)
        with patch.object(VertexBase, "get_access_token_async", side_effect=AssertionError("API keys must not use ambient OAuth")):
            response = await litellm.acompletion(**google_key_params)
            assert response.choices[0].message.content == "OK"
            assert str(requests[-1].url) == "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent"
            assert requests[-1].headers["x-goog-api-key"] == "fixture-google-api-key"
            assert "authorization" not in requests[-1].headers
            response = await litellm.acompletion(**google_key_params, stream=True, tools=[{"type": "function", "function": {"name": "record_ok", "parameters": {"type": "object", "properties": {}}}}], tool_choice="required")
            chunks = [chunk async for chunk in response]
            assert any(chunk.choices and chunk.choices[0].delta.tool_calls for chunk in chunks)
            assert str(requests[-1].url) == "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
            assert requests[-1].headers["x-goog-api-key"] == "fixture-google-api-key"
        with patch.object(VertexBase, "_ensure_access_token_async", fake_token), patch.object(VertexBase, "_ensure_access_token", return_value=("fixture-google-token", "example-project")):
            response = await litellm.acompletion(model="vertex_ai/gemini-2.5-flash", messages=[{"role": "user", "content": "Reply OK"}], vertex_credentials='{"fixture":true}', vertex_project="example-project", vertex_location="global", client=handler)
        assert response.choices[0].message.content == "OK"
        assert str(requests[-1].url) == "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent"
        assert requests[-1].headers["authorization"] == "Bearer fixture-google-token"
        assert json.loads(requests[-1].content)["contents"][0]["parts"][0]["text"] == "Reply OK"
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        handler = AsyncHTTPHandler()
        handler.client = client
        response = await litellm.acompletion(model="anthropic/company-primary", api_key="azure-fixture-key", api_base="https://example-resource.services.ai.azure.com/anthropic", messages=[{"role": "user", "content": "Reply OK"}], client=handler)
        assert response.choices[0].message.content == "OK"
        assert str(requests[-1].url) == "https://example-resource.services.ai.azure.com/anthropic/v1/messages", str(requests[-1].url)
        assert json.loads(requests[-1].content)["model"] == "company-primary"
        assert requests[-1].headers["x-api-key"] == "azure-fixture-key"
        with patch.object(VertexBase, "_ensure_access_token_async", fake_token), patch.object(VertexBase, "_ensure_access_token", return_value=("fixture-google-token", "example-project")):
            response = await litellm.acompletion(model="vertex_ai/claude-sonnet-5", messages=[{"role": "user", "content": "Reply OK"}], vertex_credentials='{"fixture":true}', vertex_project="example-project", vertex_location="us-east5", client=handler)
        assert response.choices[0].message.content == "OK"
        assert "/publishers/anthropic/models/claude-sonnet-5:rawPredict" in str(requests[-1].url), str(requests[-1].url)
        with patch.object(VertexBase, "_ensure_access_token_async", fake_token), patch.object(VertexBase, "_ensure_access_token", return_value=("fixture-google-token", "example-project")):
            response = await litellm.acompletion(model="vertex_ai/deepseek-ai/deepseek-r1-0528-maas", messages=[{"role": "user", "content": "Reply OK"}], vertex_credentials='{"fixture":true}', vertex_project="example-project", vertex_location="us-central1", client=handler)
        assert response.choices[0].message.content == "OK"
        assert "/endpoints/openapi/chat/completions" in str(requests[-1].url), str(requests[-1].url)
    print("Pinned LiteLLM cloud transports passed: Azure OpenAI and Claude deployment names; Vertex Gemini, Claude and DeepSeek (mocked HTTP).")

asyncio.run(main())
