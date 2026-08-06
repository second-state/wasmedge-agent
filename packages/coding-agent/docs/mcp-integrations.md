# MCP Integrations

Connect external services (Linear, Notion, …) to Prime Agent over the
[Model Context Protocol](https://modelcontextprotocol.io).

Consistent with Prime Agent's host-mediated I/O design, MCP integrations are
**not** exposed as new agent tools, and no per-integration package is needed.
The TypeScript host owns the connections; the model reaches every connected
server from a rust cell through two typed requests:

```rust
let tools = rlm::mcp::list_tools("linear")?;
let issues = rlm::mcp::call_tool("linear", "list_issues", json!({"team": "Engineering"}))?;
```

The host connects with the official `mcp` SDK over streamable HTTP, injects
credentials from `auth.json`, and caches one connection per server. Credentials
never enter the sandbox.

## Table of Contents

- [Using a built-in integration](#using-a-built-in-integration)
- [How a call works](#how-a-call-works)
- [Adding your own server](#adding-your-own-server)
  - [Authentication](#authentication)
- [Enable-by-login lifecycle](#enable-by-login-lifecycle)
- [Caveats](#caveats)

## Using a built-in integration

Built-in integrations (Linear, Notion) ship **disabled**. Logging in enables them:

- Open `/login`, switch to **MCP Connections**, pick the integration, and
  complete OAuth in the browser. `/mcp login <name>` does the same from the CLI.
- Once connected, the server is listed in the model's system prompt and callable
  via `rlm::mcp`.
- `/mcp` lists integrations and connection status; `/mcp logout <name>`
  disconnects.

Credentials are stored once in `~/.prime/agent/auth.json` under `mcp:<name>`.
Enablement is derived from whether valid credentials exist — there is no separate
on/off switch.

## How a call works

The tool set is defined by the **server**, so discover before you call — don't
assume tool names or arguments:

```rust
// 1. Discover available tools (name, description, inputSchema)
let tools = rlm::mcp::list_tools("linear")?;
println!("{}", serde_json::to_string_pretty(&tools)?);

// 2. Call one; the arguments object matches the tool's JSON Schema
let result = rlm::mcp::call_tool("linear", "list_issues", json!({"team": "Engineering"}))?;
```

- Results are the server's MCP result payload as `serde_json::Value` — content
  blocks, plus `structuredContent` when the server returns it.
- A call against a server with no credentials fails with a "not enabled; log in
  with `/mcp login <name>`" error the model can relay to the user.
- After the host refreshes an expired OAuth token, `rlm::host_request("mcp.refresh",
  json!({"server": name}))?` forces a reconnect; ordinary calls do this
  automatically on the next connection.

## Adding your own server

Declare it under `mcpServers` in `~/.prime/agent/settings.json` (or project
`.prime/agent/settings.json`) — that is the whole integration:

```jsonc
// ~/.prime/agent/settings.json
{
  "mcpServers": {
    "acme": {
      "type": "http",
      "url": "https://mcp.acme.com/mcp",
      "oauth": true
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

Optionally, ship a markdown [skill](skills.md) that documents the server's
important tools and workflows so the model reaches for them at the right time;
the calls themselves need nothing beyond `rlm::mcp`.

### Authentication

- **OAuth** (`"oauth": true`): the user runs `/login` → MCP Connections → your
  server (or `/mcp login acme`). Works when the server supports OAuth 2.1 dynamic
  client registration (RFC 7591); login discovers the auth server, registers a
  client, and runs PKCE. Servers requiring a pre-registered client id are not yet
  supported via `mcpServers`.
- **Static bearer token** (`"bearerTokenEnvVar": "ACME_TOKEN"`): no login needed;
  the integration is "connected" whenever that env var is set.

Auth precedence per request: `bearerTokenEnvVar`, then static `headers`, then the
stored OAuth credential (refreshed automatically when expired).

## Enable-by-login lifecycle

This auth-gating applies to the **built-in** integrations (Linear, Notion):

1. The built-in server ships declared but **disabled** — absent from the prompt —
   because no credentials exist.
2. The user logs in; credentials land in `auth.json` under `mcp:<server>`.
3. A resource reload (automatic after `/login`/`/mcp login`, or `/reload`)
   detects the credentials and the server appears in the model's prompt.
4. Logout (or losing credentials) disables it again.

If you log in mid-turn, the reload is deferred — run `/reload` after the turn to
activate the integration.

**User-declared servers are not auth-gated this way.** An `mcpServers` entry is
visible to the model regardless of `auth.json`; it simply fails at call time with
the not-enabled error until credentials exist. For a bearer-token server, tell
the user to set that env var — `/mcp login` has no provider for a bearer-only
server and reports "Unknown MCP integration".

## Caveats

- **Discover before assuming.** Tool names and argument schemas come from the
  server and can change; call `list_tools` rather than hardcoding.
- **Overriding a built-in name.** Declaring an `mcpServers` entry whose key
  matches a built-in (e.g. `linear`) with a custom `url` points the integration at
  your URL. A previously stored official credential is *not* reused for the
  override, to avoid sending the official token to your endpoint. Authenticate
  such an override via `bearerTokenEnvVar` only — OAuth credentials are not
  honored for a catalog-name override. (Use a name that isn't a built-in to get
  OAuth.)
- **Multi-session daemon.** OAuth provider registration is process-global; a
  user-declared server unique to one daemon session is re-registered on that
  session's next reload.

See also: [Skills](skills.md), [Settings](settings.md).
