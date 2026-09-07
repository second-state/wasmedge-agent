import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_NAME_WARNINGS } from "../src/config.js";
import { getAvailableThemes, initTheme, resolveThemeName, theme } from "../src/modes/interactive/theme/theme.js";

describe("built-in theme name", () => {
	beforeEach(() => {
		LEGACY_NAME_WARNINGS.length = 0;
	});

	afterEach(() => {
		LEGACY_NAME_WARNINGS.length = 0;
		initTheme("dark");
	});

	it("loads under its current name", () => {
		initTheme("wasmedge");
		expect(theme.name).toBe("wasmedge");
		expect(getAvailableThemes()).toContain("wasmedge");
		expect(LEGACY_NAME_WARNINGS).toHaveLength(0);
	});

	it("still resolves the pre-rename name a saved settings file can hold", () => {
		// The one-release alias. Without it a settings.json written before the
		// rename names a theme that no longer exists, and the loader falls back
		// to dark without saying why.
		initTheme("prime");
		expect(theme.name).toBe("wasmedge");
	});

	it("warns through the deprecation channel when the old name is used", () => {
		expect(resolveThemeName("prime")).toBe("wasmedge");
		expect(LEGACY_NAME_WARNINGS).toHaveLength(1);
		expect(LEGACY_NAME_WARNINGS[0]).toContain("wasmedge");
		// Deduped like every other legacy-name warning, so a second lookup in
		// the same process does not repeat it.
		expect(resolveThemeName("prime")).toBe("wasmedge");
		expect(LEGACY_NAME_WARNINGS).toHaveLength(1);
	});

	it("leaves every other name alone and warns about none of them", () => {
		expect(resolveThemeName("dark")).toBe("dark");
		expect(resolveThemeName("light")).toBe("light");
		expect(resolveThemeName("wasmedge")).toBe("wasmedge");
		expect(resolveThemeName("my-theme")).toBe("my-theme");
		expect(LEGACY_NAME_WARNINGS).toHaveLength(0);
	});

	it("does not offer the old name as a theme to pick", () => {
		expect(getAvailableThemes()).not.toContain("prime");
	});
});
