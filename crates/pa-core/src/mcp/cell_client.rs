use super::{catalog_views, provider_id, AcpMcpServerConfig, McpManager, McpServerConfig};
use crate::kernel::shared::{host_handler, HostRequestHandlers};
use anyhow::{bail, ensure, Context, Result};
use futures::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    TryStreamExt,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[derive(Clone, PartialEq)]
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

const PROTOCOLS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
const RESPONSE_LIMIT: usize = 32 * 1024 * 1024;

type SessionSlot = Arc<tokio::sync::OnceCell<Transport>>;
tokio::task_local! {
    static CELL_SESSIONS: RefCell<HashMap<String, (Connection, SessionSlot)>>;
}

/// A WASI cell owns its MCP transports, including concurrent requests from the same guest.
pub(crate) async fn with_cell_connections<F: Future>(work: F) -> F::Output {
    CELL_SESSIONS.scope(RefCell::default(), work).await
}

struct Transport {
    client: reqwest::Client,
    url: String,
    session_id: Option<String>,
    protocol: Option<String>,
    next_id: AtomicU64,
}

impl Transport {
    async fn connect(config: &Connection) -> Result<Self> {
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in &config.headers {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
                value.parse()?,
            );
        }
        for name in [
            "accept",
            "content-type",
            "mcp-session-id",
            "mcp-protocol-version",
        ] {
            headers.remove(name);
        }
        let mut transport = Self {
            client: pa_ai::utils::tls::http_client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .default_headers(headers)
                .timeout(config.timeout)
                .build()?,
            url: config.url.clone(),
            session_id: None,
            protocol: None,
            next_id: AtomicU64::new(2),
        };
        let params = json!({
            "protocolVersion": PROTOCOLS[0],
            "capabilities": {},
            "clientInfo": {"name": "wasmedge-agent", "version": env!("CARGO_PKG_VERSION")}
        });
        let response = transport
            .post(&json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":params}))
            .await?;
        transport.session_id = response
            .headers()
            .get("mcp-session-id")
            .map(|v| v.to_str().map(str::to_owned))
            .transpose()?;
        let result = read_result(response, 1).await?;
        let protocol = result["protocolVersion"]
            .as_str()
            .context("missing MCP protocol version")?;
        ensure!(
            PROTOCOLS.contains(&protocol),
            "unsupported MCP protocol version {protocol}"
        );
        transport.protocol = Some(protocol.to_owned());
        transport
            .post(&json!({"jsonrpc":"2.0", "method":"notifications/initialized"}))
            .await?;
        Ok(transport)
    }

    async fn post(&self, body: &Value) -> Result<reqwest::Response> {
        let mut req = self
            .client
            .post(&self.url)
            .header("accept", "application/json, text/event-stream");
        if let Some(id) = &self.session_id {
            req = req.header("mcp-session-id", id);
        }
        if let Some(version) = &self.protocol {
            req = req.header("mcp-protocol-version", version);
        }
        Ok(req.json(body).send().await?.error_for_status()?)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params});
        read_result(self.post(&body).await?, id).await
    }
}

async fn read_result(response: reqwest::Response, id: u64) -> Result<Value> {
    let sse = response
        .headers()
        .get("content-type")
        .and_then(|s| s.to_str().ok())
        .is_some_and(|s| {
            s.split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("text/event-stream")
        });
    let input = response
        .bytes_stream()
        .map_err(std::io::Error::other)
        .into_async_read()
        .take(RESPONSE_LIMIT as u64 + 1);
    let mut input = BufReader::new(input);
    let message: Value = if sse {
        let mut line = String::new();
        let mut data = String::new();
        let mut size = 0;
        loop {
            line.clear();
            let n = input.read_line(&mut line).await?;
            size += n;
            ensure!(size <= RESPONSE_LIMIT, "MCP response exceeds size limit");
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(value) = line.strip_prefix("data:") {
                data.push_str(value.strip_prefix(' ').unwrap_or(value));
                data.push('\n');
            } else if line.is_empty() && !data.is_empty() {
                let message: Value = serde_json::from_str(&data)?;
                if message["id"].as_u64() == Some(id) {
                    break message;
                }
                data.clear();
            }
            ensure!(n != 0, "MCP stream closed before response {id}");
        }
    } else {
        let mut buf = Vec::new();
        input.read_to_end(&mut buf).await?;
        ensure!(
            buf.len() <= RESPONSE_LIMIT,
            "MCP response exceeds size limit"
        );
        serde_json::from_slice(&buf)?
    };
    ensure!(
        message["id"].as_u64() == Some(id),
        "mismatched MCP response id"
    );
    ensure!(
        message.get("error").is_none(),
        "MCP server rejected request: {}",
        message["error"]
    );
    message.get("result").cloned().context("missing MCP result")
}

fn session_slot(server: &str, config: &Connection) -> SessionSlot {
    CELL_SESSIONS
        .try_with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            if let Some((previous, slot)) = sessions.get(server) {
                if previous == config {
                    return slot.clone();
                }
            }
            let slot = SessionSlot::default();
            sessions.insert(server.to_owned(), (config.clone(), slot.clone()));
            slot
        })
        .unwrap_or_default()
}

async fn call(manager: &Mutex<McpManager>, method: &str, p: &Value) -> Result<Value> {
    let server = p["server"].as_str().context("missing MCP server")?;
    let c = connection(manager, server).await?;
    let slot = session_slot(server, &c);
    let transport = slot.get_or_try_init(|| Transport::connect(&c)).await?;
    if method == "mcp.call_tool" {
        let tool = p["tool"].as_str().context("missing MCP tool")?;
        ensure!(c.allows(tool), "MCP tool is disabled");
        let args = p
            .get("arguments")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        return transport
            .request("tools/call", json!({"name":tool, "arguments":args}))
            .await;
    }
    let mut tools = Vec::new();
    let mut cursors = HashSet::new();
    let mut params = json!({});
    loop {
        let page = transport.request("tools/list", params).await?;
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
