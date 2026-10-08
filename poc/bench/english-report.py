#!/usr/bin/env python3
"""Build the English report set from saved evidence, without model calls."""

import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

import markdown

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
STEM = "rust-cell-report-2026-10-08"
TEMPLATES = ROOT / "poc/bench/templates"
OUTPUT = ROOT / "poc/bench/results/english-report-20261008-01"
OUTPUT.mkdir(parents=True, exist_ok=True)
HAN = re.compile(r"[\u3400-\u9fff]")
SOURCES = {}
GENERATED = []


def read(path):
    raw = path.read_bytes()
    SOURCES[str(path.relative_to(ROOT))] = hashlib.sha256(raw).hexdigest()
    return raw.decode()


def write(path, text):
    path.write_text(text)
    GENERATED.append(path)


read(Path(__file__).resolve())
catalog = {}
for line in read(TEMPLATES / "dashboard.en.tsv").splitlines():
    if line and not line.startswith("#"):
        source, translated = line.split("\t", 1)
        assert source not in catalog, source
        catalog[source] = json.loads(translated)
pattern = re.compile("|".join(re.escape(key) for key in sorted(catalog, key=len, reverse=True)))


def translate_ui(text):
    def replace(match):
        translated = catalog[match[0]]
        return translated + " " if translated.endswith(".") else translated
    result = pattern.sub(replace, text)
    result = result.replace("AGENT BENCHMARK / THREE VERSIONS", "AGENT BENCHMARK / VARIANT COMPARISON")
    for source, translated in {"；": "; ", "，": ", ", "、": ", ", "：": ": ", "（": "(", "）": ")", "／": " / "}.items():
        result = result.replace(source, translated)
    return result


# Read substituted values from the original template/rendered document.
# This preserves the report's exact values and table precision.
template = read(TEMPLATES / "rust-cell-report.md")
original_md = read(DOCS / f"{STEM}.md")
pieces = re.split(r"(\{\{[a-z_]+\}\})", template)
capture = []
seen = set()
for piece in pieces:
    if piece.startswith("{{"):
        key = piece[2:-2]
        capture.append(f"(?P={key})" if key in seen else f"(?P<{key}>.*?)")
        seen.add(key)
    else:
        capture.append(re.escape(piece))
match = re.fullmatch("".join(capture), original_md, re.S)
assert match, "Rebuild the Chinese report before exporting: template and report differ."
parts = match.groupdict()
table_terms = {
    "組別": "Variant", "Cell 與 runtime": "Cell / runtime", "固定 revision": "Pinned revision",
    "任務": "Task", "原始 agent": "Raw agent", "扣除兩者後": "After Cargo + AOT",
    "成功／runtime 失敗／Cargo 失敗": "Success / Runtime failures / Cargo failures",
    "Cell 執行合計 ms": "Cell execution total (ms)", "其中 cached": "Cached subset",
    "工作": "Work", "舊 polling ms": "Old polling (ms)", "一次 diff／ack": "One diff / ack",
    "測試檔": "Test file", "平台條件略過": "Platform skips", "合計": "Total",
    "付費 requests": "Paid requests", "範圍與結果": "Scope / result",
    "R 48/48；H 6 pass、2 fail、1 不適用": "R 48/48; H 6 pass, 2 fail, 1 not applicable",
    "44/48；4 個 adapter 失敗保留": "44/48; four adapter failures retained",
    "原 native policy；不是純 cell 比較": "Native-tool policy; excluded from cell comparison",
    "Runtime-only，僅 cell Cargo 扣除": "Cell-only; cell Cargo deduction only",
    "Runtime-only，完整 Cargo capture": "Cell-only; complete Cargo capture",
    "Readiness bridge；6 cases × 4 × 3": "Readiness bridge; 6 cases × 4 × 3",
    "Readiness bridge；4 tasks × 4 × 1": "Readiness bridge; 4 tasks × 4 × 1",
}
table_pattern = re.compile("|".join(re.escape(key) for key in sorted(table_terms, key=len, reverse=True)))
for key, value in parts.items():
    value = table_pattern.sub(lambda m: table_terms[m[0]], value)
    value = translate_ui(value).replace("/report.html", "/report.en.html")
    assert not HAN.search(value), (key, value)
    parts[key] = value
