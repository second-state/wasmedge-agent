#!/usr/bin/env python3
"""Render the consolidated report from saved evidence; never invoke a model."""

import csv
import hashlib
import html
import io
import json
import os
from pathlib import Path
import re
from statistics import median

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "poc/bench/results"
OUTPUT = ROOT / "docs"
ASSETS = OUTPUT / "assets/rust-cell-report-2026-10-08"
ARTIFACTS = RESULTS / "consolidated-report-20261008-01"
ASSETS.mkdir(parents=True, exist_ok=True)
ARTIFACTS.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(ARTIFACTS / "matplotlib"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

VARIANTS = ["prime-ts", "prime-rust", "wasmedge", "wasmedge-aot"]
LABELS = ["Prime TS / Python", "Prime Rust / Python", "Rust / interpreter", "Rust / AOT"]
COLORS = ["#087f8c", "#6654b1", "#ac6b13", "#167d57"]
RUNTIME = "four-way-aot-bridge-runtime-01"
PAID = "four-way-opus55-aot-bridge-01"
BRIDGE = "bridge-readiness-diagnostic-20261008-01"
HASHES = {}


def load(relative):
    path = ROOT / relative
    raw = path.read_bytes()
    HASHES[relative] = hashlib.sha256(raw).hexdigest()
    return json.loads(raw)


def table(headers, rows):
    return "\n".join([
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
        *("| " + " | ".join(str(value) for value in row) + " |" for row in rows),
    ])


def svg(fig, name):
    stream = io.StringIO()
    fig.savefig(stream, format="svg", bbox_inches="tight", metadata={"Date": None})
    plt.close(fig)
    result = stream.getvalue()
    result = result[result.index("<svg"):]
    result = result.replace("<svg ", '<svg role="img" aria-label="' + html.escape(name) + '" ', 1)
    result = "\n".join(line.rstrip() for line in result.splitlines()) + "\n"
    (ASSETS / name).write_text(result)
    return result


plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10, "svg.fonttype": "none",
    "svg.hashsalt": "rust-cell-report-2026-10-08", "axes.spines.top": False,
    "axes.spines.right": False, "axes.spines.left": False, "axes.axisbelow": True,
    "axes.edgecolor": "#b1beca", "text.color": "#203043",
    "axes.labelcolor": "#203043", "xtick.color": "#526276", "ytick.color": "#203043",
    "figure.facecolor": "white", "axes.facecolor": "white",
})
runtime = load(f"poc/bench/results/{RUNTIME}/report.json")
paid = load(f"poc/bench/results/{PAID}/report.json")
prepared = load(f"poc/bench/results/{PAID}/prepared.json")
bridge = load(f"poc/bench/results/{BRIDGE}/summary.json")
validation = load("poc/bench/results/consolidated-report-20261008-01/security-validation.json")
for campaign, expected in [(runtime, 72), (paid, 16)]:
    assert campaign["recordedRuns"] == campaign["plannedRuns"] == expected
    assert sum(row["passed"] for row in campaign["taskSummary"]) == expected
    assert not campaign["integrityErrors"]
    assert all(row["state"] == "measured" for row in campaign["cellExecutionRuns"])
    for row in campaign["compilationAdjustedRuns"]:
        assert row["agentWithoutAllCompilationMs"] is not None
        assert abs(row["agentMs"] - row["agentCompilerMs"] - row["agentWithoutAllCompilationMs"]) < 1e-6
assert validation["success"] and validation["numFailedTests"] == 0

cases = sorted({row["caseId"] for row in runtime["cellExecutionRuns"]})
runtime_data = []
for case in cases:
    values = []
    for variant in VARIANTS:
        rows = [r for r in runtime["cellExecutionRuns"] if r["caseId"] == case and r["variantId"] == variant]
        assert len(rows) == 3
        values.append({"variant": variant, "n": 3, "ms": median(r["totalExecutionMs"] for r in rows)})
    runtime_data.append({"case": case, "values": values})
paid_cases = sorted({row["caseId"] for row in paid["cellExecutionRuns"]})
paid_rows = {(row["caseId"], row["variantId"]): row for row in paid["compilationAdjustedRuns"]}
cell_rows = {(row["caseId"], row["variantId"]): row for row in paid["cellExecutionRuns"]}
svgs = {}

