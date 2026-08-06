//! MCP access, host-mediated (DESIGN.md §2.6, D12): the guest never talks to
//! MCP servers directly — requests go through the host's MCP manager. The
//! `mcp.list_tools` / `mcp.call_tool` host handlers land with the skills
//! migration (WP6); until then these return "not available in this session".

use anyhow::Result;
use serde_json::{json, Value};

use crate::bridge;

/// List the tools an MCP server exposes.
pub fn list_tools(server: &str) -> Result<Value> {
    bridge::request("mcp.list_tools", json!({"server": server}))
}

/// Call one MCP tool with JSON arguments.
pub fn call_tool(server: &str, tool: &str, arguments: Value) -> Result<Value> {
    bridge::request(
        "mcp.call_tool",
        json!({"server": server, "tool": tool, "arguments": arguments}),
    )
}
