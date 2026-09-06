import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installerSource = readFileSync("install.sh", "utf-8");
const mainCall = '\nmain "$@"';
const mainCallIndex = installerSource.lastIndexOf(mainCall);
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const syncEnd = "\x1b[?2026l";
const failures = [];

if (mainCallIndex === -1) {
	console.error('Installer render check failed: could not find final main "$@" call.');
	process.exit(1);
}

const harnessSource = `${installerSource.slice(0, mainCallIndex)}

wasmedge_agent_test_cols=80
wasmedge_agent_test_rows=24

wasmedge_agent_read_terminal_size() {
	wasmedge_agent_screen_cols="$wasmedge_agent_test_cols"
	wasmedge_agent_screen_rows="$wasmedge_agent_test_rows"
}

print_render_meta() {
	label="$1"
	if wasmedge_agent_show_logo; then
		visible=1
	else
		visible=0
	fi
	content_height=$(wasmedge_agent_content_height)
	printf '__META__ %s cols=%s rows=%s layout_show_logo=%s lab_width=%s render_lab_width=%s compact=%s visible=%s content_height=%s\\n' \\
		"$label" "$wasmedge_agent_screen_cols" "$wasmedge_agent_screen_rows" "$wasmedge_agent_screen_layout_show_logo" \\
		"$wasmedge_agent_screen_layout_lab_width" "$wasmedge_agent_screen_render_lab_width" "$wasmedge_agent_screen_compact" "$visible" "$content_height"
}

render_case() {
	wasmedge_agent_screen_title="Installing WasmEdge Agent"
	wasmedge_agent_screen_detail="Fetching the verified package."
	wasmedge_agent_screen_question=
	wasmedge_agent_screen_frame=1
	wasmedge_agent_screen_cols="$1"
	wasmedge_agent_screen_rows="$2"
	wasmedge_agent_screen_layout_ready=0
	wasmedge_agent_screen_layout_show_logo=0
	wasmedge_agent_screen_layout_lab_width=0
	wasmedge_agent_screen_render_lab_width=0
	wasmedge_agent_screen_compact=0
	wasmedge_agent_init_screen_layout
	wasmedge_agent_refresh_screen_layout_mode
	print_render_meta first
	printf '__RENDER_START__ first\\n'
	wasmedge_agent_render_screen
	printf '__RENDER_END__ first\\n'

	wasmedge_agent_screen_frame=2
	wasmedge_agent_screen_cols="$3"
	wasmedge_agent_screen_rows="$4"
	wasmedge_agent_refresh_screen_layout_mode
	print_render_meta second
	printf '__RENDER_START__ second\\n'
	wasmedge_agent_render_screen
	printf '__RENDER_END__ second\\n'
}

screen_case() {
	wasmedge_agent_screen_enabled=1
	wasmedge_agent_screen_drawn=0
	wasmedge_agent_screen_last_cols=0
	wasmedge_agent_screen_last_rows=0
	wasmedge_agent_screen_layout_ready=0
	wasmedge_agent_screen_layout_show_logo=0
	wasmedge_agent_screen_layout_lab_width=0
	wasmedge_agent_screen_render_lab_width=0
	wasmedge_agent_screen_compact=0
	wasmedge_agent_screen_frame=0

	wasmedge_agent_test_cols="$1"
	wasmedge_agent_test_rows="$2"
	printf '__SCREEN_START__ first\\n' >&2
	wasmedge_agent_screen "Installing WasmEdge Agent" "Installing WasmEdge Agent" "Fetching the verified package." ""
	printf '__SCREEN_END__ first\\n' >&2

	wasmedge_agent_test_cols="$3"
	wasmedge_agent_test_rows="$4"
	printf '__SCREEN_START__ second\\n' >&2
	wasmedge_agent_screen "Installing WasmEdge Agent" "Installing WasmEdge Agent" "Fetching the verified package." ""
	printf '__SCREEN_END__ second\\n' >&2
}

progress_case() {
	progress_details="Preparing global install.
Linking command binaries.
Finalizing npm install."
	for progress_frame in 1 24 25 48 49 200; do
		wasmedge_agent_animation_frame="$progress_frame"
		printf '__PROGRESS__ %s\t%s\t%s\\n' "$progress_frame" "$(wasmedge_agent_animation_status "Installing WasmEdge Agent" "$progress_details" static)" "$(wasmedge_agent_animation_detail "$progress_details")"
	done
}

render_case "$@"
screen_case "$@"
progress_case
`;

const tempDir = mkdtempSync(join(tmpdir(), "wasmedge-agent-installer-render-"));
const harnessPath = join(tempDir, "harness.sh");

