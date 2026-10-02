import { describe, expect, it } from "vitest";
import { cargoEnvironment } from "../src/core/rust-cell/cargo-environment.js";

describe("Cargo environment", () => {
	it("keeps toolchain configuration without inheriting ambient credentials or build overrides", () => {
		const configuration = {
			PATH: "/tools/bin",
			HOME: "/home/test",
			TMPDIR: "/tmp/build",
			SDKROOT: "/sdk",
			CARGO_HOME: "/cargo",
			CARGO_NET_OFFLINE: "true",
			RUSTUP_HOME: "/rustup",
			RUSTUP_TOOLCHAIN: "stable",
			RUSTUP_AUTO_INSTALL: "0",
			RUSTC: "/tools/rustc",
		};
		const source = Object.freeze({
			...configuration,
			OPENAI_API_KEY: "test-only-provider-key",
			CUSTOM_PROVIDER_SECRET: "test-only-secret",
			CARGO_REGISTRIES_PRIVATE_TOKEN: "test-only-registry-token",
			CARGO_HTTP_PROXY: "test-only-proxy",
			HTTPS_PROXY: "test-only-proxy",
			NODE_OPTIONS: "--require=custom.cjs",
			RUSTC_WRAPPER: "/custom/wrapper",
			RUSTFLAGS: "--cfg=custom",
			CARGO_ENCODED_RUSTFLAGS: "--cfg=custom",
			CARGO_TARGET_DIR: "/custom/target",
			CARGO_BUILD_TARGET_DIR: "/custom/target",
			CARGO_BUILD_BUILD_DIR: "/custom/build",
			LD_PRELOAD: "/custom/library",
			DYLD_INSERT_LIBRARIES: "/custom/library",
			TEMP: undefined,
		});
		const result = cargoEnvironment(source, "linux");
		expect(result).toEqual(configuration);
		result.HOME = "/different";
		expect(source.HOME).toBe(configuration.HOME);
	});
	it("preserves Windows tool discovery with case-insensitive names", () => {
		const windows = { Path: "C:\\tools", SYSTEMROOT: "C:\\Windows", ComSpec: "C:\\Windows\\cmd.exe" };
		expect(cargoEnvironment({ ...windows, OpenAI_Api_Key: "test-only-secret" }, "win32")).toEqual(windows);
		expect(cargoEnvironment({ Path: "/custom", cargo_home: "/cargo" }, "linux")).toEqual({});
	});
});
