//! Bridge client framing/handshake tests against a mock host on the native
//! target (the wasm backend swaps only the TcpStream type). Env vars and the
//! process-global connection are shared state, so tests run under one lock.

#![cfg(not(target_os = "wasi"))]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::thread::JoinHandle;

use serde_json::{json, Value};

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct MockHost {
    port: u16,
    handle: Option<JoinHandle<Vec<Value>>>,
}

/// One mock host per test: accepts a single connection, verifies the
/// handshake, then answers each frame with `respond`.
fn mock_host(respond: impl Fn(&Value) -> Option<Value> + Send + 'static) -> MockHost {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = stream;
        let mut seen = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return seen;
            }
            let frame: Value = serde_json::from_str(&line).unwrap();
            seen.push(frame.clone());
            if frame["kind"] == "hello" {
                if frame["token"] == "tok-ok" && frame["cell"] == "cell-t" {
                    writer.write_all(b"{\"v\":1,\"kind\":\"hello_ok\"}\n").unwrap();
                    continue;
                }
                return seen; // reject: close the connection
            }
            match respond(&frame) {
                Some(reply) => {
                    let mut bytes = serde_json::to_vec(&reply).unwrap();
                    bytes.push(b'\n');
                    writer.write_all(&bytes).unwrap();
                }
                None => return seen,
            }
        }
    });
    MockHost {
        port,
        handle: Some(handle),
    }
}

fn with_bridge_env<R>(port: u16, token: &str, f: impl FnOnce() -> R) -> R {
    let _guard = ENV_LOCK.lock().unwrap();
    rlm::test_support::reset_connection();
    std::env::set_var("RLM_BRIDGE_ADDR", format!("127.0.0.1:{port}"));
    std::env::set_var("RLM_BRIDGE_TOKEN", token);
    std::env::set_var("RLM_CELL_ID", "cell-t");
    let result = f();
    std::env::remove_var("RLM_BRIDGE_ADDR");
    std::env::remove_var("RLM_BRIDGE_TOKEN");
    std::env::remove_var("RLM_CELL_ID");
    rlm::test_support::reset_connection();
    result
}

#[test]
fn request_round_trip_and_error_status() {
    let mut host = mock_host(|frame| {
        assert_eq!(frame["kind"], "req");
        if frame["type"] == "echo.ok" {
            Some(json!({"v":1,"kind":"res","id":frame["id"],"status":"ok","payload":{"echo":frame["payload"]}}))
        } else {
            Some(json!({"v":1,"kind":"res","id":frame["id"],"status":"error","error":"nope"}))
        }
    });
    with_bridge_env(host.port, "tok-ok", || {
        let ok = rlm::host_request("echo.ok", json!({"x": 1})).unwrap();
        assert_eq!(ok, json!({"echo": {"x": 1}}));

        // Host-reported errors surface as rlm::Error{kind: Host} and keep the
        // connection usable for the next request.
        let err = rlm::host_request("echo.err", json!({})).unwrap_err();
        let typed = err.downcast_ref::<rlm::Error>().unwrap();
        assert_eq!(typed.kind, rlm::ErrorKind::Host);
        assert_eq!(typed.message, "nope");

        let again = rlm::host_request("echo.ok", json!({"y": 2})).unwrap();
        assert_eq!(again, json!({"echo": {"y": 2}}));
    });
    let seen = host.handle.take().unwrap();
    drop(host);
    let frames = seen.join().unwrap();
    // hello + three requests over ONE connection (host errors don't reconnect).
    assert_eq!(frames.len(), 4);
    assert_eq!(frames[0]["kind"], "hello");
}

#[test]
fn handshake_rejection_is_a_bridge_error() {
    let host = mock_host(|_| None);
    with_bridge_env(host.port, "tok-bad", || {
        let err = rlm::host_request("any.type", json!({})).unwrap_err();
        let typed = err.downcast_ref::<rlm::Error>().unwrap();
        assert_eq!(typed.kind, rlm::ErrorKind::Bridge);
    });
}

#[test]
fn missing_env_is_a_bridge_error() {
    let _guard = ENV_LOCK.lock().unwrap();
    rlm::test_support::reset_connection();
    std::env::remove_var("RLM_BRIDGE_ADDR");
    let err = rlm::host_request("any.type", json!({})).unwrap_err();
    let typed = err.downcast_ref::<rlm::Error>().unwrap();
    assert_eq!(typed.kind, rlm::ErrorKind::Bridge);
    assert!(typed.message.contains("RLM_BRIDGE_ADDR"), "{}", typed.message);
}