try {
	writeFileSync(harnessPath, harnessSource, "utf-8");

	const stableVisible = runCase("stable visible logo", 100, 30, 90, 30);
	check(stableVisible.meta.first.visible === "1", "expected the initial large render to show the logo");
	check(stableVisible.meta.second.visible === "1", "expected a safe resize to keep showing the logo");
	check(
		stableVisible.meta.first.lab_width === stableVisible.meta.second.lab_width,
		"expected logo lab width to stay stable across a safe resize",
	);
	assertInstallerProgress(stableVisible.progress);

	const stableExpand = runCase("stable expanded logo", 60, 24, 120, 32);
	check(stableExpand.meta.first.visible === "1", "expected the initial medium render to show the logo");
	check(stableExpand.meta.second.visible === "1", "expected terminal growth to keep showing the logo");
	check(
		stableExpand.meta.first.lab_width === stableExpand.meta.second.lab_width,
		"expected logo lab width not to grow after terminal expansion",
	);

	const noLogoStart = runCase("small initial terminal", 41, 24, 100, 30);
	check(noLogoStart.meta.first.layout_show_logo === "0", "expected a too-narrow initial terminal to freeze text-only layout");
	check(noLogoStart.meta.second.visible === "0", "expected terminal growth not to enable a logo after text-only layout was frozen");

	const narrowLogo = runCase("narrow logo on width shrink", 100, 30, 60, 24);
	check(narrowLogo.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(narrowLogo.meta.second.compact === "0", "expected shrink below frozen lab width to keep rendering the logo");
	check(narrowLogo.meta.second.visible === "1", "expected narrow width mode to keep showing the logo");
	check(
		Number(narrowLogo.meta.second.render_lab_width) <= 59,
		"expected narrow width mode to keep the rendered lab width inside the resized terminal",
	);

	const compactWidth = runCase("compact on severe width shrink", 100, 30, 32, 24);
	check(compactWidth.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(compactWidth.meta.second.compact === "1", "expected shrink below logo width to use compact mode");
	check(compactWidth.meta.second.visible === "0", "expected severe compact width mode to hide the logo");

	const compactRows = runCase("compact on row shrink", 100, 30, 100, 10);
	check(compactRows.meta.first.visible === "1", "expected the initial tall render to show the logo");
	check(compactRows.meta.second.compact === "1", "expected shrink below frozen splash height to use compact mode");
	check(compactRows.meta.second.visible === "0", "expected compact row mode to hide the logo");

	checkNodeFloor();
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

/** The installer's Node floor, against the one the package actually requires.
 *
 *  They were 20.6.0 and 22.8.0. Every machine in between passed installer
 *  preflight, npm installed the package with nothing louder than an engine
 *  warning, and the command exited on first launch -- the one outcome an
 *  installer exists to prevent. Nothing held the two numbers together, so
 *  raising the package's engines moved only half of it.
 *
 *  Checked three ways, because the installer states the floor three ways: the
 *  message a user reads, the `node -e` comparison that gates an install when
 *  node is already present, and the shell comparison that decides whether a
 *  package manager's candidate is worth installing. A drift in any one of them
 *  is the same bug. */
function checkNodeFloor() {
	const engines = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf-8")).engines?.node ?? "";
	const floor = engines.replace(/^\D*/, "");
	if (!/^\d+\.\d+\.\d+$/.test(floor)) {
		check(false, `expected engines.node to name an exact floor, found ${JSON.stringify(engines)}`);
		return;
	}
	const [major, minor] = floor.split(".").map(Number);

	for (const [, mentioned] of installerSource.matchAll(/Node\.js (\d+\.\d+\.\d+)/g)) {
		check(mentioned === floor, `installer tells the user Node.js ${mentioned}, but the package requires ${floor}`);
	}

	const inline = installerSource.match(/major > (\d+) \|\| \(major === (\d+) && \(minor > (\d+)/);
	check(inline !== null, "could not find the installer's node -e version comparison");
	if (inline) {
		check(
			Number(inline[1]) === major && Number(inline[2]) === major && Number(inline[3]) === minor,
			`installer's node -e comparison gates on ${inline[1]}.${inline[3]}, but the package requires ${floor}`,
		);
	}

	const probes = [
		["20.6.0", false],
		[`${major}.${minor - 1}.99`, false],
		[floor, true],
		[`${major + 1}.0.0`, true],
	];
	const probePath = join(tempDir, "node-floor.sh");
	writeFileSync(
		probePath,
		`${installerSource.slice(0, mainCallIndex)}\nfor candidate in ${probes.map(([version]) => version).join(" ")}; do\n\tif node_version_string_is_new_enough "$candidate"; then printf '%s yes\\n' "$candidate"; else printf '%s no\\n' "$candidate"; fi\ndone\n`,
		"utf-8",
	);
	const probed = spawnSync("sh", [probePath], { encoding: "utf-8" });
	if (probed.status !== 0) {
		check(false, `node floor probe exited ${probed.status}: ${probed.stderr}`);
		return;
	}
	const verdicts = new Map(
		probed.stdout
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => line.split(" ")),
	);
	for (const [version, accepted] of probes) {
		check(
			verdicts.get(version) === (accepted ? "yes" : "no"),
			`installer ${accepted ? "rejects" : "accepts"} Node.js ${version} against a ${floor} floor`,
		);
	}
}

if (failures.length > 0) {
	console.error(["Installer render check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Installer render check passed.");

function runCase(name, initialCols, initialRows, resizedCols, resizedRows) {
	const result = spawnSync("sh", [harnessPath, String(initialCols), String(initialRows), String(resizedCols), String(resizedRows)], {
		detached: true,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		failures.push(`${name}: harness exited with ${result.status ?? "unknown"}\n${result.stderr}${result.stdout}`);
		return emptyParsedCase();
	}

	const parsed = parseRenderOutput(result.stdout);
	parsed.screens = parseScreenOutput(result.stderr);
	assertLineWidths(name, "first", parsed, initialCols, initialRows);
	assertLineWidths(name, "second", parsed, resizedCols, resizedRows);
	assertScreenFrame(name, "first", parsed, initialCols, initialRows);
	assertScreenFrame(name, "second", parsed, resizedCols, resizedRows);
	return parsed;
}

function parseRenderOutput(output) {
	const parsed = emptyParsedCase();
	let activeRender = null;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("__META__ ")) {
			const [, label, ...fields] = line.split(" ");
			parsed.meta[label] = Object.fromEntries(fields.map((field) => field.split("=")));
			continue;
		}
		if (line.startsWith("__RENDER_START__ ")) {
			activeRender = line.slice("__RENDER_START__ ".length);
			parsed.renders[activeRender] = [];
			continue;
		}
		if (line.startsWith("__RENDER_END__ ")) {
			activeRender = null;
			continue;
		}
		if (line.startsWith("__PROGRESS__ ")) {
			const [frame, status, detail] = line.slice("__PROGRESS__ ".length).split("\t");
			parsed.progress.push({ frame: Number(frame), status, detail });
			continue;
		}
		if (activeRender) {
			parsed.renders[activeRender].push(line.replace(ansiPattern, ""));
		}
	}

	return parsed;
}

function parseScreenOutput(output) {
	const screens = {};
	for (const label of ["first", "second"]) {
		const startToken = `__SCREEN_START__ ${label}\n`;
		const endToken = `__SCREEN_END__ ${label}\n`;
		const startIndex = output.indexOf(startToken);
		if (startIndex === -1) {
			failures.push(`missing ${label} screen start marker`);
			continue;
		}
		const contentStart = startIndex + startToken.length;
		const endIndex = output.indexOf(endToken, contentStart);
		if (endIndex === -1) {
			failures.push(`missing ${label} screen end marker`);
			continue;
		}
		screens[label] = output.slice(contentStart, endIndex);
	}
	return screens;
}

function assertInstallerProgress(progress) {
	check(progress.length === 6, `expected six progress samples, got ${progress.length}`);
	if (progress.length !== 6) return;

	const expectedDetails = [
		"Preparing global install.",
		"Preparing global install.",
		"Linking command binaries.",
		"Linking command binaries.",
		"Finalizing npm install.",
		"Finalizing npm install.",
	];
	for (const [index, expectedDetail] of expectedDetails.entries()) {
		check(
			progress[index].detail === expectedDetail,
			`expected progress sample ${index + 1} to show "${expectedDetail}", got "${progress[index].detail}"`,
		);
		check(
			progress[index].status === "Installing WasmEdge Agent...",
			`expected progress sample ${index + 1} to use indeterminate status`,
		);
		check(!progress[index].status.includes("%"), `expected progress sample ${index + 1} not to include a percent`);
	}
}

function assertLineWidths(name, label, parsed, cols, rows) {
	const lines = parsed.renders[label] ?? [];
	check(lines.length === rows, `${name}: expected ${label} render to have ${rows} rows, got ${lines.length}`);

	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} render line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function assertScreenFrame(name, label, parsed, cols, rows) {
	const screen = parsed.screens[label] ?? "";
	check(screen.endsWith(syncEnd), `${name}: expected ${label} screen frame to end with synchronized update close`);
	check(!screen.endsWith(`\n${syncEnd}`), `${name}: expected ${label} screen frame not to emit a trailing row newline`);
	check(countNewlines(screen) === rows - 1, `${name}: expected ${label} screen frame to contain ${rows - 1} line breaks`);

	const lines = screen.replace(ansiPattern, "").split("\n");
	check(lines.length === rows, `${name}: expected ${label} screen frame to contain ${rows} rows, got ${lines.length}`);
	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} screen line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function countNewlines(text) {
	let count = 0;
	for (const char of text) {
		if (char === "\n") count++;
	}
	return count;
}

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

function emptyParsedCase() {
	return {
		meta: {
			first: {},
			second: {},
		},
		renders: {
			first: [],
			second: [],
		},
		screens: {},
		progress: [],
	};
}
