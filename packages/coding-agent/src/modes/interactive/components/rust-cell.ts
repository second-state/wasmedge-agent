/** Self-rendering TUI block for the rust tool (DESIGN.md §2.9): the WP4
 * replacement for the kernel-era ipython-cell component. One fixed top line
 * (status marker · language · preview · line counts · compile/run timing ·
 * error label) that never shifts when toggling; per-file change summaries stay
 * visible, and expansion attaches the highlighted cell source and the
 * stdout/stderr or rustc diagnostics below it. */

import {
	type Component,
	truncateToWidth,
	VersionedRenderCache,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatAgentMessageParticipant } from "../../../core/agent-messages.js";
import { previewRustCode } from "../../../core/tools/code-preview.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
import { getWorkingPulseFrame, WORKING_ICON_FRAMES, workingIconFrame } from "../theme/working-icon.js";
import { agentMessageBodyLines, agentMessageSummaryLine } from "./agent-message.js";
import { normalizeErrorDetails } from "./collapsible-error.js";
import { renderDiffSeparator, renderRichDiff } from "./diff.js";
import { countChangedLines, FILE_CHANGE_DIFF_INDENT, formatFileChangeSummaryLine } from "./edit-summary.js";

export interface RustCellContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface RustCellState {
	code: string;
	content?: readonly RustCellContentBlock[];
	details?: unknown;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	editDiffsExpanded?: boolean;
	showExpandHint?: boolean;
	executionStarted?: boolean;
	argsComplete?: boolean;
	showImages?: boolean;
	/** Session cwd — edit paths nested under it render relative, else absolute. */
	cwd?: string;
}

interface DiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	startLine?: number;
}

interface SentAgentMessageDisplay {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}

/** The CellResult fields the renderer reads (rust-cell/types.ts). */
interface RustCellDetails {
	status?: string;
	stdout?: string;
	stderr?: string;
	compileDiagnostics?: string;
	exitCode?: number;
	durationMs?: number;
	compileMs?: number;
	runMs?: number;
	libReverted?: boolean;
	diffs?: DiffDisplay[];
	sentAgentMessages?: SentAgentMessageDisplay[];
}

// Match the agent-message tree gutter; input and output text share the same column.
const OUTPUT_INDENT = "   ";

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Append `ESC[0m` when `line` ends with a foreground or background color still
 * open, so a span that wrapTextWithAnsi split across lines cannot bleed into the
 * trailing padding or the next line.
 */
function closeOpenSgr(line: string): string {
	let fgOpen = false;
	let bgOpen = false;
	for (const match of line.matchAll(SGR_PATTERN)) {
		const params = match[1] === "" ? ["0"] : match[1].split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0) {
				fgOpen = false;
				bgOpen = false;
			} else if (code === 38 || code === 48) {
				// Skip the color data of `38;5;n` / `38;2;r;g;b` so a component (e.g. 38) isn't read as a code.
				if (code === 38) fgOpen = true;
				else bgOpen = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 39) {
				fgOpen = false;
			} else if (code === 49) {
				bgOpen = false;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fgOpen = true;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bgOpen = true;
			}
		}
	}
	return fgOpen || bgOpen ? `${line}\x1b[0m` : line;
}

export function getRustCodeFromArgs(args: unknown): string {
	if (!args || typeof args !== "object" || !("code" in args)) {
		return "";
	}
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : "";
}

function readDetails(details: unknown): RustCellDetails {
	if (!details || typeof details !== "object") {
		return {};
	}
	const record = details as Record<string, unknown>;
	return {
		status: typeof record.status === "string" ? record.status : undefined,
		stdout: typeof record.stdout === "string" ? record.stdout : undefined,
		stderr: typeof record.stderr === "string" ? record.stderr : undefined,
		compileDiagnostics: typeof record.compileDiagnostics === "string" ? record.compileDiagnostics : undefined,
		exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
		durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
		compileMs: typeof record.compileMs === "number" ? record.compileMs : undefined,
		runMs: typeof record.runMs === "number" ? record.runMs : undefined,
		libReverted: record.libReverted === true,
		diffs: readDiffDisplays(record.diffs),
		sentAgentMessages: readSentAgentMessages(record.sentAgentMessages),
	};
}

