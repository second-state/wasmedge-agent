//! Web search via the host's Serper API key. The key never enters the
//! sandbox: cells send `websearch.run` host requests and the host performs
//! the HTTP call, formats the results, and returns text.

use anyhow::Result;
use serde_json::json;

/// Search the web. Returns formatted results: knowledge graph, answer box,
/// and organic hits with title, link, and snippet.
pub fn run(query: &str) -> Result<String> {
    search(query, SearchOpts::default())
}

/// Options for [`search`]. `Default` uses the host-side defaults
/// (5 results, 45s timeout, 8192-char output cap).
#[derive(Debug, Default, Clone, Copy)]
pub struct SearchOpts {
    /// Number of organic results to return.
    pub num_results: Option<u32>,
    /// HTTP timeout in seconds for the host-side Serper call.
    pub timeout: Option<u32>,
    /// Maximum characters of formatted output before middle truncation.
    pub max_output: Option<u32>,
}

/// Search with explicit limits.
pub fn search(query: &str, opts: SearchOpts) -> Result<String> {
    let mut payload = json!({ "query": query });
    if let Some(n) = opts.num_results {
        payload["num_results"] = json!(n);
    }
    if let Some(t) = opts.timeout {
        payload["timeout"] = json!(t);
    }
    if let Some(m) = opts.max_output {
        payload["max_output"] = json!(m);
    }
    let reply = rlm::host_request("websearch.run", payload)?;
    Ok(reply
        .get("result")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string())
}
