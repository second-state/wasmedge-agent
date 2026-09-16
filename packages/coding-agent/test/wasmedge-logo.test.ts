import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { WASMEDGE_LOGO } from "../src/themes/wasmedge-logo.js";

const repoRoot = resolve(__dirname, "../../..");
const installerSource = readFileSync(join(repoRoot, "install.sh"), "utf-8");
const harnessPrefix = installerSource.slice(0, installerSource.lastIndexOf('\nmain "$@"'));

const LOGO_LINES = WASMEDGE_LOGO.split("\n");
const LOGO_WIDTH = LOGO_LINES.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs a driver against the installer's definitions and returns its stdout. */
function runInstaller(driver: string): string {
	const dir = mkdtempSync(join(tmpdir(), "wasmedge-logo-"));
	tempDirs.push(dir);
	const harness = join(dir, "harness.sh");
	writeFileSync(harness, `${harnessPrefix}\n\n${driver}\n`);
	return execFileSync("sh", [harness], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The installer's logo rows at a given animation frame, one per line, as
 *  printed: padding and all. */
function installerLogoRows(frame: number): string[] {
	const output = runInstaller(`
wasmedge_agent_animation_frame=${frame}
row=0
while [ "$row" -lt ${LOGO_LINES.length} ]; do
	printf '%s\\n' "$(wasmedge_agent_logo_line "$row")"
	row=$((row + 1))
done
`);
	return output.replace(/\n$/, "").split("\n");
}

describe("the WasmEdge mark", () => {
	it("is the rendered mark, sized for the header column", () => {
		// The header lays the mark out beside its metadata column, and the
		// installer centres it in a band it sizes from the same width, so the
		// shape is load-bearing: 32 columns is what both were built around.
		expect(LOGO_LINES).toHaveLength(14);
		expect(LOGO_WIDTH).toBeLessThanOrEqual(32);
		expect(LOGO_WIDTH).toBeGreaterThan(24);
		for (const line of LOGO_LINES) {
			expect(line.trim()).not.toBe("");
			expect(line).toBe(line.trimEnd());
		}
		// The renderer strips the common indent, so some row starts flush.
		expect(LOGO_LINES.some((line) => !line.startsWith(" "))).toBe(true);
	});

	it("is what the installer draws, row for row", () => {
		// install.sh cannot import the module, so it carries a copy. This is the
		// only thing keeping the two the same.
		const rows = installerLogoRows(99);
		expect(rows.map((row) => row.trimEnd())).toEqual(LOGO_LINES);
	});

	it("is padded to one width in the installer, so its band covers the backdrop", () => {
		const rows = installerLogoRows(99);
		const widths = new Set(rows.map((row) => visibleWidth(row)));
		expect(widths.size).toBe(1);
		expect([...widths][0]).toBeGreaterThanOrEqual(LOGO_WIDTH);
	});
});
