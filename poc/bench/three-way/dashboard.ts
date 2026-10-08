import { readFileSync } from "node:fs";
import { buildChartData } from "./charts.js";
import type { Manifest, RunResult, Span } from "./types.js";

export function dashboard(
	report: Record<string, unknown>,
	manifest: Manifest,
	runs: RunResult[],
	spans: Span[],
	charts = buildChartData(manifest.cases, manifest.variants, manifest.runs, runs, spans),
): string {
	const template = readFileSync(new URL("./templates/dashboard.html", import.meta.url), "utf8");
	const client = readFileSync(new URL("./templates/dashboard.js", import.meta.url), "utf8");
	const data = JSON.stringify({
		report,
		runs,
		spans,
		charts,
	}).replaceAll("<", "\\u003c");
	return template.replace(/__BENCH_(DATA|CLIENT)__/g, (token) => (token === "__BENCH_DATA__" ? data : client));
}
