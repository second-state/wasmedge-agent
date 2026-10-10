use agent_lib::prelude::*;
use std::time::Instant;

fn phase(name: &str, start: Instant) {
    println!(
        "BENCH_PHASE:{}",
        serde_json::json!({"name":name,"durationMs":start.elapsed().as_secs_f64()*1000.0})
    );
}

fn size(cfg: &serde_json::Value, key: &str) -> usize {
    cfg[key].as_u64().unwrap() as usize
}

fn encode(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|n| n.to_le_bytes()).collect()
}

fn simulation(cfg: &serde_json::Value, batch: usize) -> Result<()> {
    let start = Instant::now();
    let input = std::fs::read(format!("/workspace/seeds-{batch}.bin"))?;
    let choices = if cfg["simulationMode"] == "events" {
        Some(std::fs::read(format!(
            "/workspace/simulation-events-{batch}.bin"
        ))?)
    } else {
        None
    };
    phase("guest.input_read", start);
    let start = Instant::now();
    let steps = size(cfg, "steps");
    let mut result = vec![0u32; input.len()];
    for (row, bytes) in input.chunks_exact(4).enumerate() {
        let (mut x, mut q, mut completed, mut expired, mut rejected) = (
            u32::from_le_bytes(bytes.try_into()?),
            0u32,
            0u32,
            0u32,
            0u32,
        );
        for step in 0..steps {
            let kind = if let Some(events) = &choices {
                events[row * steps + step] as u32
            } else {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                x >> 30
            };
            if kind < 2 {
                if q < 64 {
                    q += 1;
                } else {
                    rejected += 1;
                }
            } else if kind == 2 {
                if q > 0 {
                    q -= 1;
                    completed += 1;
                }
            } else if q > 0 {
                q -= 1;
                expired += 1;
            }
        }
        result[row * 4..row * 4 + 4].copy_from_slice(&[q, completed, expired, rejected]);
    }
    std::hint::black_box(&result);
    let bytes = encode(&result);
    phase("guest.compute", start);
    let start = Instant::now();
    std::fs::write(format!("/workspace/result-{batch}.bin"), bytes)?;
    phase("guest.output_write", start);
    println!(
        "BENCH_COUNTERS:{}",
        serde_json::json!({"trajectories":input.len()/4,"steps":input.len()/4*steps})
    );
    Ok(())
}

fn main() -> Result<()> {
    let cfg: serde_json::Value =
        serde_json::from_slice(&std::fs::read("/workspace/workload.json")?)?;
    let batch: usize = std::fs::read_to_string("/workspace/batch-index.txt")?
        .trim()
        .parse()?;
    simulation(&cfg, batch)?;
    println!("BENCH_OK");
    Ok(())
}
