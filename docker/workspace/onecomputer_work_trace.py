"""Sanitized, provider-neutral helpers for ONEComputer's user-visible work trace."""

from __future__ import annotations

import ipaddress
import re
from pathlib import PurePath
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


MAX_TRACE_TEXT = 500
MAX_SOURCE_COUNT = 12
MARKDOWN_LINK = re.compile(r"\[([^\]\n]{1,240})\]\((https?://[^\s)<>]+)\)", re.IGNORECASE)
RAW_URL = re.compile(r"https?://[^\s<>()\[\]{}\"']+", re.IGNORECASE)
MARKDOWN_MARKER = re.compile(r"(?m)^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)")
SENSITIVE_QUERY_KEY = re.compile(r"^(?:access_token|api[_-]?key|awsaccesskeyid|code|credential|key|password|refresh_token|sig|signature|token|x-amz-.+|x-goog-.+)$", re.IGNORECASE)


def safe_trace_text(value: object, maximum: int = MAX_TRACE_TEXT) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.replace("[ONECOMPUTER_NEEDS_INPUT]", "")
    text = MARKDOWN_LINK.sub(lambda match: match.group(1), text)
    text = MARKDOWN_MARKER.sub("", text)
    text = re.sub(r"[*_`~]+", "", text)
    text = " ".join(text.split()).strip()
    text = RAW_URL.sub(lambda match: safe_http_url(match.group(0)) or "[redacted-url]", text)
    text = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", "Bearer [redacted]", text, flags=re.IGNORECASE)
    text = re.sub(
        r"\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b",
        "[redacted-secret]", text, flags=re.IGNORECASE,
    )
    return text[:maximum] or None


def safe_http_url(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > 2_048:
        return None
    candidate = value.rstrip(".,;:!?")
    try:
        parsed = urlsplit(candidate)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username or parsed.password:
            return None
        hostname = parsed.hostname.lower().rstrip(".")
        if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
            return None
        try:
            address = ipaddress.ip_address(hostname)
            if not address.is_global:
                return None
        except ValueError:
            pass
        safe_query = urlencode([(key, item) for key, item in parse_qsl(parsed.query, keep_blank_values=True) if not SENSITIVE_QUERY_KEY.match(key)])
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, safe_query, ""))
    except ValueError:
        return None


def normalized_tool_name(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")


def humanize_tool_name(value: object) -> str:
    name = str(value or "workspace tool")
    name = name.replace("mcp__onecomputer_connectors__", "")
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name)
    name = re.sub(r"[_:.-]+", " ", name)
    return " ".join(name.split()).strip().capitalize() or "Workspace tool"


def _first_string(value: object, keys: tuple[str, ...]) -> str | None:
    if not isinstance(value, dict):
        return None
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
        if isinstance(candidate, list):
            strings = [item.strip() for item in candidate if isinstance(item, str) and item.strip()]
            if strings:
                return ", ".join(strings)
    return None


def web_action_for_tool(name: object, arguments: object) -> dict[str, str] | None:
    normalized = normalized_tool_name(name)
    compact = normalized.replace("_", "")
    is_search = (
        normalized in {"search", "web_search", "search_query"}
        or compact in {"websearch", "searchquery"}
        or normalized.endswith(("_web_search", "_search_query"))
    )
    is_open = (
        normalized in {"open", "open_url", "open_page", "web_fetch", "browser_navigate"}
        or compact in {"webfetch", "openurl", "openpage", "browsernavigate"}
        or normalized.endswith(("_open_url", "_open_page", "_web_fetch"))
    )
    is_find = (
        normalized in {"find", "find_text", "find_in_page", "browser_find"}
        or compact in {"findtext", "findinpage", "browserfind"}
        or normalized.endswith(("_find_text", "_find_in_page"))
    )
    if is_search:
        query = safe_trace_text(_first_string(arguments, ("query", "queries", "q", "search")), 180)
        return {
            "action": "search",
            "label": f"Searched for “{query}”" if query else "Searched the web",
        }
    if is_open:
        url = safe_http_url(_first_string(arguments, ("url", "uri", "href")))
        host = urlsplit(url).hostname if url else None
        return {
            "action": "open",
            "label": f"Opened {host}" if host else "Opened a webpage",
            **({"url": url} if url else {}),
        }
    if is_find:
        pattern = safe_trace_text(_first_string(arguments, ("pattern", "query", "text")), 180)
        url = safe_http_url(_first_string(arguments, ("url", "uri", "href")))
        return {
            "action": "find",
            "label": f"Looked for “{pattern}” on a webpage" if pattern else "Looked for text on a webpage",
            **({"url": url} if url else {}),
        }
    return None


def tool_trace_summary(name: object, arguments: object, preview: object = None) -> str | None:
    web_action = web_action_for_tool(name, arguments)
    if web_action:
        return web_action["label"]
    visible_preview = safe_trace_text(preview, 240)
    if visible_preview and visible_preview.lower() not in {"tool completed", "tool is running"}:
        return visible_preview
    if not isinstance(arguments, dict):
        return None
    for keys, label in (
        (("resourceName", "fileName", "filename", "subject", "title"), "Target"),
        (("query", "q", "search", "pattern"), "Query"),
        (("url", "uri", "href"), "Website"),
        (("file_path", "path"), "File"),
    ):
        raw_value = _first_string(arguments, keys)
        if not raw_value:
            continue
        if label == "Website":
            url = safe_http_url(raw_value)
            value = urlsplit(url).hostname if url else None
        elif label == "File":
            value = PurePath(raw_value).name
        else:
            value = safe_trace_text(raw_value, 180)
        if value:
            return f"{label}: {value}"
    return None


def approach_summary(value: object) -> str | None:
    return safe_trace_text(value, MAX_TRACE_TEXT)


def extract_sources(value: object, maximum: int = MAX_SOURCE_COUNT) -> list[dict[str, str]]:
    sources: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(url_value: object, title_value: object = None) -> None:
        if len(sources) >= maximum:
            return
        url = safe_http_url(url_value)
        if not url or url in seen:
            return
        title = safe_trace_text(title_value, 240)
        if not title or title.lower().startswith(("http://", "https://")):
            title = urlsplit(url).hostname or "Source"
        sources.append({"title": title, "url": url})
        seen.add(url)

    def visit(item: object, depth: int = 0) -> None:
        if depth > 6 or len(sources) >= maximum:
            return
        if isinstance(item, dict):
            url_value = next(
                (item.get(key) for key in ("url", "source_url", "sourceUrl", "href", "link") if item.get(key)),
                None,
            )
            if url_value:
                title_value = next(
                    (item.get(key) for key in ("title", "name", "label", "source") if item.get(key)),
                    None,
                )
                add(url_value, title_value)
            for nested in item.values():
                visit(nested, depth + 1)
            return
        if isinstance(item, (list, tuple)):
            for nested in item:
                visit(nested, depth + 1)
            return
        if not isinstance(item, str):
            return
        markdown_urls: set[str] = set()
        for match in MARKDOWN_LINK.finditer(item):
            markdown_urls.add(match.group(2))
            add(match.group(2), match.group(1))
        for match in RAW_URL.finditer(item):
            if match.group(0) not in markdown_urls:
                add(match.group(0))

    visit(value)
    return sources