for scale in ["linear", "log"]:
    fig, axes = plt.subplots(3, 2, figsize=(12, 10.2), layout="constrained")
    for ax, case in zip(axes.flat, runtime_data):
        values = [row["ms"] for row in case["values"]]
        ax.barh(range(4), values, color=COLORS, height=0.62)
        ax.set_yticks(range(4), LABELS, fontsize=9)
        ax.invert_yaxis()
        ax.set_title(case["case"], loc="left", fontweight="bold")
        ax.set_xlabel("Cell execution total / run (ms), median n=3")
        ax.grid(axis="x", alpha=0.2)
        if scale == "log":
            ax.set_xscale("symlog", linthresh=1)
            ax.set_xlim(0, max(values) * 2.8)
        else:
            ax.set_xlim(0, max(values) * 1.35)
        for i, value in enumerate(values):
            ax.annotate(f"{value:.2f} ms", (value, i), xytext=(5, 0), textcoords="offset points", va="center", fontsize=9)
    svgs[f"runtime-{scale}"] = svg(fig, f"runtime-{scale}.svg")

for period in ["agent", "user", "validated"]:
    for scope in ["cargo", "all"]:
        fig, axes = plt.subplots(2, 2, figsize=(12, 7.2), layout="constrained")
        for ax, case in zip(axes.flat, paid_cases):
            for i, variant in enumerate(VARIANTS):
                row = paid_rows[(case, variant)]
                total = row[f"{period}Ms"] / 1000
                cargo = row[f"{period}CargoMs"] / 1000
                compiler = row[f"{period}CompilerMs"] / 1000
                aot = compiler - cargo if scope == "all" else 0
                remainder = total - cargo - aot
                ax.barh(i, remainder, color=COLORS[i], height=0.6)
                ax.barh(i, cargo, left=remainder, color="#9caabb", height=0.6)
                if aot:
                    ax.barh(i, aot, left=remainder + cargo, color="#dc977d", height=0.6)
                ax.annotate(f"{total:.2f} s", (total, i), xytext=(5, 0), textcoords="offset points", va="center", fontsize=9)
            ax.set_yticks(range(4), LABELS, fontsize=9)
            ax.invert_yaxis()
            ax.set_title(case.replace("E-", "E"), loc="left", fontweight="bold")
            ax.set_xlabel("Elapsed seconds (n=1); labels show raw total")
            ax.set_xlim(0, max(paid_rows[(case, v)][f"{period}Ms"] / 1000 for v in VARIANTS) * 1.28)
            ax.grid(axis="x", alpha=0.2)
        svgs[f"paid-{period}-{scope}"] = svg(fig, f"paid-{period}-{scope}.svg")

fig, axes = plt.subplots(1, 2, figsize=(12, 4), layout="constrained")
for ax, case, title in zip(axes, ["diff", "bridge"], ["One diff / ack", "100 echo requests x 1 KiB"]):
    rows = [r for r in bridge if r["case"] == case]
    assert all(row["n"] == 15 for row in rows)
    values = [r["processMedianMs"] for r in rows]
    ax.barh(range(3), values, color=["#9caabb", COLORS[2], COLORS[3]], height=0.6)
    ax.set_yticks(range(3), ["Old 5 ms polling", "Readiness / interpreter", "Readiness / AOT"], fontsize=9)
    ax.invert_yaxis()
    ax.set_title(title, loc="left", fontweight="bold")
    ax.set_xlabel("Process wall time (ms), median n=15")
    ax.set_xlim(0, max(values) * 1.3)
    ax.grid(axis="x", alpha=0.2)
    for i, value in enumerate(values):
        ax.annotate(f"{value:.2f} ms", (value, i), xytext=(5, 0), textcoords="offset points", va="center", fontsize=9)
svgs["bridge"] = svg(fig, "bridge.svg")

fig, ax = plt.subplots(figsize=(12, 5.2))
ax.set_xlim(0, 12)
ax.set_ylim(0, 5.2)
ax.axis("off")


def box(x, y, width, height, title, body, color, dashed=False):
    ax.add_patch(FancyBboxPatch((x, y), width, height, boxstyle="round,pad=0.14", facecolor=color,
                              edgecolor="#7e91a3", linewidth=1, linestyle="--" if dashed else "-"))
    ax.text(x + 0.15, y + height - 0.25, title, weight="bold", va="top", fontsize=12)
    ax.text(x + 0.15, y + height - 0.68, body, va="top", fontsize=10, linespacing=1.6)