#[test]
fn spawn_parses_the_handle_and_sends_kwargs() {
    let mut host = mock_host(|frame| {
        assert_eq!(frame["type"], "rlm.run");
        assert_eq!(frame["payload"]["prompt"], "review the API");
        assert_eq!(frame["payload"]["kwargs"]["name"], "api-reviewer");
        Some(json!({"v":1,"kind":"res","id":frame["id"],"status":"ok","payload":{
            "rlm_child_id":"c1","name":"api-reviewer","session_dir":"/tmp/x","model":"prov/m1"
        }}))
    });
    with_bridge_env(host.port, "tok-ok", || {
        let handle = rlm::spawn_named("review the API", "api-reviewer").unwrap();
        assert_eq!(handle.rlm_child_id, "c1");
        assert_eq!(handle.name, "api-reviewer");
        assert_eq!(handle.model, "prov/m1");
    });
    host.handle.take().unwrap().join().unwrap();
}

#[test]
fn emit_waits_for_the_matching_ack() {
    let mut host = mock_host(|frame| {
        assert_eq!(frame["kind"], "emit");
        assert_eq!(frame["type"], "display.diff");
        Some(json!({"v":1,"kind":"ack","id":frame["id"]}))
    });
    with_bridge_env(host.port, "tok-ok", || {
        rlm::display::diff("a.rs", "old", "new").unwrap();
    });
    let frames = host.handle.take().unwrap().join().unwrap();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[1]["payload"]["oldStr"], "old");
    assert_eq!(frames[1]["payload"]["newStr"], "new");
}

#[test]
fn agent_message_payloads_match_the_host_contract() {
    let mut host = mock_host(|frame| {
        let payload = &frame["payload"];
        let reply = match frame["type"].as_str().unwrap() {
            "agent_message.send" if payload["target"] == "all" => json!({"receipts": []}),
            "agent_message.send" => {
                assert_eq!(payload["receiver_role"], "parent");
                assert_eq!(payload["receiver_name"], Value::Null);
                json!({"id":"m1","message":payload["message"],"deliveryStatus":"queued",
                       "target":{"activeSessionId":"a","sessionId":"s"}})
            }
            "agent_message.list_agents" => json!({"entries":[
                {"id":"p1","name":"parent","relationship":"parent"}
            ]}),
            other => panic!("unexpected type {other}"),
        };
        Some(json!({"v":1,"kind":"res","id":frame["id"],"status":"ok","payload":reply}))
    });
    with_bridge_env(host.port, "tok-ok", || {
        let receipt = rlm::msg::send_to_parent("done").unwrap();
        assert_eq!(receipt["deliveryStatus"], "queued");
        rlm::msg::broadcast("hi all").unwrap();
        let roster = rlm::msg::list_agents().unwrap();
        assert_eq!(roster.len(), 1);
        assert_eq!(roster[0].relationship, "parent");
    });
    host.handle.take().unwrap().join().unwrap();
}

#[test]
fn deps_add_is_locked() {
    let err = rlm::deps::add("tokio").unwrap_err();
    let typed = err.downcast_ref::<rlm::Error>().unwrap();
    assert_eq!(typed.kind, rlm::ErrorKind::Host);
    assert!(typed.message.contains("locked"), "{}", typed.message);
}

#[test]
fn ack_errors_surface_as_host_errors_and_keep_the_connection() {
    let mut host = mock_host(|frame| match frame["kind"].as_str().unwrap() {
        "emit" if frame["id"] == 1 => Some(json!({
            "v":1,"kind":"ack","id":frame["id"],
            "error":"attachment could not be processed: bad image"
        })),
        "emit" => Some(json!({"v":1,"kind":"ack","id":frame["id"]})),
        other => panic!("unexpected kind {other}"),
    });
    with_bridge_env(host.port, "tok-ok", || {
        let err = rlm::display::diff("a.rs", "old", "new").unwrap_err();
        let message = format!("{err:#}");
        assert!(message.contains("bad image"), "unexpected error: {message}");
        // Host-reported errors keep the connection: the next emit succeeds on
        // the same socket.
        rlm::display::diff("b.rs", "x", "y").unwrap();
    });
    let frames = host.handle.take().unwrap().join().unwrap();
    // hello + two emits on ONE connection.
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[0]["kind"], "hello");
    assert_eq!(frames[1]["payload"]["path"], "a.rs");
    assert_eq!(frames[2]["payload"]["path"], "b.rs");
}
