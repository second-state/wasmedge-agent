import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkReportLinks, standaloneErrors } from "./check-benchmark-report-links.mjs";

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "benchmark-report-links-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return { root, documents: ["docs/report.md"], tracked: new Set(Object.keys(files)) };
}

test("rejects local evidence that is absent from Git", (t) => {
	const dashboard = "poc/bench/results/saved/report.en.html";
	const input = fixture(t, { "docs/report.md": `[Dashboard](../${dashboard})`, [dashboard]: "<h1>Report</h1>" });
	input.tracked.delete(dashboard);
	assert.match(checkReportLinks(input).errors.join("\n"), /target is not in Git/);
});

test("rejects raw results even if added to Git", (t) => {
	const dashboard = "poc/bench/results/saved/report.en.html";
	const input = fixture(t, { "docs/report.md": `[Dashboard](../${dashboard})`, [dashboard]: "<h1>Report</h1>" });
	assert.match(checkReportLinks(input).errors.join("\n"), /raw result must remain local/);
});

test("accepts embedded charts, data, internal navigation and optional citations", () => {
	assert.deepEqual(standaloneErrors('<style>.plot{clip-path:url(#plot)}</style><h2 id="cells">Cells</h2><a href="#cells">Chart</a><svg id="plot"></svg><a href="https://wasi.dev/">Source</a><script>const data={source:"<a href=\"private.txt\">"};</script>'), []);
});

test("rejects separate chart files, CDN scripts, CSS imports and missing anchors", () => {
	const errors = standaloneErrors('<img src="chart.svg"><script src="https://cdn.example.com/plot.js"></script><style>@import "theme.css";body{background:url(bg.png)}</style><a href="#absent">Cells</a>').join("\n");
	assert.match(errors, /another file: chart.svg/);
	assert.match(errors, /external resource: https:\/\/cdn/);
	assert.match(errors, /imports external CSS/);
	assert.match(errors, /CSS resource: bg.png/);
	assert.match(errors, /missing in-file anchor/);
});

test("rejects the retired report download workflow", () => {
	assert.match(standaloneErrors('<a href="https://github.com/second-state/wasmedge-agent/releases/download/benchmark-reports-2026-10-08/report.zip">Download</a>').join("\n"), /retired report download workflow/);
});

test("checks cross-document links to integrated report sections", (t) => {
	const reader = "docs/rust-cell-report-2026-10-08.en.html";
	const input = fixture(t, { "docs/report.md": `[Cells](rust-cell-report-2026-10-08.en.html#runtime)`, [reader]: '<a id="runtime"></a>' });
	assert.deepEqual(checkReportLinks(input), { errors: [], links: 1 });
	writeFileSync(join(input.root, reader), "<h1>Report</h1>");
	assert.match(checkReportLinks(input).errors.join("\n"), /missing report anchor/);
});

test("rejects missing tracked targets and paths outside the checkout", (t) => {
	const input = fixture(t, { "docs/report.md": "[Missing](missing.md)\n[Outside](../../private.txt)" });
	input.tracked.add("docs/missing.md");
	const errors = checkReportLinks(input).errors.join("\n");
	assert.match(errors, /target is missing/);
	assert.match(errors, /leaves the repository/);
});
