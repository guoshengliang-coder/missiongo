# AI client setup

MissionGo exposes an authenticated Streamable HTTP MCP endpoint at `/mcp` when `MCP_API_TOKEN` is configured on the server. The current tool set supports on-demand reading, attachment inspection, and analysis writeback. It does not expose SQL, arbitrary item editing, claiming, or automatic processing.

Keep the real endpoint and token only in local configuration. The values below are placeholders.

## Server

Create a strong, revocable token and put it in the server's untracked `.env`:

```dotenv
MCP_API_TOKEN=replace-with-a-long-random-token
```

Expose the server through HTTPS before connecting over the internet. Do not publish the bare development port.

## Codex

Export the token in the local environment that launches Codex:

```bash
export MISSIONGO_MCP_TOKEN="replace-with-your-local-token"
```

Add this to the local `~/.codex/config.toml`, or to an untracked project-level `.codex/config.toml`:

```toml
[mcp_servers.missiongo]
url = "https://missiongo.example.com/mcp"
bearer_token_env_var = "MISSIONGO_MCP_TOKEN"
enabled_tools = [
  "list_products",
  "list_components",
  "list_items",
  "get_item_context",
  "get_item_timeline",
  "get_attachment",
  "append_analysis",
]
default_tools_approval_mode = "writes"
```

Install or link the repository's [`skills/missiongo`](../skills/missiongo) skill into the local Codex skills directory. Then a request can be as short as:

> Analyze MissionGo item HG-12 and write the conclusion back. Do not modify code.

## Claude Code

Claude Code supports an HTTP MCP server with request headers. Keep the configuration local if the deployment address is private:

```json
{
  "mcpServers": {
    "missiongo": {
      "type": "http",
      "url": "https://missiongo.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MISSIONGO_MCP_TOKEN}"
      }
    }
  }
}
```

Export `MISSIONGO_MCP_TOKEN` before launching Claude Code. Do not place the token itself in `.mcp.json` or commit a private endpoint.

## Hermes and other MCP clients

Use the client's Streamable HTTP transport with these values:

- URL: `https://missiongo.example.com/mcp`
- Header: `Authorization: Bearer <local token>`
- Tools: allow the seven tools listed in the Codex example

If the client supports reusable instructions or skills, use [`skills/missiongo/SKILL.md`](../skills/missiongo/SKILL.md) as the workflow. The transport configuration supplies data access; the skill supplies the safe analysis behavior.

## Current tools

- `list_products`, `list_components`, and `list_items` find work.
- `get_item_context` returns the complete structured item, including captured device/version details and attachment metadata.
- `get_item_timeline` pages through earlier events.
- `get_attachment` pages through logs, returns small images for inspection, and returns metadata for videos or large images.
- `append_analysis` writes a conclusion, evidence, and risks to the timeline without changing item status. Reusing its idempotency key returns the original result rather than creating a duplicate note.
