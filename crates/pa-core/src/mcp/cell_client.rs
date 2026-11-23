use super::{catalog_views, provider_id, AcpMcpServerConfig, McpManager, McpServerConfig};
use crate::kernel::shared::{host_handler, HostRequestHandlers};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

struct Connection {
    url: String,
    headers: HashMap<String, String>,
    enabled: Option<Vec<String>>,
    disabled: Vec<String>,
    timeout: Duration,
}
impl Connection {
    fn allows(&self, name: &str) -> bool {
        !self.disabled.iter().any(|s| s == name)
            && self
                .enabled
                .as_ref()
                .is_none_or(|v| v.iter().any(|s| s == name))
    }
}
async fn connection(manager: &Mutex<McpManager>, server: &str) -> Result<Connection> {
    let (integration, auth) = {
        let manager = manager.lock().unwrap();
        if let Some(acp) = manager.acp_servers.lock().unwrap().get(server) {
            let AcpMcpServerConfig::Http { url, headers, .. } = acp else {
                bail!("the WASI bridge supports HTTP MCP servers")
            };
            return Ok(Connection {
                url: url.clone(),
                headers: headers.clone(),
                enabled: None,
                disabled: vec![],
                timeout: Duration::from_secs(30),
            });
        }
        let i = manager
            .integrations
            .get(server)
            .context("unknown MCP server")?
            .clone();
        ensure!(
            i.blocked_reason.is_none()
                && i.config.is_enabled()
                && !(i.user_declared && manager.is_reserved_server_name(server)),
            "MCP server disabled or reserved"
        );
        (i, manager.auth_storage.clone())
    };
    let McpServerConfig::Http {
        url,
        headers,
        bearer_token_env_var,
        enabled_tools,
        disabled_tools,
        call_timeout_ms,
        ..
    } = integration.config
    else {
        bail!("the WASI bridge supports HTTP MCP servers")
    };
    let mut headers = headers.unwrap_or_default();
    let id = provider_id(server);
    let mut auth = auth.lock().await;
    auth.reload();
    let cred = auth.get_all().credential(&id);
    let token = if !integration.user_declared && integration.static_token_eligible {
        catalog_views::mcp_static_token_usable(cred.as_ref(), &url)
            .map_err(|_| anyhow::anyhow!("MCP token is not bound to this endpoint"))?;
        match cred {
            Some(crate::auth::AuthCredential::McpStaticToken { bearer, .. }) => Some(bearer),
            _ => bail!("missing MCP credential"),
        }
    } else if let Some(env) = bearer_token_env_var {
        Some(
            std::env::var(env)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .context("missing configured MCP bearer")?,
        )
    } else if integration.uses_oauth {
        catalog_views::oauth_grant_usable(cred.as_ref(), &url).map_err(|_| {
            anyhow::anyhow!("MCP OAuth grant is not bound to this endpoint; reconnect the server")
        })?;
        Some(auth.get_api_key(&id).context("MCP login required")?)
    } else {
        ensure!(
            integration.user_declared || integration.credential_free_eligible,
            "MCP setup required"
        );
        None
    };
    if let Some(t) = token {
        headers.retain(|k, _| !k.eq_ignore_ascii_case("authorization"));
        headers.insert("Authorization".into(), format!("Bearer {}", t.trim()));
    }
    Ok(Connection {
        url,
        headers,
        enabled: enabled_tools,
        disabled: disabled_tools.unwrap_or_default(),
        timeout: Duration::from_millis(call_timeout_ms.unwrap_or(30_000).max(1)),
    })
}
async fn post(
    client: &reqwest::Client,
    c: &Connection,
    session: &mut Option<String>,
    body: Value,
) -> Result<Value> {
    let mut req = client
        .post(&c.url)
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18");
    for (name, value) in &c.headers {
        req = req.header(name, value);
    }
    if let Some(id) = session.as_ref() {
        req = req.header("Mcp-Session-Id", id);
    }
    let mut response = req.json(&body).send().await?.error_for_status()?;
    if let Some(id) = response.headers().get("Mcp-Session-Id") {
        *session = Some(id.to_str()?.to_owned());
    }
    let Some(id) = body.get("id") else {
        return Ok(Value::Null);
    };
    let sse = response
        .headers()
        .get("content-type")
        .and_then(|s| s.to_str().ok())
        .is_some_and(|s| s.starts_with("text/event-stream"));
    let mut buf = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            buf.len() + chunk.len() <= 32 * 1024 * 1024,
            "MCP response exceeds size limit"
        );
        buf.extend_from_slice(&chunk);
        if sse {
            if let Some(msg) = buf
                .split(|c| *c == b'\n')
                .filter_map(|l| serde_json::from_slice::<Value>(l.strip_prefix(b"data:")?).ok())
                .find(|v| v.get("id") == Some(id))
            {
                ensure!(
                    msg.get("error").is_none(),
                    "MCP server rejected request: {}",
                    msg["error"]
                );
                return Ok(msg["result"].clone());
            }
        }
    }
    let msg: Value = serde_json::from_slice(&buf)?;
    ensure!(
        msg.get("id") == Some(id) && msg.get("error").is_none(),
        "MCP request failed: {}",
        msg["error"]
    );
    Ok(msg["result"].clone())
}
async fn call(manager: &Mutex<McpManager>, method: &str, p: &Value) -> Result<Value> {
    let server = p["server"].as_str().context("missing MCP server")?;
    let c = connection(manager, server).await?;
    let client = pa_ai::utils::tls::http_client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(c.timeout)
        .build()?;
    let mut session = None;
    let mut seq = 1;
    post(&client,&c,&mut session,json!({"jsonrpc":"2.0","id":seq,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"wasmedge-agent","version":env!("CARGO_PKG_VERSION")}}})).await?;
    post(
        &client,
        &c,
        &mut session,
        json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
    )
    .await?;
    if method == "mcp.call_tool" {
        let tool = p["tool"].as_str().context("missing MCP tool")?;
        ensure!(c.allows(tool), "MCP tool is disabled");
        return post(&client,&c,&mut session,json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":p.get("arguments").cloned().unwrap_or_else(||json!({}))}})).await;
    }
    let mut tools = Vec::new();
    let mut cursors = HashSet::new();
    let mut params = json!({});
    loop {
        seq += 1;
        let page = post(
            &client,
            &c,
            &mut session,
            json!({"jsonrpc":"2.0","id":seq,"method":"tools/list","params":params}),
        )
        .await?;
        tools.extend(
            page["tools"]
                .as_array()
                .context("invalid MCP tools list")?
                .iter()
                .filter(|t| t["name"].as_str().is_some_and(|name| c.allows(name)))
                .cloned(),
        );
        let Some(cursor) = page["nextCursor"].as_str().filter(|s| !s.is_empty()) else {
            break;
        };
        ensure!(
            cursors.insert(cursor.to_owned()) && cursors.len() < 1000,
            "invalid MCP pagination"
        );
        params = json!({"cursor":cursor});
    }
    Ok(json!({"tools":tools}))
}
pub(super) fn register(manager: &Arc<Mutex<McpManager>>, handlers: &mut HostRequestHandlers) {
    for method in ["mcp.list_tools", "mcp.call_tool"] {
        let manager = Arc::clone(manager);
        handlers.register(
            method,
            host_handler(move |p| {
                let manager = Arc::clone(&manager);
                async move { call(&manager, method, &p.data).await }
            }),
        );
    }
}
