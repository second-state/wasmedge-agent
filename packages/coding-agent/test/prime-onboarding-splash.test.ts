import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { PrimeOnboardingSplashComponent } from "../src/modes/interactive/components/prime-onboarding-splash.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { WASMEDGE_LOGO } from "../src/themes/wasmedge-logo.js";

const logoLines = WASMEDGE_LOGO.split("\n");
const firstLogoLine = logoLines[0]?.trim() ?? "";

/** A run of the mark's last row with no space in it: the backdrop shows
 *  through the mark's spaces, so a whole row never appears contiguously. */
const LAST_ROW_MARK = (logoLines.at(-1) ?? "")
	.split(" ")
	.reduce((longest, run) => (run.length > longest.length ? run : longest), "");

describe("PrimeOnboardingSplashComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("exits the app on ctrl+c and ctrl+d instead of trapping the user", () => {
		for (const key of ["\x03", "\x04"]) {
			const onExit = vi.fn();
			const splash = new PrimeOnboardingSplashComponent(() => {}, { onExit });

			splash.handleInput(key);

			expect(onExit).toHaveBeenCalledOnce();
		}
	});

	it("renders the brand mark with the welcome line beneath it", () => {
		const component = new PrimeOnboardingSplashComponent(() => {}, { getRows: () => 36 });
		const lines = component.render(100);
		const rendered = lines.map((line) => stripAnsi(line));
		const output = rendered.join("\n");

		expect(output).toContain(firstLogoLine);
		expect(output).toContain("Welcome to WasmEdge Agent");
		expect(output).toContain("> Choose a provider");
		// First run is provider-neutral: nothing on the splash points at one vendor.
		expect(output).not.toMatch(/Prime/);
		// Choosing a provider is the only route forward.
		expect(output).not.toContain("Continue later");
		// The description is present and wrapped inside the block rather than
		// running past its width; the wording itself is not the behaviour.
		const descriptionRows = rendered.filter((line) => line.trim().length > 0);
		expect(descriptionRows.length).toBeGreaterThan(logoLines.length);
		for (const line of rendered) {
			expect(stripAnsi(line).trimEnd().length).toBeLessThanOrEqual(100);
		}

		const lastLogoRow = rendered.findIndex((line) => line.includes(LAST_ROW_MARK));
		const brandRow = rendered.findIndex((line) => line.includes("Welcome to WasmEdge Agent"));
		const actionRow = rendered.findIndex((line) => line.includes("Choose a provider"));
		expect(brandRow).toBeGreaterThan(lastLogoRow);
		expect(actionRow).toBeGreaterThan(brandRow);
	});

	it("left aligns the mark, the welcome line and the actions", () => {
		const component = new PrimeOnboardingSplashComponent(() => {}, { getRows: () => 40 });
		const rendered = component.render(100).map((line) => stripAnsi(line));
		const output = rendered.join("\n");

		expect(output).not.toContain("Enter");
		expect(output).not.toContain("Esc");

		const brandLine = rendered.find((line) => line.includes("Welcome to WasmEdge Agent"));
		const actionLine = rendered.find((line) => line.includes("Choose a provider"));
		// One shared left edge for the welcome line and the action.
		expect(brandLine?.indexOf("Welcome")).toBe(actionLine?.indexOf(">"));
		// Everything hugs the left edge; only the animated field spans the pane.
		expect(brandLine?.search(/\S/)).toBeLessThanOrEqual(2);
		// The mark is indented a little further right than the text column, but is
		// still left aligned rather than centred (the field spans the pane, so the
		// mark's own glyphs pin its position rather than leading whitespace). The
		// widest row of the mark starts at its left edge.
		const edgeGlyphs = "█▀▀█▄▀▀";
		const markLine = rendered.find((line) => line.includes(edgeGlyphs));
		expect(markLine).toBeDefined();
		const markColumn = markLine?.indexOf(edgeGlyphs) ?? -1;
		expect(markColumn).toBeGreaterThan(brandLine?.search(/\S/) ?? 0);
		expect(markColumn).toBeLessThanOrEqual(16);
	});

	it("opens the provider picker on confirm", () => {
		let selected = false;
		const component = new PrimeOnboardingSplashComponent(() => {
			selected = true;
		});

		component.handleInput("\r");

		expect(selected).toBe(true);
	});

	it("never falls back to the intro once a flow has started", () => {
		const component = new PrimeOnboardingSplashComponent(() => {}, { getRows: () => 36 });
		component.setPanel({ render: () => ["panel row"], invalidate: () => {} }, "Choose a provider to log in");
		// Between two flow panels the block must not flash the first screen back.
		component.setPanel(undefined);
		const output = stripAnsi(component.render(100).join("\n"));

		expect(output).toContain("Welcome to WasmEdge Agent");
		expect(output).not.toContain("> Choose a provider");
		expect(output).not.toContain("persistent context");
	});

	it("animates the mark at an interactive cadence", () => {
		vi.useFakeTimers();
		let renderRequests = 0;
		const component = new PrimeOnboardingSplashComponent(() => {}, {
			getRows: () => 36,
			requestRender: () => {
				renderRequests++;
			},
			animationIntervalMs: 20,
		});

		const firstRender = stripAnsi(component.render(100).join("\n"));
		vi.advanceTimersByTime(60);
		const secondRender = stripAnsi(component.render(100).join("\n"));
		component.dispose();

		expect(renderRequests).toBe(3);
		expect(secondRender).not.toBe(firstRender);
		expect(secondRender).toContain("Welcome to WasmEdge Agent");
	});

	it("draws the mark in one row per frame, then holds it", () => {
		vi.useFakeTimers();
		const component = new PrimeOnboardingSplashComponent(() => {}, {
			getRows: () => 36,
			requestRender: () => {},
			animationIntervalMs: 20,
		});

		const opening = stripAnsi(component.render(100).join("\n"));
		expect(opening).toContain(firstLogoLine);
		expect(opening).not.toContain(LAST_ROW_MARK);

		vi.advanceTimersByTime(20 * (logoLines.length - 1));
		const revealed = stripAnsi(component.render(100).join("\n"));
		expect(revealed).toContain(LAST_ROW_MARK);

		vi.advanceTimersByTime(20 * 50);
		expect(stripAnsi(component.render(100).join("\n"))).toContain(LAST_ROW_MARK);
		component.dispose();
	});

	it("shows the whole mark when it is not animating", () => {
		const component = new PrimeOnboardingSplashComponent(() => {}, { getRows: () => 36 });

		expect(stripAnsi(component.render(100).join("\n"))).toContain(LAST_ROW_MARK);
	});

	it("finishes the draw-in when a flow panel takes over the block", () => {
		vi.useFakeTimers();
		const component = new PrimeOnboardingSplashComponent(() => {}, {
			getRows: () => 36,
			requestRender: () => {},
			animationIntervalMs: 20,
		});

		expect(stripAnsi(component.render(100).join("\n"))).not.toContain(LAST_ROW_MARK);
		component.setPanel({ render: () => ["panel row"], invalidate: () => {} });
		const output = stripAnsi(component.render(100).join("\n"));
		expect(output).toContain(LAST_ROW_MARK);
		expect(output).toContain("panel row");
		component.dispose();
	});
});
