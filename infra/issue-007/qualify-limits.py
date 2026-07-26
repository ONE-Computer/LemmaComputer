#!/usr/bin/env python3
"""Exercise LiteLLM key limits without printing keys or model content."""

import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.request


BASE_URL = "http://127.0.0.1:4000"
MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
ALIAS = "onecomputer-assistant"
created_keys = []


def request(path, key, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        BASE_URL + path,
        data=body,
        method="POST" if body is not None else "GET",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read()
            result = json.loads(raw) if raw else {}
            return response.status, result
    except urllib.error.HTTPError as error:
        return error.code, {}


def create_key(case, **limits):
    key = "sk-ocq-" + secrets.token_urlsafe(32)
    payload = {
        "key": key,
        "key_alias": "onecomputer-issue-007-" + case + "-" + secrets.token_hex(4),
        "key_type": "llm_api",
        "duration": limits.pop("duration", "10m"),
        "models": [ALIAS],
        "user_id": "oc-qualification-user",
        "agent_id": "oc-qualification-agent",
        "metadata": {
            "onecomputer_tenant_id": "qualification-tenant",
            "onecomputer_subject_id": "qualification-user",
            "onecomputer_workspace_id": "qualification-workspace",
            "onecomputer_agent_id": "qualification-agent",
            "onecomputer_policy_version_id": "qualification-policy-007",
        },
        **limits,
    }
    status, _ = request("/key/generate", MASTER_KEY, payload)
    if status != 200:
        raise RuntimeError("qualification key generation failed with status " + str(status))
    created_keys.append(key)
    return key


def model_call(key, stream=False):
    marker = hashlib.sha256(os.urandom(32)).hexdigest()[:12]
    payload = {
        "model": ALIAS,
        "messages": [{"role": "user", "content": "Return only this synthetic marker: " + marker}],
        "max_completion_tokens": 32,
        "store": False,
        "stream": stream,
    }
    status, _ = request("/v1/chat/completions", key, payload)
    return status


def delete_key(key):
    request("/key/delete", MASTER_KEY, {"keys": [key]})
    if key in created_keys:
        created_keys.remove(key)


def main():
    results = {}
    try:
        revoked = create_key("revoked", rpm_limit=10, tpm_limit=1000)
        delete_key(revoked)
        results["revokedStatus"] = model_call(revoked)

        expired = create_key("expired", duration="1s", rpm_limit=10, tpm_limit=1000)
        time.sleep(2)
        results["expiredStatus"] = model_call(expired)

        token_limited = create_key("token", rpm_limit=10, tpm_limit=1)
        results["tokenLimitStatus"] = model_call(token_limited)

        rate_limited = create_key("rate", rpm_limit=1, tpm_limit=1000)
        results["rateFirstStatus"] = model_call(rate_limited)
        results["rateSecondStatus"] = model_call(rate_limited)
        print(json.dumps(results, sort_keys=True))
    finally:
        for key in list(created_keys):
            delete_key(key)


if __name__ == "__main__":
    main()
