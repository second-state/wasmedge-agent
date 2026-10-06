# MCP Integrations

Connect external services (Linear, Notion, …) to WasmEdge Agent over the
[Model Context Protocol](https://modelcontextprotocol.io).

Consistent with WasmEdge Agent's host-mediated I/O design, MCP integrations are
**not** exposed as new agent tools, and no per-integration package is needed.
The TypeScript host owns the connections; the model reaches every connected
server from a rust cell through two typed requests:

```rust
let tools = rlm::mcp::list_tools("linear")?;
let issues = rlm::mcp::call_tool("linear", "list_issues", json!({"team": "Engineering"}))?;
```

The host connects with the official `mcp` SDK over streamable HTTP, injects
credentials from `auth.json`, and caches one connection per server. Its other
jobs are the service catalog, interactive login (browser OAuth), credential
storage and refresh, and connection verification. Credentials never enter the
sandbox.

## Table of Contents

- [Connecting a service](#connecting-a-service)
- [How a call works](#how-a-call-works)
- [Connection states](#connection-states)
- [The model-facing inventory](#the-model-facing-inventory)
- [Generic MCP servers](#generic-mcp-servers)
  - [Authentication](#authentication)
- [Caveats](#caveats)

## Connecting a service

`/plugins` and bare `/mcp` open the same searchable external-service screen:

- Type to search (e.g. "Notion") — one canonical card per service, no duplicates.
- Each card shows its honest state: **Connect**, **Connected**, **Reconnect**,
  **Verifying**, **Requires setup**, or **Disabled**.
- Press Enter on a **Connect** card to review and complete browser OAuth. The
  credentials are stored locally in `~/.wasmedge-agent/auth.json` under
  `mcp:<service>`; WasmEdge Agent never proxies them.
- After login, WasmEdge Agent verifies the connection with a real MCP handshake
  (initialize + `tools/list`). A stored token alone is never reported as
  Connected: until the handshake succeeds the state stays **Verifying** or
  **Reconnect**. On success the connection activates in the current conversation
  without a restart, and the discovered tool count is shown.
- Enter on a **Connected** card disconnects it (removes the local credentials and
  connection record; revoking the provider grant stays a provider-side action).
- Cards marked **Requires setup** explain what is missing (developer app, API
  key, tenant URL, stdio adapter). They never show a fake Connect button.

`/mcp login <name>` and `/mcp logout <name>` work from the command line for the
same connections. The advanced subcommands (`/mcp add|list|get|remove`) remain
available and unchanged.

Connection records live in `~/.wasmedge-agent/mcp-connections.json`. They keep the
`connectionId` (the dispatch id and credential key), the catalog `serviceId`, the
bound endpoint, and the last verification result. Multiple accounts per service
will use distinct connection ids; grants are never merged because names look
similar.

## How a call works

The tool set is defined by the **server**, not by WasmEdge Agent, so discover
before you call — don't assume tool names or arguments:

```rust
// 1. Discover available tools (name, description, inputSchema)
let tools = rlm::mcp::list_tools("notion")?;
println!("{}", serde_json::to_string_pretty(&tools)?);

// 2. Call one; the arguments object matches the tool's JSON Schema
let result = rlm::mcp::call_tool("notion", "notion-search", json!({"query": "meeting notes"}))?;
```

- Results are the server's MCP result payload as `serde_json::Value` — content
  blocks, plus `structuredContent` when the server returns it.
- A call against a server with no credentials fails with a "not enabled; log in
  with `/mcp login <name>`" error the model can relay to the user.
- After the host refreshes an expired OAuth token, `rlm::host_request("mcp.refresh",
  json!({"server": name}))?` forces a reconnect; ordinary calls do this
  automatically on the next connection.

## Connection states

- **Connected** — a real MCP handshake succeeded against the bound endpoint
  with the stored credentials. Token presence alone never yields this state.
- **Verifying / pending** — credentials exist but the handshake has not
  succeeded (yet), e.g. right after login or while the endpoint is unreachable.
  The connection is usable; dispatch performs the live handshake.
- **Reconnect / error** — the credential was rejected (expired with no refresh
  token, or bound to a different endpoint). Reconnecting from `/plugins` fixes
  it; existing grants are not deleted by a failed verification.
- **Requires setup** — the service needs manual setup (developer app, API key,
  tenant URL, or a stdio adapter). The card states what is needed.
- **Disabled** — the server entry is disabled in settings.

Account/workspace identity is shown only when the provider exposes it; MCP has
no universal identity capability, so unknown is reported honestly.

## The model-facing inventory

A cell can ask the host for both supported-but-unconnected services and the
user's actual connections (the `mcp.list_plugins`, `mcp.search_plugins`, and
`mcp.list_connections` host requests). The full catalog is never injected into
the prompt; the model queries it on demand and searches it on the host. A
recommendation to connect a service never installs it or opens a browser by
itself: connecting is an explicit user action in `/plugins`.

## Generic MCP servers

Manage generic servers from either the shell (which exits without starting an
agent) or the TUI. Both surfaces update only `~/.wasmedge-agent/settings.json`:

```bash
wasmedge-agent mcp add remote --url https://mcp.example.com/mcp --bearer-token-env-var EXAMPLE_TOKEN
wasmedge-agent mcp list
wasmedge-agent mcp get remote
wasmedge-agent mcp remove remote
```

Use the same forms after `/mcp` in the TUI. Add `--oauth` for the existing OAuth
login flow and then use `/mcp login <name>`; use `--force` to replace a complete
existing entry. Static secret values are not accepted: bearer secrets are
environment-variable references. Project `.wasmedge-agent/settings.json` MCP
entries are ignored for execution, so a repository cannot point the host at its
own endpoint or shadow a user server.

Bundled integration names (`linear`, `notion`) are reserved: `mcp add` rejects
them, and a hand-edited `mcpServers` entry with such a name is ignored instead of
reconfiguring the built-in service. For service ids added later by the service
catalog, a user-declared server with the same name keeps working and owns the id;
connect the official endpoint instead through a differently-named entry.

Advanced options may also be written directly to the user settings file:

```jsonc
// ~/.wasmedge-agent/settings.json
{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "bearerTokenEnvVar": "EXAMPLE_TOKEN"
    }
  }
}
```

HTTP server fields:

| Field | Meaning |
|-------|---------|
| `type` | Must be `"http"` |
| `url` | The MCP endpoint |
| `oauth` | `true` to use the browser OAuth flow (requires the server to support dynamic client registration) |
| `bearerTokenEnvVar` | Name of an env var holding a static bearer token, instead of OAuth |
| `headers` | Extra static HTTP headers sent on every request |
| `enabled` | Set `false` to force-disable even when credentials exist |

> `stdio` (local-subprocess) servers are not supported — the host rejects
> non-HTTP entries — so an integration must target an HTTP endpoint.

The host initializes a connection on first use and reuses it for later calls.
Configuration changes replace the connection on the next call.

Optionally, ship a markdown [skill](skills.md) that documents the server's
important tools and workflows so the model reaches for them at the right time;
the calls themselves need nothing beyond `rlm::mcp`.

### Authentication

- **OAuth** (`"oauth": true`): the user runs `/mcp login <name>` (or connects it
  from `/plugins`). Works when the server supports OAuth 2.1 dynamic client
  registration (RFC 7591); login discovers the auth server, registers a client,
  and runs PKCE. Servers requiring a pre-registered client id are not yet
  supported via `mcpServers`.
- **Static bearer token** (`"bearerTokenEnvVar": "EXAMPLE_TOKEN"`): no login
  needed; the integration is usable whenever that env var is set.

Auth precedence per request: `bearerTokenEnvVar`, then static `headers`, then the
stored OAuth credential (refreshed automatically when expired).

## Caveats

- Discover before assuming tool names or argument schemas; they come from the
  server and can change, so call `list_tools` rather than hardcoding.
- Token presence is not connection readiness; the Connected state requires a
  verified handshake.
- **Multi-session daemon.** OAuth provider registration is process-global; a
  user-declared server unique to one daemon session is re-registered on that
  session's next reload.

See also: [Skills](skills.md), [Settings](settings.md).
