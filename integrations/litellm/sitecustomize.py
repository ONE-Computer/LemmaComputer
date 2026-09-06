"""Load the version-pinned remote MCP egress guard before LiteLLM starts."""

from lemmacomputer_remote_mcp_egress import install

install()

from lemmacomputer_model_catalog import install as install_catalog

install_catalog()
