import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { resolveAcpMcpServers } from "../src/modes/acp/acp-mcp.js";
import { runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness } from "./suite/harness.js";

function runtimeHostFor(session: unknown): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

describe("ACP MCP servers", () => {
	// The rust-cell runtime has no transport for client-supplied ACP MCP servers
	// (upstream served them through the removed Python kernel), so the ACP host
	// must not advertise the capability and must reject any declared server
	// before it reaches the session.
	it("does not advertise MCP capabilities and rejects client-supplied MCP servers", async () => {
		const harness = await createHarness();
		const replace = vi.spyOn(harness.session, "replaceAcpMcpServers");
		const release = vi.spyOn(harness.session, "releaseAcpMcpServers");
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		expect(connection.supportsAcpMcpServers()).toBe(false);
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const modeDone = runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		});
		const handle = acp
			.client({ name: "mcp-test-client" })
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		try {
			const initialized = await handle.agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			expect(initialized.agentCapabilities?.mcpCapabilities).toBeUndefined();

			await expect(
				handle.agent.request("session/new", {
					cwd: harness.tempDir,
					mcpServers: [
						{
							type: "http",
							name: "TaskTools",
							url: "https://task.example/mcp",
							headers: [{ name: "Authorization", value: "Bearer task" }],
						},
						{
							name: "LocalTools",
							command: "node",
							args: ["server.js"],
							env: [{ name: "TASK_TOKEN", value: "task-secret" }],
						},
					],
				}),
			).rejects.toMatchObject({
				message: "Invalid params",
				data: { reason: "MCP servers are unavailable in this ACP host" },
			});
			expect(replace).not.toHaveBeenCalled();
			expect(release).not.toHaveBeenCalled();

			// The rejection must not occupy the single-session slot.
			const created = await handle.agent.request("session/new", {
				cwd: harness.tempDir,
				mcpServers: [],
			});
			await handle.agent.request("session/close", { sessionId: created.sessionId });
			expect(replace).not.toHaveBeenCalled();
			expect(release).not.toHaveBeenCalled();
		} finally {
			handle.close();
			await toAgent.writable.close().catch(() => undefined);
			await modeDone;
			harness.cleanup();
		}
	}, 30_000);

	it("rejects non-empty MCP server sets at the session layer", async () => {
		const harness = await createHarness();
		try {
			expect(() =>
				harness.session.replaceAcpMcpServers(
					[{ name: "TaskTools", type: "http", url: "https://task.example/mcp", headers: {} }],
					"owner",
				),
			).toThrow("not supported");
			expect(() => harness.session.replaceAcpMcpServers([], "owner")).not.toThrow();
			await expect(harness.session.releaseAcpMcpServers("owner", [])).resolves.toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("preserves stdio cwd and literal environment", () => {
		const [server] = resolveAcpMcpServers(
			[
				{
					name: "TaskTools",
					command: "node",
					args: ["server.js"],
					env: [{ name: "TASK_TOKEN", value: "secret" }],
				},
			],
			"/actual/session",
		);
		expect(server).toEqual({
			name: "TaskTools",
			type: "stdio",
			command: "node",
			args: ["server.js"],
			cwd: "/actual/session",
			env: { TASK_TOKEN: "secret" },
		});
	});

	it("rejects names that could inject prompt code and ambiguous credentials", () => {
		expect(() =>
			resolveAcpMcpServers(
				[{ type: "http", name: 'bad"\nname', url: "https://task.example/mcp", headers: [] }],
				"/tmp",
			),
		).toThrow("Invalid params");
		expect(() =>
			resolveAcpMcpServers(
				[
					{
						type: "http",
						name: "task",
						url: "https://user:password@task.example/mcp",
						headers: [],
					},
				],
				"/tmp",
			),
		).toThrow("Invalid params");
		expect(() =>
			resolveAcpMcpServers(
				[
					{
						type: "http",
						name: "task",
						url: "https://task.example/mcp",
						headers: [
							{ name: "Authorization", value: "one" },
							{ name: "authorization", value: "two" },
						],
					},
				],
				"/tmp",
			),
		).toThrow("Invalid params");
	});
});
