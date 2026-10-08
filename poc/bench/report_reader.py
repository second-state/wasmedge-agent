"""Render standalone readers from the compact, tracked measurement snapshot."""

import hashlib
import html
import json
from pathlib import Path
import re

import markdown

ROOT = Path(__file__).resolve().parents[2]
STEM = "rust-cell-report-2026-10-08"
ASSETS = ROOT / "docs/assets" / STEM
TEMPLATES = ROOT / "poc/bench/templates"
VARIANTS = ["prime-ts", "prime-rust", "wasmedge", "wasmedge-aot"]
LABELS = ["Prime TS / Python", "Prime Rust / Python", "Rust / interpreter", "Rust / AOT"]
COLORS = ["#087f8c", "#6654b1", "#ac6b13", "#167d57"]
DATA = ASSETS / "data.json"


def table(headers, rows):
    return "\n".join(["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |",
                      *("| " + " | ".join(str(v) for v in row) + " |" for row in rows)])


def report_parts(data, english):
    paid = {(r["caseId"], r["variantId"]): r for r in data["paidCompilationRuns"]}
    cells = {(r["caseId"], r["variantId"]): r for r in data["paidCellExecutionRuns"]}
    cases = sorted({case for case, _variant in paid})
    assert len(paid) == len(cells) == 16
    assert len(data["runtimeMedianMs"]) == 6
    assert sum(v["requests"] for v in data["paidUsageTotals"].values()) == 70
    for row in paid.values():
        assert row["state"] == "measured" or (row["state"] == "not_run" and row["reason"] == "complete-capture-no-cargo")
        for period in ["agent", "user", "validated"]:
            assert abs(row[f"{period}Ms"] - row[f"{period}CompilerMs"] - row[f"{period}WithoutAllCompilationMs"]) < 1e-6
    for row in cells.values():
        assert row["state"] == "measured" and row["missingCells"] == 0
    def words(en, zh):
        return en if english else zh
    parts = {
        "variants": table(words(["Variant", "Host", "Cell / runtime", "Pinned revision"], ["組別", "Host", "Cell 與 runtime", "固定 revision"]), [
            [LABELS[i], "Rust" if i == 1 else "TypeScript", "Python resident kernel" if i < 2 else "Rust / WasmEdge " + ("interpreter" if i == 2 else "AOT"), revision]
            for i, revision in enumerate(["`7d442aafa985`", "`967eb13fd488`", "`48d6312570f7` + runtime patch", "`48d6312570f7` + runtime patch"])]),
        "runtime": table([words("Case", "案例"), *LABELS], [[r["case"], *(f"{v['ms']:.3f}" for v in r["values"])] for r in data["runtimeMedianMs"]]),
        "paid_raw": table([words("Task", "任務"), *LABELS], [[c, *(f"{paid[c, v]['agentMs'] / 1000:.3f}" for v in VARIANTS)] for c in cases]),
        "paid_compilation": table(words(["Task", "Rust runtime", "Raw agent", "All Cargo", "AOT", "After Cargo + AOT"], ["任務", "Rust runtime", "原始 agent", "全部 Cargo", "AOT", "扣除兩者後"]), [
            [c, LABELS[VARIANTS.index(v)], *(f"{paid[c, v][k] / 1000:.3f}" for k in ["agentMs", "agentCargoMs", "agentAotMs", "agentWithoutAllCompilationMs"])] for c in cases for v in VARIANTS[2:]]),
        "paid_cells": table(words(["Task", "Variant", "Success / Runtime failures / Cargo failures", "Cell execution total (ms)"], ["任務", "版本", "成功／runtime 失敗／Cargo 失敗", "Cell 執行合計 ms"]), [
            [c, LABELS[VARIANTS.index(v)], "/".join(str(cells[c, v][k]) for k in ["successfulCells", "runtimeFailures", "compileFailures"]), f"{cells[c, v]['totalExecutionMs']:.3f}"] for c in cases for v in VARIANTS]),
        "usage": table(words(["Variant", "Requests", "Prompt tokens", "Cached subset", "Output tokens"], ["版本", "Requests", "Prompt tokens", "其中 cached", "Output tokens"]), [
            [LABELS[i], *(f"{data['paidUsageTotals'][v][k]:,}" for k in ["requests", "prompt", "cached", "output"])] for i, v in enumerate(VARIANTS)]),
        "bridge": table(words(["Work", "Old polling (ms)", "Readiness interpreter ms", "Readiness AOT ms"], ["工作", "舊 polling ms", "Readiness interpreter ms", "Readiness AOT ms"]), [
            [words("One diff / ack", "一次 diff／ack") if case == "diff" else "100 echo × 1 KiB", *(f"{r['processMedianMs']:.3f}" for r in data["bridge"] if r["case"] == case)] for case in ["diff", "bridge"]]),
        "validation": table(words(["Test file", "Passed", "Platform skips"], ["測試檔", "通過", "平台條件略過"]), data["securityValidation"]["suites"] + [[words("Total", "合計"), data["securityValidation"]["passed"], data["securityValidation"]["skipped"]]]),
        "spans": data["spans"], "cargo_commands": data["commands"]["cargo.command"], "aot_commands": data["commands"]["aot.command"],
        "cell_calls": sum(r["cellCalls"] for r in cells.values()), "runtime_failures": sum(r["runtimeFailures"] for r in cells.values()), "cargo_failures": sum(r["compileFailures"] for r in cells.values()),
    }
    runtime = {r["case"]: r["values"] for r in data["runtimeMedianMs"]}
    join, cpu = runtime["R04-data-join"], runtime["R03-cpu"]
    echo = [r for r in data["bridge"] if r["case"] == "bridge"]
    parts.update({"join_before": f"{join[2]['ms']:.3f}", "join_after": f"{join[3]['ms']:.3f}", "join_reduction": f"{100 * (1 - join[3]['ms'] / join[2]['ms']):.1f}",
                  "cpu_aot": f"{cpu[3]['ms']:.3f}", "cpu_python": f"{cpu[0]['ms']:.3f}", "bridge_before": f"{echo[0]['processMedianMs']:.3f}", "bridge_after": f"{echo[1]['processMedianMs']:.3f}", "bridge_aot": f"{echo[2]['processMedianMs']:.3f}", "bridge_reduction": f"{100 * (1 - echo[1]['processMedianMs'] / echo[0]['processMedianMs']):.1f}"})
    rows = "".join(f"<tr><td><code>{html.escape(path)}</code></td><td><code>{digest}</code></td></tr>" for path, digest in sorted(data["sourceSha256"].items()))
    summary = words("Saved evidence: source SHA-256 records", "保存證據的來源 SHA-256")
    parts["provenance"] = f'<details><summary>{summary}</summary><div class="table-scroll"><table><thead><tr><th>Source</th><th>SHA-256</th></tr></thead><tbody>{rows}</tbody></table></div></details>'
    return parts