function readSentAgentMessages(value: unknown): SentAgentMessageDisplay[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const messages = value.flatMap((entry): SentAgentMessageDisplay[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const record = entry as Record<string, unknown>;
		const target = record.target;
		if (!target || typeof target !== "object") {
			return [];
		}
		const targetRecord = target as Record<string, unknown>;
		if (
			typeof record.id !== "string" ||
			typeof record.message !== "string" ||
			(record.deliveryStatus !== "delivered" && record.deliveryStatus !== "queued") ||
			typeof targetRecord.activeSessionId !== "string" ||
			typeof targetRecord.sessionId !== "string"
		) {
			return [];
		}
		return [
			{
				id: record.id,
				message: record.message,
				deliveryStatus: record.deliveryStatus,
				...(record.receiverRole === "parent" || record.receiverRole === "sibling" || record.receiverRole === "child"
					? { receiverRole: record.receiverRole }
					: {}),
				target: {
					activeSessionId: targetRecord.activeSessionId,
					sessionId: targetRecord.sessionId,
					...(typeof targetRecord.sessionName === "string" ? { sessionName: targetRecord.sessionName } : {}),
				},
			},
		];
	});
	return messages.length > 0 ? messages : undefined;
}

function readDiffDisplays(value: unknown): DiffDisplay[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const diffs = value.flatMap((entry): DiffDisplay[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.oldStr !== "string" || typeof record.newStr !== "string") {
			return [];
		}
		return [
			{
				path: record.path,
				oldStr: record.oldStr,
				newStr: record.newStr,
				startLine: typeof record.startLine === "number" ? record.startLine : undefined,
			},
		];
	});
	return diffs.length > 0 ? diffs : undefined;
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) {
		return undefined;
	}
	if (durationMs < 1000) {
		return `${Math.round(durationMs)}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function isImageBlock(block: RustCellContentBlock): boolean {
	return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

export class RustCellComponent implements Component {
	private readonly renderCache = new VersionedRenderCache();
	private state: RustCellState;
	private stateVersion = 0;

	constructor(state: RustCellState) {
		this.state = state;
	}

	update(state: RustCellState): void {
		this.state = state;
		this.stateVersion += 1;
	}

	invalidate(): void {
		this.renderCache.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const details = readDetails(this.state.details);
		// Fold the animation frame into the cache key while running (offset within
		// a stateVersion slot so it never collides with another version).
		const frames = WORKING_ICON_FRAMES.length;
		const cacheVersion =
			this.statusKind(details) === "running"
				? this.stateVersion * frames + (getWorkingPulseFrame() % frames)
				: this.stateVersion * frames;
		const cached = this.renderCache.get(safeWidth, cacheVersion);
		if (cached) {
			return cached;
		}

		// The top line is identical whether collapsed or expanded — same marker,
		// counts, and timing — so toggling never shifts the layout;
		// expanding only attaches code and output below it.
		const lines = [truncateToWidth(` ${this.collapsedLine(details)}`, safeWidth, "")];

		const hasCode = this.state.expanded ? this.renderCode(lines, safeWidth) : false;
		if ((details.diffs?.length ?? 0) > 0) {
			this.renderDiffs(lines, safeWidth, details.diffs ?? [], hasCode);
		}
		if ((details.sentAgentMessages?.length ?? 0) > 0) {
			this.renderSentAgentMessages(lines, safeWidth, details.sentAgentMessages ?? []);
		}

		if (!this.state.expanded) {
			return this.renderCache.set(safeWidth, cacheVersion, lines);
		}

		this.renderOutput(lines, safeWidth, details, hasCode);
		return this.renderCache.set(safeWidth, cacheVersion, lines);
	}

	private collapsedLine(details: RustCellDetails): string {
		const code = this.state.code.trimEnd();
		const preview = previewRustCode(code);
		const parts = [`${this.marker(details)} ${theme.fg("muted", "rust")}`];

		if (preview.text) {
			// Collapsed preview stays plain and dim so the one-line summary reads as
			// quiet metadata; the expanded block below keeps full highlighting.
			parts.push(theme.fg("dim", preview.text));
		} else if (!this.state.executionStarted) {
			parts.push(theme.fg("dim", "waiting for code"));
		}

		const counts = this.lineCounts(details);
		if (counts) {
			parts.push(theme.fg("dim", counts));
		}

		const timing = this.timing(details);
		if (timing) {
			parts.push(theme.fg("dim", timing));
		}

		const failure = !this.state.isPartial ? this.failureLabel(details) : undefined;
		if (failure) {
			parts.push(theme.fg("error", failure));
		}
		return parts.join(theme.fg("dim", " · "));
	}

	/** `compile 0.3s · run 10ms` once measured; total duration as a fallback. */
	private timing(details: RustCellDetails): string | undefined {
		const segments: string[] = [];
		const compile = formatDuration(details.compileMs);
		// A compile-only cell (compile error) has runMs 0 — skip the run segment.
		const run = details.status === "compile_error" ? undefined : formatDuration(details.runMs);
		if (compile) {
			segments.push(`compile ${compile}`);
		}
		if (run) {
			segments.push(`run ${run}`);
		}
		if (segments.length > 0) {
			return segments.join(theme.fg("dim", " · "));
		}
		return formatDuration(details.durationMs);
	}

	/** Short failure label for the top line; expansion carries the details. */
	private failureLabel(details: RustCellDetails): string | undefined {
		switch (details.status) {
			case "compile_error":
				return "compile error";
			case "timeout":
				return "timeout";
			case "aborted":
				return "aborted";
			case "error":
				return details.exitCode !== undefined ? `exit ${details.exitCode}` : "error";
			default:
				return this.state.isError && details.status === undefined ? "error" : undefined;
		}
	}

	/** Status marker — color carries running/done/error; ✓/✗ once finished. */
	private marker(details: RustCellDetails): string {
		switch (this.statusKind(details)) {
			case "error":
				return theme.fg("error", "✗");
			case "aborted":
				return theme.fg("warning", "✗");
			case "done":
				return theme.fg("success", "✓");
			case "running":
				return theme.fg("bashMode", workingIconFrame(getWorkingPulseFrame()));
			default: // queued
				return theme.fg("muted", "◇");
		}
	}

	// `↑in ↓out lines` — the "lines" unit disambiguates from the token counts on
	// the activity line. Output is omitted for edits (the diff shows on expand).
	private lineCounts(details: RustCellDetails): string | undefined {
		const body = this.state.code.split(/\r?\n/);
		const input = body.filter((line) => line.trim().length > 0).length;

		const hasDiffs = (details.diffs?.length ?? 0) > 0;
		const outputText = [details.stdout, details.stderr, details.compileDiagnostics]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n")
			.trim();
		const output = hasDiffs || !outputText ? 0 : outputText.split("\n").length;

		const segments: string[] = [];
		if (input > 0) {
			segments.push(`↑ ${input}`);
		}
		if (output > 0) {
			segments.push(`↓ ${output}`);
		}
		return segments.length > 0 ? `${segments.join(" ")} lines` : undefined;
	}

	private statusKind(details: RustCellDetails): "error" | "aborted" | "running" | "queued" | "done" {
		const status = details.status;
		if (status === "aborted") {
			return "aborted";
		}
		if (this.state.isError || status === "compile_error" || status === "error" || status === "timeout") {
			return "error";
		}
		// Keyed off the result, not executionStarted, so calls rehydrated from a
		// past session (which never saw the live start) render done, not running.
		if (!this.state.isPartial && (status !== undefined || this.state.executionStarted || this.hasResult(details))) {
			return "done";
		}
		if (this.state.isPartial || this.state.executionStarted) {
			return "running";
		}
		return "queued";
	}

	private hasResult(details: RustCellDetails): boolean {
		return (
			details.stdout !== undefined ||
			details.stderr !== undefined ||
			details.compileDiagnostics !== undefined ||
			(details.diffs?.length ?? 0) > 0 ||
			(details.sentAgentMessages?.length ?? 0) > 0 ||
			(this.state.content?.length ?? 0) > 0
		);
	}

	// Only runs when expanded — shows the full source below the fixed top line.
	private renderCode(lines: string[], width: number): boolean {
		const code = this.state.code.trimEnd();
		if (!code) {
			this.addWrapped(lines, theme.fg("dim", "╰─ "), theme.fg("muted", "waiting for code"), width);
			return false;
		}

		const rawLines = code.split("\n");
		// Highlight the whole cell so multi-line strings and block comments keep
		// color; reopen inherited ANSI styles on each source line before gutters reset them.
		const sourceWidth = rawLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 1);
		const highlightedLines = wrapTextWithAnsi(highlightCode(code, "rust").join("\n"), sourceWidth);
		for (const [index, rawLine] of rawLines.entries()) {
			const prefix = index === 0 ? theme.fg("dim", "╰─ ") : OUTPUT_INDENT;
			const highlighted = highlightedLines[index] ?? theme.fg("mdCodeBlock", rawLine);
			this.addWrapped(lines, prefix, highlighted || " ", width);
		}

		return true;
	}

	// Only runs when expanded — shows full output below the code, no previews.
	private renderOutput(lines: string[], width: number, details: RustCellDetails, hasCode: boolean): void {
		const blocks = this.state.content ?? [];
		const imageCount = blocks.filter(isImageBlock).length;
		let outputStarted = false;
		let renderedTextOutput = false;
		let outputMarkerPending = true;
		const outputPrefix = (): string => {
			if (!outputMarkerPending) return OUTPUT_INDENT;
			outputMarkerPending = false;
			return theme.fg("dim", " › ");
		};

		const startOutput = (): void => {
			if (outputStarted) {
				return;
			}
			outputStarted = true;
			if (hasCode) {
				this.addBlank(lines);
			}
		};

		if (details.compileDiagnostics?.trim()) {
			startOutput();
			renderedTextOutput = true;
			this.renderOutputText(lines, width, normalizeErrorDetails(details.compileDiagnostics), "err", outputPrefix);
		}
		if (details.stdout?.trim()) {
			startOutput();
			renderedTextOutput = true;
			this.renderOutputText(lines, width, normalizeErrorDetails(details.stdout), "out", outputPrefix);
		}
		if (details.stderr?.trim()) {
			startOutput();
			renderedTextOutput = true;
			this.renderOutputText(lines, width, normalizeErrorDetails(details.stderr), "err", outputPrefix);
		}
		if (details.libReverted) {
			startOutput();
			this.addWrapped(
				lines,
				outputPrefix(),
				theme.fg("muted", "lib files were reverted; the cell did not run"),
				width,
			);
		}

		if (!renderedTextOutput && (this.state.isPartial || (this.state.executionStarted && !this.state.argsComplete))) {
			startOutput();
			this.addWrapped(lines, outputPrefix(), theme.fg("muted", "waiting for output..."), width);
		} else if (
			!renderedTextOutput &&
			!details.libReverted &&
			(details.diffs?.length ?? 0) === 0 &&
			(details.sentAgentMessages?.length ?? 0) === 0 &&
			this.state.executionStarted &&
			imageCount === 0
		) {
			startOutput();
			this.addWrapped(lines, outputPrefix(), theme.fg("muted", "no output"), width);
		}

		if (imageCount > 0) {
			startOutput();
			const text = this.state.showImages
				? `${imageCount} image${imageCount === 1 ? "" : "s"} rendered below`
				: `${imageCount} image${imageCount === 1 ? "" : "s"} hidden`;
			this.addWrapped(lines, outputPrefix(), theme.fg("muted", text), width);
		}
	}

	private renderSentAgentMessages(lines: string[], width: number, messages: readonly SentAgentMessageDisplay[]): void {
		for (const message of messages) {
			const label = message.deliveryStatus === "delivered" ? "Agent message sent" : "Agent message queued";
			const recipient = formatAgentMessageParticipant("sent", message.receiverRole, message.target);
			if (this.state.expanded) this.addBlank(lines);
			this.addPlain(lines, truncateToWidth(agentMessageSummaryLine(label, recipient), Math.max(1, width - 1), "…"));
			if (this.state.expanded) {
				for (const line of agentMessageBodyLines(message.message, width)) lines.push(line);
			}
		}
	}

	// The path summary stays visible while conversation detail toggles the diff rows.
	private renderDiffs(lines: string[], width: number, diffs: readonly DiffDisplay[], hasCode: boolean): void {
		const diffsByPath = new Map<string, DiffDisplay[]>();
		for (const diff of diffs) {
			const existing = diffsByPath.get(diff.path);
			if (existing) existing.push(diff);
			else diffsByPath.set(diff.path, [diff]);
		}
		if (hasCode) {
			this.addPlain(lines, "");
		}
		for (const [path, edits] of diffsByPath) {
			this.renderFileDiff(lines, width, path, edits);
		}
	}

	private renderFileDiff(lines: string[], width: number, path: string, edits: readonly DiffDisplay[]): void {
		const language = getLanguageFromPath(path);
		// The outer inset matches ordinary chat text; renderer gutters stay intact.
		const indent = FILE_CHANGE_DIFF_INDENT.slice(0, Math.max(0, width - 1));
		const contentWidth = Math.max(1, width - indent.length);
		let added = 0;
		let removed = 0;
		const rows: string[] = [];
		edits.forEach((edit, index) => {
			const { diff: diffText } = generateDiffString(edit.oldStr, edit.newStr, 4, edit.startLine ?? 1);
			const counts = countChangedLines(diffText);
			added += counts.added;
			removed += counts.removed;
			if (!this.state.editDiffsExpanded) {
				return;
			}
			if (index > 0) {
				rows.push(`${indent}${renderDiffSeparator(contentWidth)}`);
			}
			// Append, not spread: a huge edit's diff can exceed the JS arg-count limit.
			for (const row of renderRichDiff(diffText, contentWidth, { language })) {
				rows.push(`${indent}${row}`);
			}
		});

		lines.push(formatFileChangeSummaryLine(path, this.state.cwd, { added, removed }, width));

		for (const row of rows) {
			lines.push(row);
		}
	}

	private renderOutputText(
		lines: string[],
		width: number,
		text: string,
		label: "out" | "err",
		outputPrefix: () => string,
	): void {
		const color = label === "err" ? "muted" : "toolOutput";
		for (const line of text.split("\n")) {
			this.addWrapped(lines, outputPrefix(), theme.fg(color, line || " "), width);
		}
	}

	// Backgroundless line, indented one space to align under the fixed top line.
	private addWrapped(lines: string[], prefix: string, text: string, width: number): void {
		const available = Math.max(1, width - 1 - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
			const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			// Truncate the composed line so a narrow pane can't exceed width (fatal in the renderer).
			lines.push(truncateToWidth(` ${linePrefix}${closeOpenSgr(line)}`, width, ""));
		}
	}

	private addBlank(lines: string[]): void {
		lines.push("");
	}

	// No-background line, indented one space to align with the summary line above.
	private addPlain(lines: string[], text: string): void {
		lines.push(` ${text}`);
	}
}
