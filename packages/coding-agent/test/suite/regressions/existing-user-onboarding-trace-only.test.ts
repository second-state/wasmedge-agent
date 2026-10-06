import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import type { ModelRegistry } from "../../../src/core/model-registry.js";
import type { SettingsManager } from "../../../src/core/settings-manager.js";
import type { AgentConnectionModel } from "../../../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

// Upstream asks existing users a first-run trace-sharing question. The fork
// dropped that question by decision (trace sharing is opt-in via /traces), so
// these regressions pin the fork's flow: existing users see no onboarding at
// all, and new users only get the provider picker.

interface OnboardingSplashHandle {
	dismiss(): void;
}

interface ExistingUserOnboardingHarness {
	runOnboardingFlow(): Promise<boolean>;
	uiServices: {
		modelRegistry: ModelRegistry;
		settingsManager: SettingsManager;
	};
	connectionState: { model: AgentConnectionModel } | undefined;
	showOnboardingSplash(options?: { immediate?: boolean }): Promise<OnboardingSplashHandle | undefined>;
	showConfigurationMenu(initialTab: string): Promise<void>;
}

function createFakeMode(harness: Harness, order: string[]): ExistingUserOnboardingHarness {
	const fakeThis = Object.create(InteractiveMode.prototype) as ExistingUserOnboardingHarness;
	fakeThis.uiServices = {
		modelRegistry: harness.session.modelRegistry,
		settingsManager: harness.settingsManager,
	};
	fakeThis.connectionState = undefined;
	fakeThis.showOnboardingSplash = vi.fn(async () => {
		order.push("splash");
		return { dismiss: () => order.push("dismiss") };
	});
	fakeThis.showConfigurationMenu = vi.fn(async (tab: string) => {
		order.push(`menu:${tab}`);
	});
	return fakeThis;
}

describe("existing user onboarding asks no trace question", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	test("existing user completes without splash, login, provider picker, or trace question", async () => {
		const harness = await createHarness({ provider: "prime-inference", withConfiguredAuth: true });
		harnesses.push(harness);
		const order: string[] = [];
		const fakeThis = createFakeMode(harness, order);
		fakeThis.connectionState = { model: harness.getModel() as AgentConnectionModel };

		const result = await fakeThis.runOnboardingFlow();

		expect(result).toBe(true);
		expect(order).toEqual([]);
		expect(harness.settingsManager.getAgentTracesEnabled()).toBe(false);
	});

	test("existing user with traces already enabled completes silently", async () => {
		const harness = await createHarness({ provider: "prime-inference", withConfiguredAuth: true });
		harnesses.push(harness);
		harness.settingsManager.setAgentTracesEnabled(true);
		const order: string[] = [];
		const fakeThis = createFakeMode(harness, order);
		fakeThis.connectionState = { model: harness.getModel() as AgentConnectionModel };

		const result = await fakeThis.runOnboardingFlow();

		expect(result).toBe(true);
		expect(order).toEqual([]);
	});

	test("new user without configured auth gets only the provider picker", async () => {
		const harness = await createHarness({ provider: "prime-inference", withConfiguredAuth: false });
		harnesses.push(harness);
		const order: string[] = [];
		const fakeThis = createFakeMode(harness, order);
		fakeThis.showConfigurationMenu = vi.fn(async (tab: string) => {
			order.push(`menu:${tab}`);
			// The picker's successful login: credentials land and a model is selected.
			harness.authStorage.set("prime-inference", { type: "api_key", key: "picked" });
			fakeThis.connectionState = { model: harness.getModel() as AgentConnectionModel };
		});

		const result = await fakeThis.runOnboardingFlow();

		expect(result).toBe(true);
		// New user: splash waits for Enter (no immediate option).
		expect(fakeThis.showOnboardingSplash).toHaveBeenCalledWith();
		expect(order).toEqual(["splash", "dismiss", "menu:providers"]);
		expect(harness.settingsManager.getAgentTracesEnabled()).toBe(false);
	});

	test("new user who leaves the provider picker without a model is not complete", async () => {
		const harness = await createHarness({ provider: "prime-inference", withConfiguredAuth: false });
		harnesses.push(harness);
		const order: string[] = [];
		const fakeThis = createFakeMode(harness, order);

		const result = await fakeThis.runOnboardingFlow();

		expect(result).toBe(false);
		expect(order).toEqual(["splash", "dismiss", "menu:providers"]);
	});
});