def cell_chart(data, english):
    cases = sorted({r["caseId"] for r in data["paidCellExecutionRuns"]})
    content = '<div class="cell-chart">'
    for case in cases:
        rows = {r["variantId"]: r for r in data["paidCellExecutionRuns"] if r["caseId"] == case}
        maximum = max(r["totalExecutionMs"] for r in rows.values())
        content += f'<div class="cell-case"><h4>{html.escape(case)}</h4>'
        for i, variant in enumerate(VARIANTS):
            value = rows[variant]["totalExecutionMs"]
            content += f'<div class="cell-row"><div class="cell-label"><span>{LABELS[i]}</span><strong>{value:.3f} ms</strong></div><div class="cell-track"><div class="cell-bar" style="width:{100 * value / maximum:.4f}%;background:{COLORS[i]}"></div></div></div>'
        content += '</div>'
    caption = ("Per-task cell execution totals, n=1. Each task has its own scale. Includes runtime failures; excludes Cargo and AOT. Sources and cell counts differ between variants." if english else "每任務 cell 執行合計，n=1；各任務獨立刻度。包含 runtime 失敗，排除全部 Cargo／AOT。各組生成程式與 cell 次數不同。")
    return f'<figure class="panel">{content}</div><figcaption>{caption}</figcaption></figure>'


