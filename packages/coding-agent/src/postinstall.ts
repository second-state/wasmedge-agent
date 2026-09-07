import { ensureTemplateReady, resolveToolchain } from "./core/rust-cell/index.js";
import { ensureTool } from "./utils/tools-manager.js";

const bootstrapRuntime = process.env.WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL === "1";
const bootstrapTools = process.env.PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL === "1";

if (!bootstrapRuntime && !bootstrapTools) {
	process.exit(0);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oneLine(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

try {
	if (bootstrapTools) {
		await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	}
	if (bootstrapRuntime) {
		const toolchain = resolveToolchain();
		ensureTemplateReady(toolchain.cargoBin, (message) => console.log(`wasmedge-agent: ${message}`));
	}
} catch (error) {
	console.error(`wasmedge-agent: postinstall setup skipped: ${oneLine(errorMessage(error))}`);
}
