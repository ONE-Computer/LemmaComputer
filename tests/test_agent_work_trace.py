from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker" / "workspace"))

from lemmacomputer_work_trace import (  # noqa: E402
    approach_summary,
    extract_sources,
    humanize_tool_name,
    safe_http_url,
    tool_progress_label,
    tool_trace_summary,
    web_action_for_tool,
)


class WorkTraceTests(unittest.TestCase):
    def test_workspace_image_installs_helper_as_readable_module(self) -> None:
        dockerfile = (Path(__file__).resolve().parents[1] / "docker" / "Dockerfile.workspace").read_text()
        self.assertIn(
            "COPY --chmod=0644 docker/workspace/lemmacomputer_work_trace.py "
            "/usr/local/libexec/lemmacomputer_work_trace.py",
            dockerfile,
        )

    def test_visible_approach_is_flattened_without_markdown_or_marker(self) -> None:
        self.assertEqual(
            approach_summary("[LEMMACOMPUTER_NEEDS_INPUT]\n## Plan\n- Compare **trusted** recipes."),
            "Plan Compare trusted recipes.",
        )
        self.assertEqual(
            approach_summary("Use Bearer secret-bearer-token and https://example.com/a?safe=yes&token=secret"),
            "Use Bearer [redacted] and https://example.com/a?safe=yes",
        )

    def test_web_tools_become_specific_user_visible_actions(self) -> None:
        self.assertEqual(
            web_action_for_tool("WebSearch", {"query": "traditional Swiss rösti"}),
            {"action": "search", "label": "Searched for “traditional Swiss rösti”"},
        )
        self.assertEqual(
            web_action_for_tool("WebFetch", {"url": "https://www.bbcgoodfood.com/recipes/rosti#method"}),
            {
                "action": "open",
                "label": "Opened www.bbcgoodfood.com",
                "url": "https://www.bbcgoodfood.com/recipes/rosti",
            },
        )

    def test_tool_summaries_use_only_allowlisted_human_fields(self) -> None:
        self.assertEqual(humanize_tool_name("get-drive-item"), "Get drive item")
        self.assertEqual(
            tool_trace_summary("get-drive-item", {"resourceName": "planning-draft.docx", "driveId": "opaque"}),
            "Target: planning-draft.docx",
        )
        self.assertIsNone(tool_trace_summary("unknown-tool", {"apiKey": "must-not-appear", "id": "opaque"}))

    def test_tool_lifecycle_becomes_one_safe_human_milestone(self) -> None:
        self.assertEqual(tool_progress_label("Write", "running", "File: App.jsx"), "Updating App.jsx…")
        self.assertEqual(tool_progress_label("publish-site", "running", "Target: Sales portal"), "Publishing Sales portal…")
        self.assertEqual(tool_progress_label("Bash", "completed", "Tool completed"), "Workspace checks finished.")
        self.assertEqual(tool_progress_label("unknown", "running", "Bearer secret-bearer-token"), "Working in the workspace…")

    def test_sources_are_deduplicated_titled_and_limited_to_public_http(self) -> None:
        sources = extract_sources({
            "results": [
                {"title": "BBC Good Food", "url": "https://www.bbcgoodfood.com/recipes/rosti"},
                {"name": "Duplicate", "href": "https://www.bbcgoodfood.com/recipes/rosti"},
                {"title": "Private", "url": "http://127.0.0.1/admin"},
            ],
            "answer": "See [Serious Eats](https://www.seriouseats.com/rosti-recipe).",
        })
        self.assertEqual(sources, [
            {"title": "BBC Good Food", "url": "https://www.bbcgoodfood.com/recipes/rosti"},
            {"title": "Serious Eats", "url": "https://www.seriouseats.com/rosti-recipe"},
        ])
        self.assertIsNone(safe_http_url("https://user:password@example.com/private"))
        self.assertIsNone(safe_http_url("http://localhost/private"))

        self.assertEqual(safe_http_url("https://example.com/a?safe=yes&X-Amz-Signature=secret#private"), "https://example.com/a?safe=yes")

if __name__ == "__main__":
    unittest.main()