def render_reader(document, english=False, data=None):
    svgs = {p.stem: p.read_text() for p in sorted(ASSETS.glob("*.svg"))}
    rendered = markdown.markdown(document, extensions=["tables", "fenced_code", "toc"], extension_configs={"toc": {"slugify": lambda value, _: re.sub(r"[^\w]+", "-", value).strip("-").lower()}})
    rendered = re.sub(r"(<table>.*?</table>)", r'<div class="table-scroll">\1</div>', rendered, flags=re.S)
    title = re.search(r'^# (.+)$', document, re.M)[1]
    lang, print_label = ("en", "Print") if english else ("zh-Hant", "列印")
    def panel(kind, options, initial, caption):
        controls = "".join(f'<label>{label}<select data-chart="{kind}" data-option="{key}">' + "".join(f'<option value="{value}">{text}</option>' for value, text in items) + '</select></label>' for key, label, items in options)
        return f'<figure class="panel"><div class="controls">{controls}</div><div class="chart" id="chart-{kind}">{svgs[initial]}</div><figcaption>{caption}</figcaption></figure>'
    chart_script = ""
    if data is not None:
        words = lambda en, zh: en if english else zh
        panels = {
            "runtime-linear.svg": panel("runtime", [("scale", words("Scale", "座標"), [("linear", words("Linear", "線性")), ("log", words("Log; 0–1 ms stays linear", "對數，0–1 ms 保留線性"))])], "runtime-linear", words("Each case has its own scale. Per-run cell execution total, median n=3; excludes Cargo and AOT.", "各案例獨立刻度；每 run cell 執行合計，median n=3，排除全部 Cargo／AOT。")),
            "paid-agent-all.svg": panel("paid", [("period", words("Time interval", "時間邊界"), [("agent", words("Agent; excludes daemon/checker", "Agent，不含 daemon／checker")), ("user", words("User; daemon to agent completion", "User，daemon 至 agent 完成")), ("validated", words("Initialization to checker completion", "初始化至驗收完成"))]), ("scope", words("Costs shown separately", "分開列出的成本"), [("all", words("All Cargo + AOT", "全部 Cargo + AOT")), ("cargo", words("All Cargo; AOT stays in remainder", "全部 Cargo，AOT 留在剩餘"))])], "paid-agent-all", words("Variant color: remainder. Gray: all Cargo. Orange: AOT. Labels show raw totals, n=1. Each task has its own scale. Deductions are arithmetic, not compile-free reruns.", "版本色：扣除後剩餘；灰色：全部 Cargo；橘紅：AOT。標籤為原始總時間，n=1。各任務獨立刻度；扣除是算術分解。")),
            "bridge.svg": f'<figure class="panel"><div class="chart">{svgs["bridge"]}</div><figcaption>{words("Same source, handlers, and payload; alternating modes; median n=15. AOT compilation is separate.", "相同來源、handler、payload；模式輪替，median n=15。AOT 編譯另計。")}</figcaption></figure>',
            "boundary.svg": f'<figure class="panel"><div class="chart">{svgs["boundary"]}</div><figcaption>{words("Guest permissions are separate from host and compiler permissions. Dashed box: optional compiler isolation.", "Guest 權限與 host／compiler 權限分開；虛線為選用的 compiler 隔離。")}</figcaption></figure>',
        }
        for name, markup in panels.items():
            rendered, count = re.subn(rf'<p><img alt="[^"]*" src="assets/{STEM}/{re.escape(name)}"\s*/?></p>', lambda _: markup, rendered)
            assert count == 1, (name, count)
        assert rendered.count('<!-- paid-cell-chart -->') == 1
        rendered = rendered.replace('<!-- paid-cell-chart -->', cell_chart(data, english))
        # Put each switchable chart in the script only once; static charts stay inline.
        switches = {k: v for k, v in svgs.items() if k.startswith(("runtime-", "paid-"))}
        payload = json.dumps(switches, ensure_ascii=False).replace("<", "\\u003c")
        chart_script = '''<script>const chartSvgs=PAYLOAD;
function updateChart(kind){const controls=Object.fromEntries([...document.querySelectorAll('select[data-chart="'+kind+'"]')].map(s=>[s.dataset.option,s.value]));const key=kind==='runtime'?'runtime-'+controls.scale:'paid-'+controls.period+'-'+controls.scope;document.getElementById('chart-'+kind).innerHTML=chartSvgs[key];}
document.querySelectorAll('select[data-chart]').forEach(s=>s.addEventListener('change',()=>updateChart(s.dataset.chart)));
</script>'''.replace("PAYLOAD", payload)
        rendered = re.sub(r'(<h2 id="[^"]+">(?:先看結論|Conclusions first)</h2>)(.*?)(?=<p><a id="runtime")', r'<div class="overview">\1\2</div>', rendered, flags=re.S)
    toc = "".join(f'<a href="#{anchor}">{heading}</a>' for anchor, heading in re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', rendered))
    css = (TEMPLATES / "report-reader.css").read_text()
    footer = "Standalone report. All decision tables and charts are embedded; no model calls were made to build this reader." if english else "單檔報告：重要數據與圖表均嵌入；產生閱讀版未發出模型請求。"
    jump = ''
    if data is not None:
        labels = ["Conclusions", "Runtime", "Tasks", "Safety"] if english else ["結論", "Runtime", "任務", "安全性"]
        jump = '<div class="mobile-nav">' + ''.join(f'<a href="#{anchor}">{label}</a>' for anchor, label in zip(["conclusions", "runtime", "tasks", "safety"], labels)) + '</div>'
    return f'<!doctype html>\n<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><style>{css}</style></head><body><div class="topbar">WasmEdge Agent · 2026-10-08<button type="button" class="print" onclick="window.print()">{print_label}</button></div><div class="layout"><nav aria-label="Contents"><strong>{"Contents" if english else "報告目錄"}</strong>{toc}</nav><main>{jump}{rendered}</main></div><footer>{footer}</footer>{chart_script}</body></html>\n'


def build_reports():
    data = json.loads(DATA.read_text())
    for english in [False, True]:
        suffix = ".en" if english else ""
        parts = report_parts(data, english)
        template = (TEMPLATES / f"rust-cell-report{suffix}.md").read_text()
        document = re.sub(r"\{\{([a-z_]+)\}\}", lambda m: str(parts[m[1]]), template)
        assert "{{" not in document
        page = render_reader(document, english, data)
        if english:
            assert not re.search(r"[\u3400-\u9fff]", page), "Chinese text in English reader"
        (ROOT / "docs" / f"{STEM}{suffix}.md").write_text(document)
        (ROOT / "docs" / f"{STEM}{suffix}.html").write_text(page)
        if not english:
            data["reportMarkdownSha256"] = hashlib.sha256(document.encode()).hexdigest()
            data["reportHtmlSha256"] = hashlib.sha256(page.encode()).hexdigest()
    DATA.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
