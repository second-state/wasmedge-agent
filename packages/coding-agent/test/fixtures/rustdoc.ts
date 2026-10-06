import { execFileSync } from "node:child_process";
import { RUSTDOC_TEST_TOOLCHAIN } from "../../src/core/rust-cell/rustdoc-index.js";
import { findRustupBin } from "../../src/core/rust-cell/toolchain.js";

export function hasRustdocToolchain(): boolean {
	try {
		const targets = execFileSync(
			findRustupBin(),
			["target", "list", "--installed", "--toolchain", RUSTDOC_TEST_TOOLCHAIN],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		if (targets.includes("wasm32-wasip1")) return true;
	} catch {}
	if (process.env.CI && process.env.WASMEDGE_AGENT_WASMEDGE)
		throw new Error(`Runtime CI requires ${RUSTDOC_TEST_TOOLCHAIN} with wasm32-wasip1`);
	return false;
}
