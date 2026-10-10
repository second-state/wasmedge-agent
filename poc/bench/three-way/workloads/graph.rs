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

fn words(bytes: &[u8]) -> Vec<u32> {
    bytes
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect()
}

fn encode(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|n| n.to_le_bytes()).collect()
}

fn graph(cfg: &serde_json::Value, batch: usize) -> Result<()> {
    let start = Instant::now();
    let index = if batch == 0 {
        let input = words(&std::fs::read("/workspace/graph.bin")?);
        let (nodes, edges, queries) = (input[0] as usize, input[1] as usize, input[2] as usize);
        let mut offsets = vec![0u32; nodes + 1];
        for edge in input[3..3 + edges * 2].chunks_exact(2) {
            offsets[edge[1] as usize + 1] += 1;
        }
        for i in 0..nodes {
            offsets[i + 1] += offsets[i];
        }
        let mut cursor = offsets[..nodes].to_vec();
        let mut neighbors = vec![0u32; edges];
        for edge in input[3..3 + edges * 2].chunks_exact(2) {
            let dep = edge[1] as usize;
            neighbors[cursor[dep] as usize] = edge[0];
            cursor[dep] += 1;
        }
        let mut index = vec![nodes as u32, edges as u32, queries as u32];
        index.extend(offsets);
        index.extend(neighbors);
        index.extend_from_slice(&input[3 + edges * 2..]);
        rlm::state::put_blob("bench-graph", &encode(&index))?;
        index
    } else {
        words(&rlm::state::get_blob("bench-graph")?.ok_or_else(|| anyhow!("Missing graph index"))?)
    };
    let (nodes, edges, queries) = (index[0] as usize, index[1] as usize, index[2] as usize);
    let offsets = &index[3..4 + nodes];
    let neighbors = &index[4 + nodes..4 + nodes + edges];
    let roots = &index[4 + nodes + edges..];
    phase("guest.index_load_build", start);
    let (lo, hi) = (
        queries * batch / size(cfg, "batches"),
        queries * (batch + 1) / size(cfg, "batches"),
    );
    let start = Instant::now();
    let width = (nodes + 7) / 8;
    let mut result = vec![0u8; width * (hi - lo)];
    let mut visited = vec![false; nodes];
    let mut queue = vec![0usize; nodes];
    let mut visited_edges = 0u64;
    for query in lo..hi {
        visited.fill(false);
        let root = roots[query] as usize;
        let (mut head, mut tail) = (0, 1);
        queue[0] = root;
        visited[root] = true;
        let base = (query - lo) * width;
        result[base + (root >> 3)] |= 1 << (root & 7);
        while head < tail {
            let node = queue[head];
            head += 1;
            for i in offsets[node] as usize..offsets[node + 1] as usize {
                visited_edges += 1;
                let child = neighbors[i] as usize;
                if !visited[child] {
                    visited[child] = true;
                    queue[tail] = child;
                    tail += 1;
                    result[base + (child >> 3)] |= 1 << (child & 7);
                }
            }
        }
    }
    std::hint::black_box(&result);
    phase("guest.compute", start);
    let start = Instant::now();
    std::fs::write(format!("/workspace/result-{batch}.bin"), result)?;
    phase("guest.output_write", start);
    println!(
        "BENCH_COUNTERS:{}",
        serde_json::json!({"visitedEdges":visited_edges,"queries":hi-lo})
    );
    Ok(())
}

fn main() -> Result<()> {
    let cfg: serde_json::Value =
        serde_json::from_slice(&std::fs::read("/workspace/workload.json")?)?;
    let batch: usize = std::fs::read_to_string("/workspace/batch-index.txt")?
        .trim()
        .parse()?;
    graph(&cfg, batch)?;
    println!("BENCH_OK");
    Ok(())
}
