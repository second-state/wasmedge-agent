/** Host-side MCP client (DESIGN.md §5.3): cells never speak MCP themselves —
 * mcp.list_tools / mcp.call_tool host requests resolve here, over streamable
 * HTTP with the host's credentials. The connector is injectable so tests run
 * without a live server or the SDK's network stack. */

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpConnection {
	listTools(): Promise<McpToolInfo[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

export interface McpConnectOptions {
	url: string;
	headers: Record<string, string>;
}

export type McpConnector = (options: McpConnectOptions) => Promise<McpConnection>;

/** Real connector: official MCP SDK over streamable HTTP. Imported lazily so
 * sessions that never touch MCP never load the SDK. */
export const defaultMcpConnector: McpConnector = async ({ url, headers }) => {
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
	const client = new Client({ name: "wasmedge-agent", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers },
	});
	await client.connect(transport);
	return {
		listTools: async () => {
			const reply = await client.listTools();
			return reply.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			}));
		},
		callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as Record<string, unknown>,
		close: () => client.close(),
	};
};
