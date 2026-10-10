use agent_lib::prelude::*;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
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

fn events(cfg: &serde_json::Value, batch: usize) -> Result<()> {
    let start = Instant::now();
    let mut states: Vec<[i64; 10]> = if batch == 0 {
        vec![[0, 0, 0, -1, 0, 0, 0, 0, 0, 0]; size(cfg, "keys")]
    } else {
        serde_json::from_slice(
            &rlm::state::get_blob("bench-events")?.ok_or_else(|| anyhow!("Missing event state"))?,
        )?
    };
    phase("guest.state_load", start);
    let mut transition = |timestamp: i64, key: usize, seq: i64, amount: i64, kind: i64| {
        let s = &mut states[key];
        if seq <= s[3] {
            s[4] += 1;
            return;
        }
        s[3] = seq;
        if s[0] != 0 && timestamp - s[1] > 30000 {
            s[5] += 1;
            s[0] = 0;
            s[2] = 0;
        }
        if kind == 1 && s[0] == 0 {
            s[0] = 1;
            s[1] = timestamp;
            s[2] = 0;
        } else if kind == 2 && s[0] != 0 && amount >= 0 {
            s[2] += amount;
        } else if kind == 3 && s[0] != 0 {
            s[7] += 1;
            s[9] += s[2];
            s[0] = 0;
            s[2] = 0;
        } else if kind == 4 && s[0] != 0 {
            s[8] += 1;
            s[0] = 0;
            s[2] = 0;
        } else {
            s[6] += 1;
        }
    };
    let start = Instant::now();
    let mut count = 0;
    if cfg["format"] == "binary" {
        let mut source = BufReader::new(File::open(format!("/workspace/events-{batch}.bin"))?);
        loop {
            let mut bytes = [0u8; 32];
            let mut read = 0;
            while read < 32 {
                let n = source.read(&mut bytes[read..])?;
                if n == 0 {
                    break;
                }
                read += n;
            }
            if read == 0 {
                break;
            }
            if read != 32 {
                return Err(anyhow!("Truncated event record"));
            }
            transition(
                u64::from_le_bytes(bytes[..8].try_into()?) as i64,
                u32::from_le_bytes(bytes[8..12].try_into()?) as usize,
                u32::from_le_bytes(bytes[12..16].try_into()?) as i64,
                i64::from_le_bytes(bytes[16..24].try_into()?),
                bytes[24] as i64,
            );
            count += 1;
        }
    } else {
        for line in BufReader::new(File::open(format!("/workspace/events-{batch}.jsonl"))?).lines()
        {
            let event: [i64; 5] = serde_json::from_str(&line?)?;
            transition(event[0], event[1] as usize, event[2], event[3], event[4]);
            count += 1;
        }
    }
    phase("guest.stream_compute", start);
    let start = Instant::now();
    let bytes = serde_json::to_vec(&states)?;
    rlm::state::put_blob("bench-events", &bytes)?;
    std::fs::write(format!("/workspace/result-{batch}.json"), bytes)?;
    phase("guest.output_write", start);
    println!("BENCH_COUNTERS:{}", serde_json::json!({"events":count}));
    Ok(())
}

fn main() -> Result<()> {
    let cfg: serde_json::Value =
        serde_json::from_slice(&std::fs::read("/workspace/workload.json")?)?;
    let batch: usize = std::fs::read_to_string("/workspace/batch-index.txt")?
        .trim()
        .parse()?;
    events(&cfg, batch)?;
    println!("BENCH_OK");
    Ok(())
}
