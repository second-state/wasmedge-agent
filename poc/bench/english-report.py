#!/usr/bin/env python3
"""Build English readers from saved prose and compact data; no model calls."""

from pathlib import Path
import re

from report_reader import build_reports, render_reader

ROOT = Path(__file__).resolve().parents[2]
SOURCES = [
    'docs/benchmark-aot-bridge-2026-10-08.en.md',
    'docs/benchmark-cell-runtime-analysis-2026-10-08.en.md',
    'docs/benchmark-three-way-design-2026-10-08.en.md',
    'docs/benchmark-three-way-validation-2026-10-08.en.md',
    'docs/benchmark-comparison-2026-08-10.en.md',
    'docs/runtime-microbenchmark-2026-10-07.en.md',
    'REPORT.en.md', 'DESIGN.en.md', 'poc/bench/three-way/README.en.md',
]

build_reports()
for relative in SOURCES:
    source = ROOT / relative
    document = source.read_text()
    assert not re.search(r'[\u3400-\u9fff]', document), relative
    page = render_reader(document, english=True)
    # The supporting HTML readers point to the matching HTML edition.
    page = re.sub(r'href="([^"#]+\.en)\.md(#[^"]*)?"', lambda m: f'href="{m[1]}.html{m[2] or ""}"', page)
    source.with_suffix('.html').write_text(page)
print('Built the standalone English report and nine supporting readers; no archives or model calls.')
