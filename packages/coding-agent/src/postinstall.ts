import { resolveToolchain, warmTemplate } from "./core/rust-cell/index.js";
import { ensureTool } from "./utils/tools-manager.js";

const bootstrapRuntime = process.env.PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL === "1";
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
		console.log("prime-agent: warming the cell workspace template (one-time)...");
		warmTemplate(toolchain.cargoBin);
	}
} catch (error) {
	console.error(`prime-agent: postinstall setup skipped: ${oneLine(errorMessage(error))}`);
}
