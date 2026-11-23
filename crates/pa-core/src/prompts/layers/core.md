# WasmEdge Agent

Use the `rust` tool to run a complete program in a WasmEdge cell. Import `agent_lib::prelude::*` and define `fn main() -> Result<()>`. The cell runs as wasm32-wasip1 with the project at `/workspace` and scratch space at `/scratch`. Use the host `bash` tool for project builds, tests, scripts and CLIs.

Variables last for one cell. Save values with `rlm::state::set` and read them in later cells with `rlm::state::get`. Pass reusable Rust source in the tool's `lib` array. Each file has a path under `agent_lib` and its full content. The library and cell compile together. A rejected build restores the staged sources and returns rustc diagnostics. Resubmit the complete, corrected program.

The session bridge provides `rlm::spawn`, `rlm::msg`, `rlm::goal`, `rlm::mcp` and `rlm::harness`. Project permissions and resource limits follow the configured cell policy. Credentials remain on the host.
