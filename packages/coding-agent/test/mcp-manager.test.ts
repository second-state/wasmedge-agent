import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

describe("McpManager", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-mgr-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("disables every built-in integration when no credentials exist", () => {
		const manager = new McpManager({ authStorage });
		for (const status of manager.listStatus()) {
			expect(status.enabled).toBe(false);
		}
	});

	it("enables an integration once credentials are stored", () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const manager = new McpManager({ authStorage });
		const status = manager.listStatus().find((s) => s.server === "linear");
		expect(status?.enabled).toBe(true);
		const notion = manager.listStatus().find((s) => s.server === "notion");
		expect(notion?.enabled).toBe(false);
	});

	it("registers an OAuth provider per built-in integration", () => {
		new McpManager({ authStorage });
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("keeps MCP providers registered after ModelRegistry.refresh() resets the registry", () => {
		new McpManager({ authStorage });
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.refresh(); // calls resetOAuthProviders(); must re-add MCP providers
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("re-registers user-declared OAuth servers after ModelRegistry.refresh via the reset hook", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } }),
		});
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.setOnOAuthProvidersReset(() => manager.registerUserProviders());
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		registry.refresh(); // resets registry; hook must re-add the custom provider
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("exposes only mcp.refresh when no interactive login is wired", async () => {
		const manager = new McpManager({ authStorage });
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual(["mcp.call_tool", "mcp.config", "mcp.list_tools", "mcp.refresh"]);

		// refresh with no credentials fails (so the cell reports a refresh error,
		// not a false success), and a missing server arg is rejected.
		await expect(handlers["mcp.refresh"]({ server: "linear" })).rejects.toThrow("Could not refresh");
		await expect(handlers["mcp.refresh"]({})).rejects.toThrow("requires a server");
	});

	it("exposes mcp.begin_login only when beginLogin is provided", async () => {
		let called = "";
		const manager = new McpManager({
			authStorage,
			beginLogin: async (server) => {
				called = server;
			},
		});
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual([
			"mcp.begin_login",
			"mcp.call_tool",
			"mcp.config",
			"mcp.list_tools",
			"mcp.refresh",
		]);
		await handlers["mcp.begin_login"]({ server: "linear" });
		expect(called).toBe("linear");
	});

	it("mcp.config returns the resolved URL + headers, honoring a user override of a catalog name", async () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({
				linear: { type: "http", url: "https://proxy.test/mcp", oauth: true, headers: { "X-Extra": "1" } },
			}),
		});
		const handlers = manager.hostHandlers();
		expect(await handlers["mcp.config"]({ server: "linear" })).toEqual({
			url: "https://proxy.test/mcp",
			headers: { "X-Extra": "1" },
		});
		expect(await handlers["mcp.config"]({ server: "notion" })).toEqual({ url: "https://mcp.notion.com/mcp" });
	});

	it("does not treat an oauth override of a catalog name as authed via the official stored cred", () => {
		// Pre-existing official Linear cred from a prior login.
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "official",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp", oauth: true } }),
		});
		// Must NOT be enabled — else the official token would be sent to the override URL.
		expect(manager.listStatus().find((s) => s.server === "linear")?.enabled).toBe(false);
	});

	it("honors a bearer-token env var for user-declared servers", () => {
		process.env.MY_MCP_TOKEN = "secret";
		try {
			const manager = new McpManager({
				authStorage,
				getUserServers: () => ({
					custom: { type: "http", url: "https://example.test/mcp", bearerTokenEnvVar: "MY_MCP_TOKEN" },
				}),
			});
			const status = manager.listStatus().find((s) => s.server === "custom");
			expect(status?.enabled).toBe(true);
		} finally {
			delete process.env.MY_MCP_TOKEN;
		}
	});

	it("picks up mcpServers added after construction on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeUndefined();

		servers = { acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } };
		manager.refresh();
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeDefined();
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("drops the built-in provider when a catalog name is overridden without oauth", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp" } }),
		});
		void manager;
		// Built-in linear provider must be gone so we don't send the official token to the override URL.
		expect(getOAuthProvider("mcp:linear")).toBeUndefined();
	});

	it("unregisters a user server's OAuth provider when it's removed on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {
			acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true },
		};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(getOAuthProvider("mcp:acme")).toBeDefined();

		servers = {};
		manager.refresh();
		expect(getOAuthProvider("mcp:acme")).toBeUndefined();
	});
});

describe("McpManager host-side client (mcp.list_tools / mcp.call_tool)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-client-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function fakeConnector() {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
		let closed = 0;
		const connector = async (options: { url: string; headers: Record<string, string> }) => {
			calls.push(options);
			return {
				listTools: async () => [{ name: "search_issues", description: "Search", inputSchema: { type: "object" } }],
				callTool: async (name: string, args: Record<string, unknown>) => {
					toolCalls.push({ name, args });
					return { content: [{ type: "text", text: "ok" }] };
				},
				close: async () => {
					closed += 1;
				},
			};
		};
		return { connector, calls, toolCalls, closedCount: () => closed };
	}

	it("serves list_tools and call_tool over one cached connection with bearer auth", async () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok-123",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const fake = fakeConnector();
		const manager = new McpManager({ authStorage, connector: fake.connector });
		const handlers = manager.hostHandlers();

		const listed = await handlers["mcp.list_tools"]({ server: "linear" });
		expect(listed.tools).toEqual([{ name: "search_issues", description: "Search", inputSchema: { type: "object" } }]);

		const result = await handlers["mcp.call_tool"]({
			server: "linear",
			tool: "search_issues",
			arguments: { query: "bug" },
		});
		expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(fake.toolCalls).toEqual([{ name: "search_issues", args: { query: "bug" } }]);

		// One connection for both requests, with the OAuth bearer attached.
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.headers.Authorization).toBe("Bearer tok-123");
	});

	it("rejects unknown servers and servers without credentials", async () => {
		const fake = fakeConnector();
		const manager = new McpManager({ authStorage, connector: fake.connector });
		const handlers = manager.hostHandlers();

		await expect(handlers["mcp.list_tools"]({ server: "linear" })).rejects.toThrow("not enabled");
		await expect(handlers["mcp.list_tools"]({ server: "nope" })).rejects.toThrow("unknown MCP server");
		expect(fake.calls).toHaveLength(0);
	});

	it("drops the cached connection on refresh so new credentials apply", async () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok-1",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const fake = fakeConnector();
		const manager = new McpManager({ authStorage, connector: fake.connector });
		const handlers = manager.hostHandlers();

		await handlers["mcp.list_tools"]({ server: "linear" });
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok-2",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		manager.refresh();
		await handlers["mcp.list_tools"]({ server: "linear" });

		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[1]?.headers.Authorization).toBe("Bearer tok-2");
		expect(fake.closedCount()).toBe(1);
		await manager.dispose();
	});
});
