import json
import struct
import sys
import time
from array import array
from pathlib import Path


def bench_phase(name, start):
    print("BENCH_PHASE:" + json.dumps({"name": name, "durationMs": (time.perf_counter_ns() - start) / 1e6}))


def bench_graph(cfg, batch):
    global _bench_csr
    start = time.perf_counter_ns()
    if batch == 0:
        data = Path("graph.bin").read_bytes()
        nodes, edges, queries = struct.unpack_from("<III", data)
        words = array("I")
        words.frombytes(data[12:])
        if sys.byteorder != "little":
            words.byteswap()
        offsets = array("I", [0]) * (nodes + 1)
        for i in range(edges):
            offsets[words[i * 2 + 1] + 1] += 1
        for i in range(nodes):
            offsets[i + 1] += offsets[i]
        cursor = offsets[:-1]
        neighbors = array("I", [0]) * edges
        for i in range(edges):
            depender, dependency = words[i * 2], words[i * 2 + 1]
            neighbors[cursor[dependency]] = depender
            cursor[dependency] += 1
        _bench_csr = nodes, offsets, neighbors, words[edges * 2:], queries
    nodes, offsets, neighbors, roots, queries = _bench_csr
    bench_phase("guest.index_load_build", start)
    lo, hi = queries * batch // cfg["batches"], queries * (batch + 1) // cfg["batches"]
    start = time.perf_counter_ns()
    width = (nodes + 7) // 8
    result = bytearray(width * (hi - lo))
    visited = bytearray(nodes)
    queue = array("I", [0]) * nodes
    visited_edges = 0
    for query in range(lo, hi):
        visited[:] = bytes(nodes)
        root = roots[query]
        queue[0], head, tail = root, 0, 1
        visited[root] = 1
        base = (query - lo) * width
        result[base + (root >> 3)] |= 1 << (root & 7)
        while head < tail:
            node = queue[head]
            head += 1
            for i in range(offsets[node], offsets[node + 1]):
                visited_edges += 1
                child = neighbors[i]
                if not visited[child]:
                    visited[child] = 1
                    queue[tail] = child
                    tail += 1
                    result[base + (child >> 3)] |= 1 << (child & 7)
    bench_phase("guest.compute", start)
    start = time.perf_counter_ns()
    Path(f"result-{batch}.bin").write_bytes(result)
    bench_phase("guest.output_write", start)
    print("BENCH_COUNTERS:" + json.dumps({"visitedEdges": visited_edges, "queries": hi - lo}))


def bench_events(cfg, batch):
    global _bench_event_states
    start = time.perf_counter_ns()
    if batch == 0:
        _bench_event_states = [[0, 0, 0, -1, 0, 0, 0, 0, 0, 0] for _ in range(cfg["keys"])]
    states = _bench_event_states
    bench_phase("guest.state_load", start)

    def transition(timestamp, key, seq, amount, kind):
        s = states[key]
        if seq <= s[3]:
            s[4] += 1
            return
        s[3] = seq
        if s[0] and timestamp - s[1] > 30000:
            s[5] += 1
            s[0], s[2] = 0, 0
        if kind == 1 and not s[0]:
            s[0], s[1], s[2] = 1, timestamp, 0
        elif kind == 2 and s[0] and amount >= 0:
            s[2] += amount
        elif kind == 3 and s[0]:
            s[7] += 1
            s[9] += s[2]
            s[0], s[2] = 0, 0
        elif kind == 4 and s[0]:
            s[8] += 1
            s[0], s[2] = 0, 0
        else:
            s[6] += 1

    start = time.perf_counter_ns()
    count = 0
    if cfg["format"] == "binary":
        pending = b""
        with open(f"events-{batch}.bin", "rb") as source:
            while chunk := source.read(cfg.get("chunkBytes", 65536)):
                pending += chunk
                boundary = len(pending) // 32 * 32
                for event in struct.iter_unpack("<QIIqB7x", pending[:boundary]):
                    transition(*event)
                    count += 1
                pending = pending[boundary:]
        if pending:
            raise ValueError("Truncated event record")
    else:
        with open(f"events-{batch}.jsonl") as source:
            for line in source:
                transition(*json.loads(line))
                count += 1
    bench_phase("guest.stream_compute", start)
    start = time.perf_counter_ns()
    Path(f"result-{batch}.json").write_text(json.dumps(states))
    bench_phase("guest.output_write", start)
    print("BENCH_COUNTERS:" + json.dumps({"events": count}))


def bench_simulation(cfg, batch):
    start = time.perf_counter_ns()
    data = Path(f"seeds-{batch}.bin").read_bytes()
    choices = Path(f"simulation-events-{batch}.bin").read_bytes() if cfg["simulationMode"] == "events" else None
    bench_phase("guest.input_read", start)
    start = time.perf_counter_ns()
    steps = cfg["steps"]
    records = bytearray(len(data) * 4)
    for row, (seed,) in enumerate(struct.iter_unpack("<I", data)):
        x, q, completed, expired, rejected = seed, 0, 0, 0, 0
        for i in range(steps):
            if choices is None:
                x = (x * 1664525 + 1013904223) & 0xffffffff
                kind = x >> 30
            else:
                kind = choices[row * steps + i]
            if kind < 2:
                if q < 64:
                    q += 1
                else:
                    rejected += 1
            elif kind == 2:
                if q:
                    q -= 1
                    completed += 1
            elif q:
                q -= 1
                expired += 1
        struct.pack_into("<IIII", records, row * 16, q, completed, expired, rejected)
    bench_phase("guest.compute", start)
    start = time.perf_counter_ns()
    Path(f"result-{batch}.bin").write_bytes(records)
    bench_phase("guest.output_write", start)
    print("BENCH_COUNTERS:" + json.dumps({"trajectories": len(data) // 4, "steps": len(data) // 4 * steps}))


_bench_cfg = json.loads(Path("workload.json").read_text())
_bench_batch = int(Path("batch-index.txt").read_text())
{"graph": bench_graph, "events": bench_events, "simulation": bench_simulation}[_bench_cfg["kind"]](_bench_cfg, _bench_batch)
print("BENCH_OK")
