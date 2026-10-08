//! (internal) Client to the host BridgeServer: JSON-lines framing, bearer
//! token handshake, lockstep request/reply (DESIGN.md §2.7).
//!
//! One process-global connection, opened lazily on first use from the
//! `RLM_BRIDGE_STDIO` / `RLM_BRIDGE_TOKEN` / `RLM_CELL_ID` env the host sets per
//! cell. The guest is single-threaded and every send synchronously awaits its
//! reply (`res` for `req`, `ack` for `emit`), so frames never interleave.
//! Ordinary requests time out after 30s guest-side; skill tests use the cell
//! budget. The host's per-cell budget is the hard backstop. A transport failure
//! renews the handshake on the next call — requests are
//! never auto-retried (a `req` may have side effects like spawning a subagent).
//!
//! WASI uses stdin/stdout only, without socket imports. Native protocol tests
//! use `std::net` and RLM_BRIDGE_ADDR.

#[cfg(not(target_os = "wasi"))]
use std::io::Read;
use std::io::{ErrorKind as IoErrorKind, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::error::Error;

#[cfg(not(target_os = "wasi"))]
use std::net::TcpStream as Stream;
#[cfg(target_os = "wasi")]
mod stdio;
#[cfg(target_os = "wasi")]
use stdio::Stream;

pub(crate) const PROTOCOL_VERSION: u64 = 1;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const READ_CHUNK: usize = 16 * 1024;
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

struct Conn {
    stream: Stream,
    buffer: Vec<u8>,
    next_id: u64,
    #[cfg(target_os = "wasi")]
    needs_handshake: bool,
    prefix: Vec<u8>,
}

static CONN: Mutex<Option<Conn>> = Mutex::new(None);

/// Whether this cell was started with a host bridge attached.
pub(crate) fn available() -> bool {
    #[cfg(target_os = "wasi")]
    return std::env::var("RLM_BRIDGE_STDIO").is_ok_and(|v| v == "1");
    #[cfg(not(target_os = "wasi"))]
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
        #[cfg(not(target_os = "wasi"))]
        let (stream, prefix) = {
            let addr = env_var("RLM_BRIDGE_ADDR")?;
            let stream = Stream::connect(&addr).map_err(|e| {
                Error::bridge(format!("connecting to the host bridge at {addr}: {e}"))
            })?;
            stream
                .set_nonblocking(true)
                .map_err(|e| Error::bridge(format!("configuring the bridge socket: {e}")))?;
            (stream, Vec::new())
        };
        #[cfg(target_os = "wasi")]
        let (stream, prefix) = {
            if env_var("RLM_BRIDGE_STDIO")? != "1" {
                return Err(Error::bridge("unsupported host bridge transport").into());
            }
            let token = env_var("RLM_BRIDGE_TOKEN")?;
            (Stream, format!("\x1eRLM:{token}:").into_bytes())
        };
        let mut conn = Conn {
            stream,
            buffer: Vec::new(),
            next_id: 1,
            prefix,
            #[cfg(target_os = "wasi")]
            needs_handshake: false,
        };
        conn.handshake()?;
        Ok(conn)
    }

    fn handshake(&mut self) -> Result<()> {
        let token = env_var("RLM_BRIDGE_TOKEN")?;
        let cell = env_var("RLM_CELL_ID")?;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        self.send_frame(
            &json!({"v": PROTOCOL_VERSION, "kind": "hello", "token": token, "cell": cell}),
            deadline,
        )?;
        loop {
            let reply = self.read_frame(deadline)?;
            if reply.get("kind").and_then(Value::as_str) == Some("hello_ok") {
                return Ok(());
            }
            // Stdio stays open across transport timeouts. Drain replies to
            // earlier requests before the new handshake acknowledgement; the
            // host cancels that generation before acknowledging this one.
            #[cfg(target_os = "wasi")]
            if matches!(
                reply.get("kind").and_then(Value::as_str),
                Some("res" | "ack")
            ) {
                continue;
            }
            return Err(Error::bridge("host bridge rejected the handshake").into());
        }
    }

    fn send_frame(&mut self, frame: &Value, deadline: Instant) -> Result<()> {
        let bytes = serde_json::to_vec(frame).context("encoding a bridge frame")?;
        if bytes.len() + 1 > MAX_FRAME_BYTES {
            return Err(Error::bridge("bridge frame exceeds the line-length limit").into());
        }
        #[cfg(target_os = "wasi")]
        std::io::stdout()
            .flush()
            .context("flushing stdout before a bridge frame")?;
        let mut line = self.prefix.clone();
        line.extend_from_slice(&bytes);
        line.push(b'\n');
        let mut remaining = &line[..];
        while !remaining.is_empty() {
            if Instant::now() >= deadline {
                return Err(Error::bridge("timed out writing to the host bridge").into());
            }
            match self.stream.write(remaining) {
                Ok(0) => return Err(Error::bridge("bridge connection closed while writing").into()),
                Ok(n) => remaining = &remaining[n..],
                Err(e)
                    if e.kind() == IoErrorKind::WouldBlock
                        || e.kind() == IoErrorKind::Interrupted =>
                {
                    wait_or_timeout(deadline, "writing to the host bridge")?;
                }
                Err(e) => {
                    return Err(Error::bridge(format!("writing to the host bridge: {e}")).into())
                }
            }
        }
        Ok(())
    }

    fn read_frame(&mut self, deadline: Instant) -> Result<Value> {
        loop {
            if Instant::now() >= deadline {
                return Err(Error::bridge("timed out waiting for a host bridge reply").into());
            }
            if let Some(pos) = self.buffer.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=pos).collect();
                line.pop();
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let frame: Value =
                    serde_json::from_slice(&line).context("decoding a bridge frame")?;
                if frame.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
                    return Err(Error::bridge("invalid bridge protocol version").into());
                }
                return Ok(frame);
            }
            let mut chunk = [0u8; READ_CHUNK];
            #[cfg(target_os = "wasi")]
            let read = self.stream.read_until(&mut chunk, deadline);
            #[cfg(not(target_os = "wasi"))]
            let read = self.stream.read(&mut chunk);
            match read {
                Ok(0) => return Err(Error::bridge("bridge connection closed by the host").into()),
                Ok(n) => {
                    if self.buffer.len() + n > MAX_FRAME_BYTES {
                        return Err(
                            Error::bridge("bridge reply exceeds the line-length limit").into()
                        );
                    }
                    self.buffer.extend_from_slice(&chunk[..n]);
                }
                Err(e)
                    if e.kind() == IoErrorKind::WouldBlock
                        || e.kind() == IoErrorKind::Interrupted =>
                {
                    wait_or_timeout(deadline, "waiting for a host bridge reply")?;
                }
                Err(e) if e.kind() == IoErrorKind::TimedOut => {
                    return Err(Error::bridge("timed out waiting for a host bridge reply").into())
                }
                Err(e) => {
                    return Err(Error::bridge(format!("reading from the host bridge: {e}")).into())
                }
            }
        }
    }
}

