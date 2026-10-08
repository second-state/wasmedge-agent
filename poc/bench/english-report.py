#!/usr/bin/env python3
"""Build the retained English readers from canonical sources; no model calls."""

import html
import os
from pathlib import Path
import re

from report_reader import build_reports, render_reader

ROOT = Path(__file__).resolve().parents[2]
STEM = 'rust-cell-report-2026-10-08'
SOURCES = [
    ('docs/bench-history/benchmark-cell-runtime-analysis-2026-10-08.en.md', 'docs/benchmark-cell-runtime-analysis-2026-10-08.en.html'),
    ('docs/benchmark-three-way-design-2026-10-08.en.md', 'docs/benchmark-three-way-design-2026-10-08.en.html'),
    ('docs/bench-history/benchmark-three-way-validation-2026-10-08.en.md', 'docs/benchmark-three-way-validation-2026-10-08.en.html'),
    ('docs/bench-history/benchmark-comparison-2026-08-10.md', 'docs/benchmark-comparison-2026-08-10.en.html'),
    ('docs/bench-history/runtime-microbenchmark-2026-10-07.md', 'docs/runtime-microbenchmark-2026-10-07.en.html'),
    ('REPORT.en.md', 'REPORT.en.html'), ('DESIGN.en.md', 'DESIGN.en.html'),
    ('poc/bench/three-way/README.en.md', 'poc/bench/three-way/README.en.html'),
]
READERS = {(ROOT / source).resolve(): (ROOT / output).resolve() for source, output in SOURCES}
MASTER = ROOT / f'docs/{STEM}.en.md'
READERS[MASTER.resolve()] = MASTER.with_suffix('.html')


def reader_links(page, source, output):
    def link(match):
        target = html.unescape(match[2])
        if re.match(r'^(?:[a-z][a-z\d+.-]*:|//|#)', target, re.I):
            return match[0]
        base, separator, fragment = target.partition('#')
        local = (source.parent / base).resolve()
        destination = READERS.get(local, local)
        target = os.path.relpath(destination, output.parent) + (separator + fragment if separator else '')
        return f'{match[1]}="{html.escape(target, quote=True)}"'
    return re.sub(r'\b(href|src)="([^"]+)"', link, page)


def report_sections(document, anchors):
    sections = re.split(r'(?=^<a id="[^"]+"></a>\s*$)', document, flags=re.M)
    selected = {}
    for section in sections:
        marker = re.match(r'<a id="([^"]+)"></a>', section)
        if marker:
            selected[marker[1]] = section
    return '\n'.join(selected[anchor] for anchor in anchors)


build_reports()
for source_name, output_name in SOURCES:
    source, output = ROOT / source_name, ROOT / output_name
    document = source.read_text()
    assert not re.search(r'[\u3400-\u9fff]', document), source_name
    page = reader_links(render_reader(document, english=True), source, output)
    output.write_text(page)

# The retained AOT reader is a subset of the consolidated report, with no
# separate Markdown source or duplicated measurement tables to maintain.
summary = '# AOT and Bridge Readiness Tests — October 8, 2026\n\n'
summary += f'This reader uses sections from the [current report]({STEM}.en.html). '
summary += f'See its [Opus task results]({STEM}.en.html#tasks) for full task and compiler costs.\n\n'
summary += report_sections(MASTER.read_text(), ['runtime', 'bridge', 'aot-details', 'aot-validation'])
output = ROOT / 'docs/benchmark-aot-bridge-2026-10-08.en.html'
page = reader_links(render_reader(summary, english=True), MASTER, output)
assert not re.search(r'[\u3400-\u9fff]', page)
output.write_text(page)
print('Built both standalone reports and all nine retained English supporting readers from canonical sources; no model calls.')
