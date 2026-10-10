import { record, sha256 } from "./files.js";
import type { Provider } from "./types.js";

export function credentials(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; apiKey: string } {
	const baseUrl = env.PRIME_AGENT_BASE_URL;
	const apiKey = env.PRIME_AGENT_API_KEY;
	if (!baseUrl || !apiKey)
		throw new Error("Missing PRIME_AGENT_BASE_URL or PRIME_AGENT_API_KEY; load the authorized environment first");
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Invalid provider base URL");
	}
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("Provider base URL must be HTTP(S) without credentials, query or fragment");
	}
	return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

export async function discoverProvider(
	requestedId?: string,
	api: Provider["api"] = "openai-completions",
): Promise<{ provider: Provider; discovery: Record<string, unknown> }> {
	const { baseUrl, apiKey } = credentials();
	const bases =
		api === "anthropic-messages"
			? [baseUrl.replace(/\/v1$/, "")]
			: baseUrl.endsWith("/v1")
				? [baseUrl]
				: [`${baseUrl}/v1`, `${baseUrl}/api/v1`, baseUrl];
	const probes: Record<string, unknown>[] = [];
	for (const candidate of bases) {
		let response: Response;
		try {
			response = await fetch(`${candidate}${api === "anthropic-messages" ? "/v1" : ""}/models`, {
				headers:
					api === "anthropic-messages"
						? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
						: { Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			probes.push({ path: new URL(candidate).pathname, outcome: "network_error" });
			continue;
		}
		probes.push({
			path: new URL(candidate).pathname,
			status: response.status,
			contentType: response.headers.get("content-type"),
		});
		if (!response.ok) {
			await response.body?.cancel();
			continue;
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			continue;
		}
		if (!record(body)) continue;
		const models = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
		const ids = models.flatMap((model) => (record(model) && typeof model.id === "string" ? [model.id] : []));
		const opus = ids.filter((id) => /opus[-_. ]*5[-_. ]*5(?:$|[^0-9])/i.test(id));
		const modelId = requestedId ?? (opus.length === 1 ? opus[0] : undefined);
		if (!modelId || !ids.includes(modelId)) {
			throw new Error(
				`Opus 5.5 must match an advertised model ID; candidates: ${opus.join(", ") || "none"}. Use --model for an exact selection`,
			);
		}
		return {
			provider: {
				api,
				baseUrl: candidate,
				modelId,
				modelIdentity: "advertised-id-not-independent-revision-verification",
				contextWindow: 200_000,
				maxTokens: 16_384,
			},
			discovery: {
				api,
				discoveredAt: new Date().toISOString(),
				endpointSha256: sha256(candidate),
				modelId,
				modelListSha256: sha256(JSON.stringify(body)),
				modelCount: ids.length,
				probes,
				secretSaved: false,
			},
		};
	}
	throw new Error(`No JSON model catalog at the provider base URL; probes: ${JSON.stringify(probes)}`);
}

export function modelsConfig(
	baseUrl: string,
	modelId: string,
	maxTokens = 16_384,
	api: Provider["api"] = "openai-completions",
): Record<string, unknown> {
	return {
		providers: {
			benchmark: {
				api,
				baseUrl,
				apiKey: "BENCH_GATEWAY_TOKEN",
				...(api === "openai-completions"
					? {
							compat: {
								supportsDeveloperRole: false,
								supportsReasoningEffort: false,
								maxTokensField: "max_tokens",
							},
						}
					: {}),
				models: [
					{ id: modelId, name: modelId, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens },
				],
			},
		},
	};
}
