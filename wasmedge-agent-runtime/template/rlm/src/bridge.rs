//! (internal) TCP client to the host BridgeServer: JSON-lines framing, bearer
//! token handshake, lockstep request/reply (DESIGN.md §2.7).
//!
//! One process-global connection, opened lazily on first use from the
//! `RLM_BRIDGE_ADDR` / `RLM_BRIDGE_TOKEN` / `RLM_CELL_ID` env the host sets per
//! cell. The guest is single-threaded and every send synchronously awaits its
//! reply (`res` for `req`, `ack` for `emit`), so frames never interleave.
//! Requests time out after 30s guest-side; the host's per-cell budget is the
//! hard backstop. A transport failure discards the connection so the next call
//! reconnects fresh — requests are never auto-retried (a `req` may have side
//! effects like spawning a subagent).
//!
//! On wasm32-wasip1 the socket comes from WasmEdge's WASI socket extension via
//! `wasmedge_wasi_socket`; native builds (unit tests) use `std::net`.

use std::io::{ErrorKind as IoErrorKind, Read, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::error::Error;

#[cfg(not(target_os = "wasi"))]
use std::net::TcpStream;
#[cfg(target_os = "wasi")]
use wasmedge_wasi_socket::TcpStream;

pub(crate) const PROTOCOL_VERSION: u64 = 1;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const READ_CHUNK: usize = 16 * 1024;

struct Conn {
    stream: TcpStream,
    buffer: Vec<u8>,
    next_id: u64,
}

static CONN: Mutex<Option<Conn>> = Mutex::new(None);

/// Whether this cell was started with a host bridge attached.
pub(crate) fn available() -> bool {
    std::env::var("RLM_BRIDGE_ADDR").is_ok_and(|v| !v.is_empty())
}

fn env_var(name: &str) -> Result<String> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(Error::bridge(format!(
            "{name} is not set; this cell was started without a host bridge"
        ))
        .into()),
    }
}

fn wait_or_timeout(deadline: Instant, doing: &str) -> Result<()> {
    if Instant::now() >= deadline {
        return Err(Error::bridge(format!("timed out {doing}")).into());
    }
    std::thread::sleep(POLL_INTERVAL);
    Ok(())
}

impl Conn {
    fn connect() -> Result<Self> {
        let addr = env_var("RLM_BRIDGE_ADDR")?;
        let token = env_var("RLM_BRIDGE_TOKEN")?;
        let cell = env_var("RLM_CELL_ID")?;
        let stream = TcpStream::connect(&addr)
            .map_err(|e| Error::bridge(format!("connecting to the host bridge at {addr}: {e}")))?;
        stream
            .set_nonblocking(true)
            .map_err(|e| Error::bridge(format!("configuring the bridge socket: {e}")))?;
        let mut conn = Conn {
            stream,
            buffer: Vec::new(),
            next_id: 1,
        };
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        conn.send_frame(
            &json!({"v": PROTOCOL_VERSION, "kind": "hello", "token": token, "cell": cell}),
            deadline,
        )?;
        let reply = conn.read_frame(deadline)?;
        if reply.get("kind").and_then(Value::as_str) != Some("hello_ok") {
            return Err(Error::bridge("host bridge rejected the handshake").into());
        }
        Ok(conn)
    }

    fn send_frame(&mut self, frame: &Value, deadline: Instant) -> Result<()> {
        let mut line = serde_json::to_vec(frame).context("encoding a bridge frame")?;
        line.push(b'\n');
        let mut remaining = &line[..];
        while !remaining.is_empty() {
            match self.stream.write(remaining) {
                Ok(0) => return Err(Error::bridge("bridge connection closed while writing").into()),
                Ok(n) => remaining = &remaining[n..],
                Err(e) if e.kind() == IoErrorKind::WouldBlock || e.kind() == IoErrorKind::Interrupted => {
                    wait_or_timeout(deadline, "writing to the host bridge")?;
                }
                Err(e) => return Err(Error::bridge(format!("writing to the host bridge: {e}")).into()),
            }
        }
        Ok(())
    }

