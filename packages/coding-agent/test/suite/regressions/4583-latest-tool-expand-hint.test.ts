import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildConversationComponents } from "../../../src/modes/interactive/components/conversation-components.js";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const LONG_OUTPUT = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");

const bashTool: AgentTool = {
	name: "bash",
	label: "bash",
	description: "Execute a test bash command",
	parameters: Type.Object({ command: Type.String() }),
	execute: async () => ({
		content: [{ type: "text", text: LONG_OUTPUT }],
		details: {},
	}),
};

describe("ENG-4583 latest tool expand hint", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("shows the expand or collapse hint only on the latest tool row", async () => {
		harness = await createHarness({ tools: [bashTool] });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "seq a" }, { id: "tool-4583-a" }),
					fauxToolCall("bash", { command: "seq b" }, { id: "tool-4583-b" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "seq c" }, { id: "tool-4583-c" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run three cells");

		const components = buildConversationComponents(harness.session.messages, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			cwd: harness.tempDir,
			toolOptions: {},
			getToolDefinition: () => undefined,
		});
		const tools = components.filter(
			(component): component is ToolExecutionComponent => component instanceof ToolExecutionComponent,
		);
		const latest = tools.at(-1);

		expect(tools).toHaveLength(3);
		expect(latest).toBeDefined();
		if (!latest) {
			throw new Error("Expected a latest tool component");
		}
		expect(render(tools.slice(0, -1))).not.toContain("to expand");
		expect(render([latest])).toContain("to expand");
		expect(render(tools).match(/to expand/g)).toHaveLength(1);

		// The rust runtime's tool rows render via the default/bash renderers,
		// which only hint while collapsed; expanding must clear the hint.
		for (const tool of tools) {
			tool.setExpanded(true);
		}
		expect(render(tools)).not.toContain("to expand");
	});
});

function render(components: readonly ToolExecutionComponent[]): string {
	return components.map((component) => stripAnsi(component.render(120).join("\n"))).join("\n");
}
