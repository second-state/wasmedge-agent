import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function reportLinks(text, extension) {
	if (extension === ".md") {
		const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
		return [...prose.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
	}
	const markup = text.replace(/<!--[^]*?-->|<(script|style)\b[^>]*>[^]*?<\/\1>/gi, "");
	return [...markup.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
}

export function reportDocuments(tracked) {
	return [...tracked].filter(
		(path) =>
			/^(?:README\.md$|(?:DESIGN|REPORT)(?:\.en)?\.|examples\/showcase\/README\.md$|docs\/bench-history\/|docs\/(?:benchmark-(?:aot-bridge|cell-runtime-analysis|three-way-(?:design|validation)|comparison)|runtime-microbenchmark|rust-cell-report)|poc\/bench\/three-way\/README)/.test(path) &&
			/\.(?:md|html)$/.test(path),
	);
}

export function standaloneErrors(text) {
	const errors = [];
	const markup = text.replace(/<!--[^]*?-->/g, "").replace(/<script\b[^>]*>[^]*?<\/script>/gi, (tag) => tag.slice(0, tag.indexOf(">") + 1));
	const anchors = new Set([...markup.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]));
	for (const target of reportLinks(text, ".html")) {
		if (target.startsWith("#")) {
			if (!anchors.has(decodeURIComponent(target.slice(1)))) errors.push(`missing in-file anchor: ${target}`);
		} else if (!/^https?:\/\//i.test(target)) {
			errors.push(`standalone reader links to another file: ${target}`);
		}
	}
	for (const match of markup.matchAll(/<(?:script|img|link|iframe|source|audio|video|object|embed)\b[^>]*\b(?:src|href|data)\s*=\s*["']([^"']+)["']/gi)) {
		if (!/^(?:data:|#)/i.test(match[1])) errors.push(`standalone reader has an external resource: ${match[1]}`);
	}
	if (/@import\s/i.test(markup)) errors.push("standalone reader imports external CSS");
	for (const match of markup.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) {
		if (!/^(?:data:|#)/i.test(match[1])) errors.push(`standalone reader has a CSS resource: ${match[1]}`);
	}
	if (/benchmark-report-downloads|releases\/(?:download|tag)\/benchmark-reports/i.test(markup)) errors.push("standalone reader depends on the retired report download workflow");
	return errors;
}

export function checkReportLinks({ root, documents, tracked, standalone = [] }) {
	const errors = [];
	let links = 0;
	function checkFile(path, context) {
		const absolute = resolve(root, path);
		const local = relative(root, absolute).split("\\").join("/");
		if (local.startsWith("../") || local === "..") errors.push(`${context}: target leaves the repository: ${path}`);
		else if (!tracked.has(local)) errors.push(`${context}: target is not in Git: ${local}`);
		else if (!existsSync(absolute) || !statSync(absolute).isFile()) errors.push(`${context}: target is missing: ${local}`);
		else if (local.startsWith("poc/bench/results/")) errors.push(`${context}: raw result must remain local: ${local}`);
		else return absolute;
		return undefined;
	}
	for (const path of new Set(documents)) {
		const absolute = checkFile(path, "Report publication");
		if (!absolute || !/\.(?:md|html)$/.test(path)) continue;
		const text = readFileSync(absolute, "utf8");
		if (standalone.includes(path)) errors.push(...standaloneErrors(text).map((error) => `${path}: ${error}`));
		for (const target of reportLinks(text, path.endsWith(".md") ? ".md" : ".html")) {
			if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) continue;
			const base = target.split(/[?#]/, 1)[0].replaceAll("&amp;", "&");
			if (!base) continue;
			links++;
			const linked = checkFile(relative(root, resolve(dirname(absolute), decodeURIComponent(base))), `${path} → ${target}`);
			const fragment = target.split("#", 2)[1];
			if (linked && fragment && /rust-cell-report-2026-10-08/.test(linked)) {
				const content = readFileSync(linked, "utf8");
				if (![...content.matchAll(/\bid="([^"]+)"/g)].some((match) => match[1] === fragment)) errors.push(`${path}: missing report anchor: ${fragment}`);
			}
		}
	}
	return { errors, links };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0"));
	const standalone = ["docs/rust-cell-report-2026-10-08.html", "docs/rust-cell-report-2026-10-08.en.html"];
	const documents = reportDocuments(tracked);
	const { errors, links } = checkReportLinks({ root, documents: [...documents, ...standalone], standalone, tracked });
	for (const path of tracked) {
		if (path.startsWith("poc/bench/results/") || /^docs\/assets\/rust-cell-report-2026-10-08\/.*\.(?:zip|png)$/.test(path)) errors.push(`Report payload must not be tracked: ${path}`);
	}
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exitCode = 1;
	} else console.log(`Benchmark reports: ${links} local links passed; both primary HTML readers are standalone.`);
}