/// Run `f` on the live connection, connecting lazily. Transport errors require
/// a new handshake (a new socket on native); host-reported errors keep it.
fn with_conn<T>(f: impl FnOnce(&mut Conn) -> Result<T>) -> Result<T> {
    let mut guard = CONN
        .lock()
        .map_err(|_| Error::bridge("bridge connection lock poisoned"))?;
    if guard.is_none() {
        *guard = Some(Conn::connect()?);
    }
    let conn = guard.as_mut().expect("connection was just established");
    #[cfg(target_os = "wasi")]
    if conn.needs_handshake {
        conn.handshake()?;
        conn.needs_handshake = false;
    }
    let result = f(conn);
    if let Err(error) = &result {
        let is_host_error = error
            .downcast_ref::<Error>()
            .is_some_and(|e| e.kind == crate::error::ErrorKind::Host);
        if !is_host_error {
            #[cfg(target_os = "wasi")]
            {
                conn.needs_handshake = true;
            }
            #[cfg(not(target_os = "wasi"))]
            {
                *guard = None;
            }
        }
    }
    result
}

/// Send a typed host request and return the reply payload (DESIGN.md §2.7).
pub(crate) fn request(request_type: &str, payload: Value) -> Result<Value> {
    request_with_timeout(request_type, payload, REQUEST_TIMEOUT)
}

/// Long-running skill tests use the cell budget; ordinary requests keep the
/// default transport timeout. The host still enforces the cell's deadline.
pub(crate) fn request_with_timeout(
    request_type: &str,
    payload: Value,
    timeout: Duration,
) -> Result<Value> {
    with_conn(|conn| {
        let id = conn.next_id;
        conn.next_id += 1;
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| Error::bridge("bridge request timeout is too large"))?;
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
                // Protocol v1 extension: an ack may carry an error (e.g. the host
                // could not decode/resize an attachment). Host-reported, so the
                // connection stays usable.
                if let Some(message) = frame.get("error").and_then(Value::as_str) {
                    return Err(crate::error::Error::new(
                        crate::error::ErrorKind::Host,
                        message.to_string(),
                    )
                    .into());
                }
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