    fn read_frame(&mut self, deadline: Instant) -> Result<Value> {
        loop {
            if let Some(pos) = self.buffer.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=pos).collect();
                line.pop();
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                return serde_json::from_slice(&line).context("decoding a bridge frame");
            }
            let mut chunk = [0u8; READ_CHUNK];
            match self.stream.read(&mut chunk) {
                Ok(0) => return Err(Error::bridge("bridge connection closed by the host").into()),
                Ok(n) => self.buffer.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == IoErrorKind::WouldBlock || e.kind() == IoErrorKind::Interrupted => {
                    wait_or_timeout(deadline, "waiting for a host bridge reply")?;
                }
                Err(e) => return Err(Error::bridge(format!("reading from the host bridge: {e}")).into()),
            }
        }
    }
}

/// Run `f` on the live connection, connecting lazily. Transport errors discard
/// the connection so the next call starts clean; host-reported errors keep it.
fn with_conn<T>(f: impl FnOnce(&mut Conn) -> Result<T>) -> Result<T> {
    let mut guard = CONN
        .lock()
        .map_err(|_| Error::bridge("bridge connection lock poisoned"))?;
    if guard.is_none() {
        *guard = Some(Conn::connect()?);
    }
    let conn = guard.as_mut().expect("connection was just established");
    let result = f(conn);
    if let Err(error) = &result {
        let is_host_error = error
            .downcast_ref::<Error>()
            .is_some_and(|e| e.kind == crate::error::ErrorKind::Host);
        if !is_host_error {
            *guard = None;
        }
    }
    result
}

/// Send a typed host request and return the reply payload (DESIGN.md §2.7).
pub(crate) fn request(request_type: &str, payload: Value) -> Result<Value> {
    with_conn(|conn| {
        let id = conn.next_id;
        conn.next_id += 1;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        conn.send_frame(
            &json!({"v": PROTOCOL_VERSION, "kind": "req", "id": id, "type": request_type, "payload": payload}),
            deadline,
        )?;
        loop {
            let frame = conn.read_frame(deadline)?;
            if frame.get("kind").and_then(Value::as_str) != Some("res")
                || frame.get("id").and_then(Value::as_u64) != Some(id)
            {
                // Lockstep protocol: anything else is a stray frame; skip it.
                continue;
            }
            return match frame.get("status").and_then(Value::as_str) {
                Some("ok") => Ok(frame.get("payload").cloned().unwrap_or_else(|| json!({}))),
                Some("error") => {
                    let message = frame
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("host request {request_type} failed"));
                    Err(Error::host(message).into())
                }
                other => Err(Error::bridge(format!(
                    "host request {request_type} returned unexpected status: {other:?}"
                ))
                .into()),
            };
        }
    })
}

/// Send a rich-output event and await its ack (DESIGN.md §2.9).
pub(crate) fn emit(emit_type: &str, payload: Value) -> Result<()> {
    with_conn(|conn| {
        let id = conn.next_id;
        conn.next_id += 1;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        conn.send_frame(
            &json!({"v": PROTOCOL_VERSION, "kind": "emit", "id": id, "type": emit_type, "payload": payload}),
            deadline,
        )?;
        loop {
            let frame = conn.read_frame(deadline)?;
            if frame.get("kind").and_then(Value::as_str) == Some("ack")
                && frame.get("id").and_then(Value::as_u64) == Some(id)
            {
                return Ok(());
            }
        }
    })
}

/// Drop the global connection (integration tests swap mock hosts per test).
#[cfg(not(target_os = "wasi"))]
pub(crate) fn reset_for_tests() {
    if let Ok(mut guard) = CONN.lock() {
        *guard = None;
    }
}
