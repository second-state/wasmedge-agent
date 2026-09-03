import assert from "node:assert";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Component, TUI, tuiLogPath } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

describe("tuiLogPath", () => {
	const previous = process.env.PI_TUI_LOG_DIR;

	afterEach(() => {
		if (previous === undefined) delete process.env.PI_TUI_LOG_DIR;
		else process.env.PI_TUI_LOG_DIR = previous;
	});

	it("uses the directory the host provides", () => {
		process.env.PI_TUI_LOG_DIR = "/var/log/example";
		assert.strictEqual(tuiLogPath("pi-debug.log"), join("/var/log/example", "pi-debug.log"));
	});

	it("falls back to the OS temp dir so a debug flag cannot crash a render", () => {
		delete process.env.PI_TUI_LOG_DIR;
		assert.strictEqual(tuiLogPath("pi-crash.log"), join(tmpdir(), "pi-crash.log"));
	});

	it("falls back outside the config directory when the host supplies nothing", () => {
		delete process.env.PI_TUI_LOG_DIR;
		assert.ok(!tuiLogPath("pi-debug.log").includes(".prime"));
	});
});

class TestComponent implements Component {
	render(_width: number): string[] {
		return ["hello"];
	}
	invalidate(): void {}
}

describe("debug redraw logging", () => {
	const previousDir = process.env.PI_TUI_LOG_DIR;
	const previousDebug = process.env.PI_DEBUG_REDRAW;

	afterEach(() => {
		if (previousDir === undefined) delete process.env.PI_TUI_LOG_DIR;
		else process.env.PI_TUI_LOG_DIR = previousDir;
		if (previousDebug === undefined) delete process.env.PI_DEBUG_REDRAW;
		else process.env.PI_DEBUG_REDRAW = previousDebug;
	});

	it("creates its log directory on demand instead of throwing ENOENT", async () => {
		const dir = join(tmpdir(), `tui-log-path-test-${process.pid}-${Date.now()}`, "nested");
		fs.rmSync(dir, { recursive: true, force: true }); // guarantee it is absent before the render
		process.env.PI_TUI_LOG_DIR = dir;
		process.env.PI_DEBUG_REDRAW = "1";

		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.addChild(new TestComponent());
		try {
			tui.start();
			await terminal.waitForRender();

			const logPath = tuiLogPath("pi-debug.log");
			assert.ok(fs.existsSync(logPath), "debug log should exist even though its directory did not");
			assert.ok(fs.readFileSync(logPath, "utf8").includes("first render"));
		} finally {
			tui.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
