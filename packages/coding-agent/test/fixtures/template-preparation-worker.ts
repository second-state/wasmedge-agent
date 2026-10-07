import { ProvisioningContext } from "../../src/core/rust-cell/provisioning.js";
import { acquireTemplateLock } from "../../src/core/rust-cell/template-lock.js";
import {
	ensureTemplateReady,
	ensureTemplateReadyAsync,
	vendorTemplate,
	warmTemplate,
} from "../../src/core/rust-cell/toolchain.js";

const [template, cargo, mode, timeout] = process.argv.slice(2);
process.env.WASMEDGE_AGENT_TEMPLATE_DIR = template;
const controller = new AbortController();
const context = new ProvisioningContext(controller.signal, Number(timeout));
const onMessage = (message: unknown) => {
	if (message === "cancel") controller.abort(new Error("waiter cancelled"));
};
process.on("message", onMessage);
process.send?.({ event: "started" });
try {
	if (mode === "hold") {
		const release = await acquireTemplateLock(template, context);
		process.send?.({ event: "held" });
		try {
			await new Promise<void>((resolve) => process.once("message", () => resolve()));
		} finally {
			release();
		}
	} else if (mode === "sync") ensureTemplateReady(cargo);
	else if (mode === "vendor") vendorTemplate(cargo);
	else if (mode === "warm") warmTemplate(cargo);
	else await ensureTemplateReadyAsync(cargo, context);
	process.send?.({ event: "done" });
} catch (error) {
	process.send?.({ event: "failed", error: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
} finally {
	context.dispose();
	process.removeListener("message", onMessage);
	process.disconnect?.();
}
