import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	normalizeProcessLimits,
	type ProcessLimits,
	processLimitControls,
	systemdUserEnvironment,
} from "./process-limits.js";

/** Shared Linux cgroup budget. Owners must dispose after their runtimes stop. */
export class ProcessResourceGroup {
	readonly unit = `app-wasmedge_agent_${randomUUID().replaceAll("-", "")}.slice`;
	readonly limits: Readonly<ProcessLimits>;
	private references = 1;
	private ownerReleased = false;
	private initialized = false;
	private attempted = false;

	constructor(limits: ProcessLimits) {
		const normalized = normalizeProcessLimits(limits, process.platform, "rustCell.treeProcessLimits");
		if (!normalized) throw new Error("ProcessResourceGroup requires at least one limit");
		this.limits = normalized;
	}

	/** Keep the budget alive while another session uses it. Release exactly once. */
	retain(): () => void {
		if (!this.references) throw new Error("Process resource group is disposed");
		this.references++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.release();
		};
	}

	/** Configure once; each launch independently verifies the kernel controls. */
	ensure(): void {
		if (!this.references) throw new Error("Process resource group is disposed");
		if (this.initialized) return;
		this.attempted = true;
		this.systemctl(["set-property", "--runtime", this.unit, ...processLimitControls(this.limits, false).properties]);
		this.initialized = true;
	}

	dispose(): void {
		if (!this.ownerReleased) {
			this.ownerReleased = true;
			this.references--;
		}
		this.cleanup();
	}

	private release(): void {
		this.references--;
		this.cleanup();
	}

	private cleanup(): void {
		if (this.references || !this.attempted) return;
		// Stop remaining descendants before removing the limits. Both commands
		// address only this object's unique unit, never another tree's slice.
		this.systemctl(["stop", this.unit]);
		this.systemctl(["revert", this.unit]);
		this.attempted = false;
	}

	private systemctl(args: string[]): void {
		execFileSync("/usr/bin/systemctl", ["--user", ...args], {
			env: systemdUserEnvironment(),
			stdio: "pipe",
			timeout: 15_000,
		});
	}
}