box(0.2, 2.75, 4.4, 2.1, "TypeScript host (trusted)", "Model credentials / registered handlers\nTool selection / session management\nBash and handlers retain OS permissions", "#e7f1f7")
box(5.25, 2.75, 6.3, 2.1, "WasmEdge guest (interpreter or host AOT)", "Non-network WASI import allowlist\nExplicit project / state / lib / scratch preopens\nCell deadline; optional gas / memory pages\nPrivate stdio bridge to selected host handlers", "#e5f4ec")
box(0.2, 0.15, 4.4, 1.8, "Cargo / AOT compiler (trusted toolchain)", "Environment allowlist\nCargo sandbox / cgroup: Linux opt-in\nNo whole-agent sandbox guarantee", "#fff3df", True)
box(5.25, 0.15, 6.3, 1.8, "Admission and artifact checks", "Inspect imports; strip guest custom sections\nHost AOT only; verify core Wasm / provenance\nCompiled artifacts are outside guest preopens", "#eef0fa")
for start, end in [((4.8, 3.8), (5.1, 3.8)), ((4.8, 1.0), (5.1, 1.0)), ((8.4, 2.1), (8.4, 2.6))]:
    ax.add_patch(FancyArrowPatch(start, end, arrowstyle="<->" if start[1] > 3 else "->", mutation_scale=14, color="#526276"))
svgs["boundary"] = svg(fig, "boundary.svg")

parts = {}
parts["variants"] = table(["組別", "Host", "Cell 與 runtime", "固定 revision"], [
    [LABELS[i], "Rust" if v == "prime-rust" else "TypeScript", "Python resident kernel" if i < 2 else ("Rust / WasmEdge " + ("interpreter" if i == 2 else "AOT")), f"`{prepared['variants'][i]['baseRevision'][:12]}`" + (" + runtime patch" if i >= 2 else "")]
    for i, v in enumerate(VARIANTS)
])
parts["runtime"] = table(["案例", *LABELS], [[r["case"], *(f"{v['ms']:.3f}" for v in r["values"])] for r in runtime_data])
parts["paid_raw"] = table(["任務", *LABELS], [[c, *(f"{paid_rows[(c, v)]['agentMs'] / 1000:.3f}" for v in VARIANTS)] for c in paid_cases])
parts["paid_compilation"] = table(["任務", "Rust runtime", "原始 agent", "全部 Cargo", "AOT", "扣除兩者後"], [
    [c, LABELS[VARIANTS.index(v)], *(f"{paid_rows[(c, v)][k] / 1000:.3f}" for k in ["agentMs", "agentCargoMs", "agentAotMs", "agentWithoutAllCompilationMs"])]
    for c in paid_cases for v in VARIANTS[2:]
])
parts["paid_cells"] = table(["任務", "版本", "成功／runtime 失敗／Cargo 失敗", "Cell 執行合計 ms"], [
    [c, LABELS[VARIANTS.index(v)], "/".join(str(cell_rows[(c, v)][k]) for k in ["successfulCells", "runtimeFailures", "compileFailures"]), f"{cell_rows[(c, v)]['totalExecutionMs']:.3f}"]
    for c in paid_cases for v in VARIANTS
])
usage_path = ROOT / f"poc/bench/results/{PAID}/requests.csv"
HASHES[str(usage_path.relative_to(ROOT))] = hashlib.sha256(usage_path.read_bytes()).hexdigest()
usage_rows = list(csv.DictReader(io.StringIO(usage_path.read_text())))
assert len(usage_rows) == paid["paidRequests"] == 70
usage_totals = {variant: {"requests": 0, "prompt": 0, "cached": 0, "output": 0} for variant in VARIANTS}
for row in usage_rows:
    assert row["usage"] and row["upstreamStatus"] == "200"
    usage = json.loads(row["usage"])
    totals = usage_totals[row["variantId"]]
    totals["requests"] += 1
    totals["prompt"] += usage["prompt_tokens"]
    totals["cached"] += usage.get("prompt_tokens_details", {}).get("cached_tokens", 0)
    totals["output"] += usage["completion_tokens"]
parts["usage"] = table(["版本", "Requests", "Prompt tokens", "其中 cached", "Output tokens"], [
    [LABELS[i], *(f"{usage_totals[variant][key]:,}" for key in ["requests", "prompt", "cached", "output"])]
    for i, variant in enumerate(VARIANTS)
])
parts["bridge"] = table(["工作", "舊 polling ms", "Readiness interpreter ms", "Readiness AOT ms"], [
    ["一次 diff／ack" if case == "diff" else "100 echo × 1 KiB", *(f"{r['processMedianMs']:.3f}" for r in bridge if r["case"] == case)] for case in ["diff", "bridge"]
])
test_rows = []
for suite in validation["testResults"]:
    tests = suite["assertionResults"]
    passed = sum(t["status"] == "passed" for t in tests)
    skipped = sum(t["status"] in {"pending", "skipped"} for t in tests)
    assert passed + skipped == len(tests)
    test_rows.append([Path(suite["name"]).name, passed, skipped])
