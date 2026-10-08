use pa_core::kernel::{
    bootstrap::build_rlm_bootstrap_code,
    cancellation::AbortSignal,
    manager::{KernelStartOptions, ReplKernelManager},
    shared::{
        ExecuteOptions, HostRequestHandlers, KernelManagerOptions, KernelShutdownOptions,
        KernelSnapshotConfig, host_handler,
    },
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, time::Instant};
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let workspace = PathBuf::from(std::env::var("BENCH_WORKSPACE")?);
    let bootstrap = build_rlm_bootstrap_code(&[]);
    let mut handlers = HostRequestHandlers::new();
    handlers.register("bench.command", host_handler(|payload| async move {
        let start=Instant::now();
        let output=tokio::process::Command::new("/bin/sh").arg("-c").arg(payload.data["command"].as_str().unwrap_or("")).current_dir(std::env::var("BENCH_PROJECT")?).output().await?;
        println!("{}",json!({"event":"native_command","durationMs":start.elapsed().as_secs_f64()*1000.0}));
        Ok(json!({"stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr),"exitCode":output.status.code()}))
    }));
    handlers.register("bench.echo", host_handler(|payload| async move {
        let start = Instant::now();
        if let Some(delay) = payload.data.get("delayMs").and_then(Value::as_u64) {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        println!("{}", json!({"event":"host_handler", "durationMs":start.elapsed().as_secs_f64()*1000.0, "bytes":payload.data.to_string().len()}));
        Ok(payload.data)
    }));
    let manager = ReplKernelManager::new(KernelManagerOptions {
        python: Some(PathBuf::from(std::env::var("BENCH_PYTHON")?)),
        cwd: Some(PathBuf::from(std::env::var("BENCH_PROJECT")?)),
        env: HashMap::new(),
        session_id: Some("direct-benchmark".into()),
        host_handlers: handlers,
        snapshot: Some(KernelSnapshotConfig {
            path: workspace.join("state.dill"),
            manifest_path: workspace.join("state.json"),
            max_bytes: None,
            max_variable_bytes: None,
            debounce_ms: Some(60000),
        }),
        bootstrap_code: Some(bootstrap.clone()),
        ..Default::default()
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let request: Value = serde_json::from_str(&line)?;
        let start = Instant::now();
        let op = request["op"].as_str().unwrap_or("execute");
        let result: anyhow::Result<Value> = async {
            match op {
                "start" => {manager.start(KernelStartOptions::default()).await?; let value=manager.execute(&bootstrap, ExecuteOptions::default()).await?; Ok(json!({"status":value.status.as_str()}))},
                "snapshot" => {let value=manager.snapshot_state().await.ok_or_else(||anyhow::anyhow!("Snapshot unavailable"))?; Ok(json!({"status":"ok", "bytes":value.bytes, "saved":value.saved}))},
                "restore" => {let value=manager.restore_state().await.ok_or_else(||anyhow::anyhow!("Restore unavailable"))?; Ok(json!({"status":"ok", "restored":value.restored}))},
                "restart" => {manager.restart().await?; Ok(json!({"status":"ok"}))},
                "dispose" => {manager.shutdown(KernelShutdownOptions {snapshot:false,drain_host_requests:false}).await?; Ok(json!({"status":"ok"}))},
                _ => {
                    let signal = AbortSignal::new();
                    let timer = request["abortAfterMs"].as_u64().map(|delay| {let signal=signal.clone(); tokio::spawn(async move {tokio::time::sleep(std::time::Duration::from_millis(delay)).await; signal.abort();})});
                    let result=manager.execute(request["code"].as_str().unwrap_or("pass"), ExecuteOptions {signal:Some(signal),max_output_chars:Some(2000000),..Default::default()}).await;
                    if let Some(timer)=timer {timer.abort();}
                    let value=result?;
                    let error=value.error.map(|error|json!({"ename":error.ename,"evalue":error.evalue,"traceback":error.traceback}));
                    Ok(json!({"status":value.status.as_str(),"stdout":value.stdout,"stderr":value.stderr,"result":value.result,"error":error,"durationMs":value.duration_ms}))
                }
            }
        }.await;
        let output = match result {
            Ok(value) => {
                json!({"id":request["id"],"status":value["status"],"durationMs":start.elapsed().as_secs_f64()*1000.0,"result":value})
            }
            Err(error) => {
                json!({"id":request["id"],"status":"error","durationMs":start.elapsed().as_secs_f64()*1000.0,"error":error.to_string()})
            }
        };
        println!("{output}");
        if op == "dispose" {
            break;
        }
    }
    let _ = manager
        .shutdown(KernelShutdownOptions {
            snapshot: false,
            drain_host_requests: false,
        })
        .await;
    Ok(())
}