english_template = read(TEMPLATES / "rust-cell-report.en.md")
english_md = re.sub(r"\{\{([a-z_]+)\}\}", lambda m: parts[m[1]], english_template)
assert "{{" not in english_md
write(DOCS / f"{STEM}.en.md", english_md)

# These historical reports already have English prose. Add named counterparts
# so the complete English set has one consistent link convention.
for name in ["benchmark-comparison-2026-08-10", "runtime-microbenchmark-2026-10-07"]:
    source = DOCS / f"{name}.md"
    text = read(source)
    assert not HAN.search(text), source
    write(DOCS / f"{name}.en.md", text)

english_docs = [
    DOCS / f"{STEM}.en.md",
    DOCS / "benchmark-aot-bridge-2026-10-08.en.md",
    DOCS / "benchmark-cell-runtime-analysis-2026-10-08.en.md",
    DOCS / "benchmark-three-way-design-2026-10-08.en.md",
    DOCS / "benchmark-three-way-validation-2026-10-08.en.md",
    DOCS / "benchmark-comparison-2026-08-10.en.md",
    DOCS / "runtime-microbenchmark-2026-10-07.en.md",
    ROOT / "REPORT.en.md",
    ROOT / "DESIGN.en.md",
    ROOT / "poc/bench/three-way/README.en.md",
]
for path in english_docs:
    assert not HAN.search(read(path)), f"Chinese text in English prose: {path}"

# Localize saved dashboards without reanalysis. The data script is copied
# byte-for-byte, so older snapshots retain their original measurement view.
report_paths = set()
for path in english_docs:
    for target in re.findall(r"\]\(([^)]+/report\.en\.html)\)", path.read_text()):
        report_paths.add((path.parent / target.replace("report.en.html", "report.html")).resolve())
dashboard_checks = []
for source in sorted(report_paths):
    original = read(source)
    payload = re.search(r'<script[^>]*id="benchmark-data"[^>]*>.*?</script>', original, re.S)
    if payload:
        before = translate_ui(original[:payload.start()])
        after = translate_ui(original[payload.end():])
        assert not HAN.search(before + after), f"Untranslated dashboard UI: {source}"
        page = before + payload[0] + after
        assert re.search(r'<script[^>]*id="benchmark-data"[^>]*>.*?</script>', page, re.S)[0] == payload[0]
        data_hash = hashlib.sha256(payload[0].encode()).hexdigest()
    else:
        # The early renderer stores JSON directly in its executable script.
        prefix = "<script>const data="
        start = original.index(prefix) + len(prefix)
        _data, length = json.JSONDecoder().raw_decode(original[start:])
        raw_data = original[start:start + length]
        before = translate_ui(original[:start])
        after = translate_ui(original[start + length:])
        assert not HAN.search(before + after), f"Untranslated legacy UI: {source}"
        page = before + raw_data + after
        page = page.replace('<table id="tasks"></table>', '<div class="legacy-scroll"><table id="tasks"></table></div>')
        page = page.replace("</style>", "body{overflow-wrap:anywhere}.legacy-scroll{overflow:auto}#tasks{min-width:660px}select,input{max-width:calc(100% - 8px);box-sizing:border-box}</style>", 1)
        data_hash = hashlib.sha256(raw_data.encode()).hexdigest()
    page = page.replace('lang="zh-Hant"', 'lang="en"').replace('lang="zh-TW"', 'lang="en"')
    if not re.search(r"<html\s+lang=", page):
        page = page.replace("<html>", '<html lang="en">', 1)
    page = page.replace('toLocaleString("zh-TW")', 'toLocaleString("en-US")')
    if payload:
        assert re.search(r'<script[^>]*id="benchmark-data"[^>]*>.*?</script>', page, re.S)[0] == payload[0]
    else:
        final_start = page.index(prefix) + len(prefix)
        assert page[final_start:final_start + length] == raw_data
    destination = source.with_name("report.en.html")
    write(destination, page)
    client = re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", page, re.S)[-1]
    client_path = OUTPUT / f"{source.parent.name}.client.js"
    client_path.write_text(client)
    subprocess.run(["node", "--check", str(client_path)], check=True, capture_output=True, text=True)
    dashboard_checks.append({"source": str(source.relative_to(ROOT)), "english": str(destination.relative_to(ROOT)), "dataScriptSha256": data_hash, "payloadUnchanged": True})

