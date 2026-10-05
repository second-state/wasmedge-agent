import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type CustomMessage,
	RUST_STATE_RESTORED_CUSTOM_TYPE,
	type RustStateRestoredDetails,
} from "../src/core/messages.js";
import { InjectedPromptMessageComponent } from "../src/modes/interactive/components/injected-prompt-message.js";
import { initTheme, preloadCodeHighlighter } from "../src/modes/interactive/theme/theme.js";

describe("workspace restore warning display", () => {
	beforeAll(async () => {
		initTheme("dark");
		await preloadCodeHighlighter();
	});

	function message(warnings?: string[]): CustomMessage<RustStateRestoredDetails> {
		return {
			role: "custom",
			customType: RUST_STATE_RESTORED_CUSTOM_TYPE,
			content: "<rust_state_restored>Full model inventory</rust_state_restored>",
			display: true,
			timestamp: 0,
			details: { restored: true, warnings },
		};
	}

	it.each([40, 120])("keeps inventory warnings visible without expansion at width %s", (width) => {
		const warnings = [
			"state.json could not be read or parsed; state keys are unavailable.",
			"state/blobs could not be read; blob names are unavailable.",
		];
		const component = new InjectedPromptMessageComponent(message(warnings));
		for (const expanded of [false, true]) {
			component.setExpanded(expanded);
			const text = stripVTControlCharacters(component.render(width).join("\n")).replace(/\s+/g, " ");
			expect(text).toContain("Restored persistent workspace");
			for (const warning of warnings) expect(text).toContain(warning);
			expect(text).not.toContain("Full model inventory");
		}
	});

	it("keeps legacy notices without warning metadata compact", () => {
		const saved = message();
		delete saved.details;
		const component = new InjectedPromptMessageComponent(saved);
		component.setExpanded(true);
		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).toContain("Restored persistent workspace");
		expect(text).not.toContain("unavailable");
		expect(text).not.toContain("Full model inventory");
	});
});
