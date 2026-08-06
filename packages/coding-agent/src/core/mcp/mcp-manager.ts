// Host side of MCP integrations. The host registers OAuth providers and
// serves mcp.* host-requests; cells reach the protocol through rlm::mcp and
// the host runs the actual MCP client (streamable HTTP) with its credentials.

import {
	BUILTIN_MCP_CATALOG,
	createMcpOAuthProvider,
	getCatalogEntry,
	registerBuiltinMcpOAuthProviders,
} from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";
import { defaultMcpConnector, type McpConnection, type McpConnector } from "./mcp-client.js";

export interface McpManagerOptions {
	authStorage: AuthStorage;
	/** Reads the current Settings.mcpServers (name → config). Re-read on refresh(). */
	getUserServers?: () => Record<string, McpServerConfig> | undefined;
	/** Start an interactive host-side login for a server. Provided by the UI mode. */
	beginLogin?: (server: string) => Promise<void>;
	/** MCP connection factory; tests inject a fake. Default: streamable HTTP SDK client. */
	connector?: McpConnector;
}

/** A resolved integration: a catalog/user entry plus its provider id. */
interface ResolvedIntegration {
	server: string;
	label: string;
	url: string;
	usesOAuth: boolean;
	bearerTokenEnvVar?: string;
	enabled?: boolean;
	/** Extra static HTTP headers from the user config. */
	headers?: Record<string, string>;
	/** True when this came from Settings.mcpServers (may override a catalog name). */
	userDeclared?: boolean;
}

export class McpManager {
	private readonly authStorage: AuthStorage;
	private readonly getUserServers: () => Record<string, McpServerConfig> | undefined;
	private readonly beginLogin?: (server: string) => Promise<void>;
	private readonly connector: McpConnector;
	private integrations = new Map<string, ResolvedIntegration>();
	/** Provider ids we registered for user servers, so refresh can drop removed ones. */
	private registeredUserProviderIds = new Set<string>();
	/** Live MCP connections per server; entries drop on failure/refresh/dispose. */
	private connections = new Map<string, Promise<McpConnection>>();

	constructor(options: McpManagerOptions) {
		this.authStorage = options.authStorage;
		this.getUserServers = options.getUserServers ?? (() => undefined);
		this.beginLogin = options.beginLogin;
		this.connector = options.connector ?? defaultMcpConnector;
		this.resolveIntegrations();
		this.registerProviders();
	}

	/** Re-read settings and re-register providers; call after a session reload. */
	refresh(): void {
		this.resolveIntegrations();
		this.registerProviders();
		this.invalidateConnections();
	}

	private invalidateConnections(server?: string): void {
		const targets = server ? [server] : [...this.connections.keys()];
		for (const name of targets) {
			const pending = this.connections.get(name);
			this.connections.delete(name);
			void pending?.then((connection) => connection.close()).catch(() => {});
		}
	}

	async dispose(): Promise<void> {
		const pending = [...this.connections.values()];
		this.connections.clear();
		await Promise.allSettled(pending.map(async (entry) => (await entry).close()));
	}

	private providerId(server: string): string {
		return `mcp:${server}`;
	}

	private resolveIntegrations(): void {
		const integrations = new Map<string, ResolvedIntegration>();
		for (const entry of BUILTIN_MCP_CATALOG) {
			integrations.set(entry.server, {
				server: entry.server,
				label: entry.label,
				url: entry.url,
				usesOAuth: entry.oauth?.kind === "oauth",
			});
		}
		for (const [server, config] of Object.entries(this.getUserServers() ?? {})) {
			if (config.type !== "http") continue; // stdio servers are unsupported by the host client
			integrations.set(server, {
				server,
				label: server,
				url: config.url,
				usesOAuth: config.oauth === true,
				bearerTokenEnvVar: config.bearerTokenEnvVar,
				enabled: config.enabled,
				headers: config.headers,
				userDeclared: true,
			});
		}
		this.integrations = integrations;
	}

	private registerProviders(): void {
		registerBuiltinMcpOAuthProviders();
		this.registerUserProviders();
	}

	/**
	 * Register OAuth providers for user-declared (non-catalog) servers. Public so it
	 * can run after ModelRegistry.refresh() resets the registry — otherwise custom
	 * `mcp:<server>` providers vanish on every refresh (e.g. post-login).
	 */
	registerUserProviders(): void {
		const current = new Set<string>();
		for (const integration of this.integrations.values()) {
			if (!integration.userDeclared) continue;
			const id = this.providerId(integration.server);
			if (integration.usesOAuth) {
				// Register pointing at the user's URL (overrides a catalog default too).
				current.add(id);
				registerOAuthProvider(
					createMcpOAuthProvider({
						server: integration.server,
						label: integration.label,
						url: integration.url,
					}),
				);
			} else if (getCatalogEntry(integration.server)) {
				// User overrode a catalog server with a custom URL but no oauth: drop the
				// built-in provider so we never send the official token to that URL.
				unregisterOAuthProvider(id);
			}
		}
		// Drop providers for user servers removed since the last registration.
		for (const id of this.registeredUserProviderIds) {
			if (!current.has(id)) unregisterOAuthProvider(id);
		}
		this.registeredUserProviderIds = current;
	}