original_html = read(DOCS / f"{STEM}.html")
style = re.search(r"<style>(.*?)</style>", original_html, re.S)[1]
style += "\nmain{overflow-wrap:anywhere}pre{overflow-x:auto;padding:16px;background:#eef2f6}pre code{display:block;width:max-content;padding:0;background:transparent;white-space:pre;overflow-wrap:normal}"
assets = DOCS / f"assets/{STEM}"
svgs = {path.stem: read(path) for path in sorted(assets.glob("*.svg"))}


def panel(kind, options, initial, caption):
    controls = "".join(f'<label>{label}<select data-chart="{kind}" data-option="{key}">' + "".join(f'<option value="{value}">{text}</option>' for value, text in items) + "</select></label>" for key, label, items in options)
    return f'<figure class="panel"><div class="controls">{controls}</div><div class="chart" id="chart-{kind}">{svgs[initial]}</div><figcaption>{caption}</figcaption></figure>'


panels = {
    "runtime-linear.svg": panel("runtime", [("scale", "Scale", [("linear", "Linear"), ("log", "Log; 0–1 ms stays linear")])], "runtime-linear", "Each case has its own scale. Compare variants within a case. Per-run cell execution total, median n=3; excludes Cargo and AOT compilation."),
    "paid-agent-all.svg": panel("paid", [("period", "Time interval", [("agent", "Agent; excludes daemon/checker"), ("user", "User; daemon to agent completion"), ("validated", "Initialization to checker completion")]), ("scope", "Costs shown separately", [("all", "All Cargo + AOT"), ("cargo", "All Cargo; AOT stays in remainder")])], "paid-agent-all", "Variant color: remainder after deductions. Gray: all Cargo. Orange: AOT. Labels show raw totals, n=1. Each case has its own scale. Deductions are arithmetic, not compile-free reruns."),
    "bridge.svg": f'<figure class="panel"><div class="chart">{svgs["bridge"]}</div><figcaption>Same source, handler, and payload; alternating modes; median n=15. AOT compilation is separate.</figcaption></figure>',
    "boundary.svg": f'<figure class="panel"><div class="chart">{svgs["boundary"]}</div><figcaption>Guest permissions are separate from compiler and host permissions. Dashed box: optional compiler isolation.</figcaption></figure>',
}
svg_json = json.dumps(svgs).replace("<", "\\u003c")
chart_script = f'''<script>const chartSvgs={svg_json};
function updateChart(kind){{const controls=Object.fromEntries([...document.querySelectorAll('select[data-chart="'+kind+'"]')].map(s=>[s.dataset.option,s.value]));const key=kind==='runtime'?'runtime-'+controls.scale:'paid-'+controls.period+'-'+controls.scope;document.getElementById('chart-'+kind).innerHTML=chartSvgs[key];}}
document.querySelectorAll('select[data-chart]').forEach(s=>s.addEventListener('change',()=>updateChart(s.dataset.chart)));
</script>'''
html_by_md = {path.resolve(): path.with_suffix(".html") for path in english_docs}
link_checks = []
for path in english_docs:
    text = path.read_text()
    for target in re.findall(r"\]\(([^)]+)\)", text):
        if target.startswith(("https://", "http://", "#")):
            continue
        local = (path.parent / target.split("#", 1)[0]).resolve()
        assert local.is_file(), f"Broken local link: {path}: {target}"
        link_checks.append({"document": str(path.relative_to(ROOT)), "target": target})
    rendered = markdown.markdown(text, extensions=["tables", "fenced_code", "toc"], extension_configs={"toc": {"slugify": lambda value, _: re.sub(r"[^\w]+", "-", value).strip("-").lower()}})
    rendered = re.sub(r"(<table>.*?</table>)", r'<div class="table-scroll">\1</div>', rendered, flags=re.S)
    # Markdown keeps Markdown links; HTML uses corresponding HTML readers.
    def reader_link(m):
        target = html.unescape(m[1])
        base, separator, fragment = target.partition("#")
        local = (path.parent / base).resolve()
        if local in html_by_md:
            target = base[:-3] + ".html" + (separator + fragment if separator else "")
        return f'href="{html.escape(target, quote=True)}"'
    rendered = re.sub(r'href="([^"]+)"', reader_link, rendered)
    if path.name == f"{STEM}.en.md":
        for name, markup in panels.items():
            rendered, count = re.subn(rf'<p><img alt="[^"]*" src="assets/{STEM}/{re.escape(name)}"\s*/?></p>', lambda _: markup, rendered)
            assert count == 1, name
    title = re.search(r"^# (.+)$", text, re.M)[1]
    toc = "".join(f'<a href="#{anchor}">{heading}</a>' for anchor, heading in re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', rendered))
    page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><style>{style}</style></head>
<body><div class="topbar">WasmEdge Agent · English Report<button type="button" class="print" onclick="window.print()">Print</button></div>
<div class="layout"><nav aria-label="Contents"><strong>Contents</strong>{toc}</nav><main>{rendered}</main></div>
<footer>English reading edition. Values and evidence come from saved reports. Raw traces and code keep their original language.</footer>
{chart_script if path.name == f"{STEM}.en.md" else ""}</body></html>'''
    assert not HAN.search(page), path
    write(path.with_suffix(".html"), page)

# Package report readers and chart assets. Raw evidence/source links require
# the full repository; do not silently bundle private provider payloads.
bundle = OUTPUT / "rust-cell-reports-en.zip"
members = set(GENERATED) | set(english_docs) | set(assets.glob("*.svg")) | {
    assets / "data.json", ROOT / "docs/benchmark-trace.schema.json",
    ROOT / "docs/benchmark-comparison-2026-08-10.csv",
    ROOT / "docs/runtime-microbenchmark-2026-10-07.json",
    ROOT / "packages/coding-agent/docs/rlm-runtime.md",
    ROOT / "poc/bench/README.md",
}
for source in report_paths:
    for target in re.findall(r'href="([^"#]+\.csv)"', source.read_text()):
        path = source.parent / target
        assert path.is_file(), path
        members.add(path)
for link in link_checks:
    if link["target"].split("#", 1)[0].endswith(".csv"):
        members.add((ROOT / link["document"]).parent / link["target"].split("#", 1)[0])
if (OUTPUT / "browser-validation.json").is_file():
    members.add(OUTPUT / "browser-validation.json")
members = {path.resolve() for path in members}
with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(members):
        archive.write(path, str(path.relative_to(ROOT)))
    archive.writestr("START-HERE.txt", "Open docs/rust-cell-report-2026-10-08.en.html.\n\nThis package includes English reports, nine saved dashboards, and shared chart assets. Report-to-report links work offline. Raw traces and generated sources remain in the original local run directories, which are not committed. Those evidence links require the saved run directories. No new benchmarks or model requests were run.\n")

public_bundle = assets / "english-report-set.zip"
shutil.copyfile(bundle, public_bundle)

validation = {
    "version": 1, "language": "en", "modelRequests": 0,
    "dashboardJavaScriptSyntax": "passed",
    "originalSourcesUnchanged": all(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == digest for path, digest in SOURCES.items()),
    "dashboards": dashboard_checks, "localLinksChecked": len(link_checks),
    "generated": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(set(GENERATED))},
    "sourceSha256": SOURCES, "bundle": str(bundle.relative_to(ROOT)),
    "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
    "publicBundle": str(public_bundle.relative_to(ROOT)),
}
assert validation["originalSourcesUnchanged"]
(OUTPUT / "validation.json").write_text(json.dumps(validation, indent=2) + "\n")
print(f"Created {len(english_docs)} English document readers and {len(dashboard_checks)} English dashboards. Checked {len(link_checks)} local links; dashboard data unchanged. Bundle: {bundle.relative_to(ROOT)}")
