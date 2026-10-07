import { execFileSync } from "node:child_process";
import { resourceLimitedCommand } from "../../src/core/rust-cell/process-limits.js";

export function hasProcessLimits(): boolean {
	try {
		const command = resourceLimitedCommand(
			{ bin: "/usr/bin/true", args: [], env: process.env },
			{ memoryMaxMb: 128, cpuQuotaPercent: 100, tasksMax: 64 },
		);
		execFileSync(command.bin, command.args, { env: command.env, stdio: "pipe", timeout: 10_000 });
		return true;
	} catch (error) {
		if (process.platform === "linux" && process.env.CI && process.env.WASMEDGE_AGENT_WASMEDGE)
			throw new Error("Runtime CI requires working cgroup controllers and a systemd user manager", { cause: error });
		return false;
	}
}
