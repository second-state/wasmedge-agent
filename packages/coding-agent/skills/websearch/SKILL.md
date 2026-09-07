---
name: websearch
description: Search Google via the Serper API. Takes a single query. Returns titles, URLs, snippets, and knowledge-graph data.
---

# Web Search

Search the web via the Serper Google Search API. The API key stays on the
host: cells call this crate, and the host performs the HTTP request.

## Setup

Get a free API key at https://serper.dev, then run `/login` in WasmEdge Agent and
choose "Serper (web search)" to paste it. The key is stored in WasmEdge Agent and
used by the host automatically.

If web search reports a missing key, walk the user through those two steps;
don't ask them to set environment variables.

Optional overrides (host environment variables):

- `WASMEDGE_AGENT_WEBSEARCH_TIMEOUT` - HTTP timeout in seconds (default 45).
- `WASMEDGE_AGENT_WEBSEARCH_NUM_RESULTS` - number of organic results to return (default 5).

## Usage

Call the mounted crate from a rust cell:

```rust
// Signatures:
//   websearch::run(query: &str) -> anyhow::Result<String>
//   websearch::search(query: &str, opts: websearch::SearchOpts) -> anyhow::Result<String>
//   SearchOpts { num_results: Option<u32>, timeout: Option<u32>, max_output: Option<u32> }
use agent_lib::skills::websearch;

let results = websearch::run("latest WasmEdge Agent release")?;
println!("{results}");
```