parts["validation"] = table(["測試檔", "通過", "平台條件略過"], test_rows + [["合計", validation["numPassedTests"], validation["numPendingTests"]]])
history_rows = []
history_notes = {
    "three-way-local-02": "R 48/48；H 6 pass、2 fail、1 不適用",
    "three-way-runtime-01": "44/48；4 個 adapter 失敗保留",
    "three-way-opus55-smoke-01": "原 native policy；不是純 cell 比較",
    "three-way-opus55-cell-smoke-01": "Runtime-only，僅 cell Cargo 扣除",
    "three-way-opus55-all-cargo-smoke-01": "Runtime-only，完整 Cargo capture",
    RUNTIME: "Readiness bridge；6 cases × 4 × 3",
    PAID: "Readiness bridge；4 tasks × 4 × 1",
}
for name, note in history_notes.items():
    r = load(f"poc/bench/results/{name}/report.json")
    history_rows.append([f"[{name}](../poc/bench/results/{name}/report.html)", r["recordedRuns"], r["paidRequests"], note])
parts["history"] = table(["Campaign", "Runs", "付費 requests", "範圍與結果"], history_rows)
join = next(r for r in runtime_data if r["case"] == "R04-data-join")["values"]
cpu = next(r for r in runtime_data if r["case"] == "R03-cpu")["values"]
echo = [r for r in bridge if r["case"] == "bridge"]
parts.update({
    "join_before": f"{join[2]['ms']:.3f}", "join_after": f"{join[3]['ms']:.3f}",
    "join_reduction": f"{100 * (1 - join[3]['ms'] / join[2]['ms']):.1f}",
    "cpu_aot": f"{cpu[3]['ms']:.3f}", "cpu_python": f"{cpu[0]['ms']:.3f}",
    "bridge_before": f"{echo[0]['processMedianMs']:.3f}", "bridge_after": f"{echo[1]['processMedianMs']:.3f}",
    "bridge_aot": f"{echo[2]['processMedianMs']:.3f}",
    "bridge_reduction": f"{100 * (1 - echo[1]['processMedianMs'] / echo[0]['processMedianMs']):.1f}",
    "cell_calls": sum(r["cellCalls"] for r in paid["cellExecutionRuns"]),
    "runtime_failures": sum(r["runtimeFailures"] for r in paid["cellExecutionRuns"]),
    "cargo_failures": sum(r["compileFailures"] for r in paid["cellExecutionRuns"]),
})
command_counts = {"cargo.command": 0, "aot.command": 0}
spans = 0
for name in [RUNTIME, PAID]:
    paths = sorted((RESULTS / name / "runs").glob("*/spans.jsonl"))
    assert len(paths) == (72 if name == RUNTIME else 16)
    for path in paths:
        raw = path.read_bytes()
        HASHES[str(path.relative_to(ROOT))] = hashlib.sha256(raw).hexdigest()
        for line in raw.splitlines():
            row = json.loads(line)
            spans += 1
            if row["name"] in command_counts:
                command_counts[row["name"]] += 1
    provenance = load(f"poc/bench/results/{name}/report-provenance.json")
    for filename, key in [("report.html", "reportHtmlSha256"), ("runtime-source.patch", "runtimeSourcePatchSha256")]:
        relative = f"poc/bench/results/{name}/{filename}"
        digest = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
        assert digest == provenance[key]
        HASHES[relative] = digest
parts.update({"spans": spans, "cargo_commands": command_counts["cargo.command"], "aot_commands": command_counts["aot.command"]})
data = {
    "version": 1, "date": "2026-10-08", "primaryCampaigns": [RUNTIME, PAID],
    "runtimeMedianMs": runtime_data, "paidCompilationRuns": paid["compilationAdjustedRuns"],
    "paidCellExecutionRuns": paid["cellExecutionRuns"], "bridge": bridge,
    "paidUsageTotals": usage_totals,
    "securityValidation": {"passed": validation["numPassedTests"], "skipped": validation["numPendingTests"], "failed": validation["numFailedTests"], "suites": test_rows},
    "spans": spans, "commands": command_counts, "sourceSha256": HASHES,
}
(ASSETS / "data.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print("Audited saved evidence and refreshed aggregate data; no model calls.")