	/** True when valid credentials exist for the integration (drives enablement). */
	private isAuthed(integration: ResolvedIntegration): boolean {
		if (integration.enabled === false) return false;
		if (integration.bearerTokenEnvVar && process.env[integration.bearerTokenEnvVar]?.trim()) {
			return true;
		}
		// A user server that overrides a catalog name must NOT inherit the built-in's
		// stored mcp: creds — those were issued for the official endpoint and could be
		// sent to the override URL. Such an override authenticates only via a bearer
		// env var (handled above); we don't trust auth.json OAuth creds for it.
		if (integration.userDeclared && getCatalogEntry(integration.server)) {
			return false;
		}
		const cred = this.authStorage.get(this.providerId(integration.server));
		return cred !== undefined;
	}

	/** Bearer/static headers for a server, refreshing OAuth creds as needed. */
	private async authHeaders(integration: ResolvedIntegration): Promise<Record<string, string>> {
		const headers: Record<string, string> = { ...integration.headers };
		if (integration.bearerTokenEnvVar) {
			const token = process.env[integration.bearerTokenEnvVar]?.trim();
			if (token) headers.Authorization = `Bearer ${token}`;
			return headers;
		}
		if (integration.userDeclared && getCatalogEntry(integration.server)) {
			// Never send built-in creds to an override URL (see isAuthed).
			return headers;
		}
		const key = await this.authStorage.getApiKey(this.providerId(integration.server));
		if (key) headers.Authorization = `Bearer ${key}`;
		return headers;
	}

	/** Live connection for a server; throws a cell-readable error when the
	 * server is unknown, disabled, or not logged in. */
	private connection(server: string): Promise<McpConnection> {
		const existing = this.connections.get(server);
		if (existing) return existing;
		const integration = this.integrations.get(server);
		if (!integration) {
			throw new Error(
				`unknown MCP server "${server}" (stdio servers are unsupported; declare an http server in settings)`,
			);
		}
		if (!this.isAuthed(integration)) {
			throw new Error(`MCP server "${server}" is not enabled; log in with /mcp login ${server}`);
		}
		const pending = (async () => {
			const headers = await this.authHeaders(integration);
			return this.connector({ url: integration.url, headers });
		})();
		this.connections.set(server, pending);
		pending.catch(() => this.connections.delete(server));
		return pending;
	}

	/** Host-request handlers exposed to cells. */
	hostHandlers(): Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> {
		const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
			"mcp.list_tools": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.list_tools requires a server");
				const connection = await this.connection(server);
				return { tools: await connection.listTools() };
			},
			"mcp.call_tool": async (payload) => {
				const server = String(payload.server ?? "");
				const tool = String(payload.tool ?? "");
				if (!server || !tool) throw new Error("mcp.call_tool requires a server and a tool");
				const args =
					typeof payload.arguments === "object" && payload.arguments !== null
						? (payload.arguments as Record<string, unknown>)
						: {};
				const connection = await this.connection(server);
				return await connection.callTool(tool, args);
			},
			"mcp.refresh": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.refresh requires a server");
				// getApiKey refreshes + rewrites auth.json under lock; the guest re-reads.
				// Surface failure (throw) instead of a false success so the cell can
				// report a refresh error rather than a misleading "not enabled".
				const key = await this.authStorage.getApiKey(this.providerId(server));
				if (!key) throw new Error(`Could not refresh credentials for ${server}`);
				this.invalidateConnections(server);
				return {};
			},
			// Resolved config so the guest connects to the same URL the host
			// registered/authenticated (honors a user's mcpServers `url` override).
			"mcp.config": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.config requires a server");
				const integration = this.integrations.get(server);
				if (!integration) return {};
				const config: Record<string, unknown> = { url: integration.url };
				if (integration.headers && Object.keys(integration.headers).length > 0) {
					config.headers = integration.headers;
				}
				return config;
			},
		};
		// Only expose begin_login when an interactive login is actually wired, so
		// cells don't get a handler whose only behavior is to throw.
		const beginLogin = this.beginLogin;
		if (beginLogin) {
			handlers["mcp.begin_login"] = async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.begin_login requires a server");
				await beginLogin(server);
				return {};
			};
		}
		return handlers;
	}

	/** Status for the /mcp list command. */
	listStatus(): Array<{ server: string; label: string; enabled: boolean; usesOAuth: boolean }> {
		return Array.from(this.integrations.values()).map((integration) => ({
			server: integration.server,
			label: integration.label,
			enabled: this.isAuthed(integration),
			usesOAuth: integration.usesOAuth,
		}));
	}
}
