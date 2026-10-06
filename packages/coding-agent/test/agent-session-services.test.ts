import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import type { AgentObserveController } from "../src/core/agent-observe.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

// The fork ships no default collector; telemetry (and its disclosure) only
// exists once an endpoint is configured.
const TEST_TELEMETRY_ENDPOINT = "https://telemetry.example.invalid/v1/events";

describe("createAgentSessionFromServices", () => {
	const cleanupPaths: string[] = [];
	const unregisters: Array<() => void> = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (unregisters.length > 0) {
			unregisters.pop()?.();
		}
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("enables CLI login reuse only for default services storage", async () => {
		const tempDir = join(tmpdir(), `pi-default-services-auth-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		vi.stubEnv("HOME", tempDir);
		vi.stubEnv(ENV_AGENT_DIR, "");
		const injected = AuthStorage.inMemory();
		for (const options of [{}, { agentDir: join(tempDir, "custom") }, { authStorage: injected }]) {
			const services = await createAgentSessionServices({
				cwd: tempDir,
				...options,
				telemetryDisabled: true,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			expect(services.modelRegistry.authStorage).toBe(services.authStorage);
			expect(services.authStorage.getPrimeCliConfigPath()).toBe(
				"agentDir" in options || "authStorage" in options ? undefined : join(tempDir, ".prime", "config.json"),
			);
			if ("authStorage" in options) expect(services.authStorage).toBe(injected);
		}
	});

	it("shows the telemetry disclosure independently of the Herdr reporter", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY", "1");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY_ENDPOINT", TEST_TELEMETRY_ENDPOINT);
		const tempDir = join(tmpdir(), `pi-session-telemetry-notice-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setOnboardingShown(true);

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).toContainEqual(
			expect.objectContaining({ type: "info", message: expect.stringContaining("pseudonymous usage") }),
		);
		expect(services.diagnostics).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining(TEST_TELEMETRY_ENDPOINT) }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(true);
	});

	it("shows no telemetry disclosure when no telemetry endpoint is configured", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY", "1");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY_ENDPOINT", "");
		const tempDir = join(tmpdir(), `pi-session-telemetry-no-endpoint-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setOnboardingShown(true);

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).not.toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("pseudonymous usage") }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(false);
	});

	it("defers the telemetry disclosure on a first interactive launch", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY", "1");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY_ENDPOINT", TEST_TELEMETRY_ENDPOINT);
		const tempDir = join(tmpdir(), `pi-session-telemetry-first-run-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		// A settings profile that has never seen onboarding: the notice would land
		// on the welcome screen, so it waits for the next launch.
		const settingsManager = SettingsManager.inMemory();

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			noBuiltinHerdrReporter: true,
			deferTelemetryNoticeForOnboarding: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).not.toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("pseudonymous usage") }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(false);
	});

	it("discloses telemetry immediately for sessions that never onboard", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY", "1");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY_ENDPOINT", TEST_TELEMETRY_ENDPOINT);
		const tempDir = join(tmpdir(), `pi-session-telemetry-headless-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		// No onboarding will run here, so holding the notice back would hide it forever.
		const settingsManager = SettingsManager.inMemory();

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("pseudonymous usage") }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(true);
	});

	it("honors an explicit daemon-carried telemetry opt-out", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY", "1");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY_ENDPOINT", TEST_TELEMETRY_ENDPOINT);
		const tempDir = join(tmpdir(), `pi-session-daemon-telemetry-opt-out-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			telemetryDisabled: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).not.toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("pseudonymous usage") }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(false);

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			telemetryDisabled: true,
		});
		try {
			expect(existsSync(join(tempDir, "telemetry.json"))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("does not install top-level telemetry for a resumed child session", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY", "1");
		vi.stubEnv("WASMEDGE_AGENT_TELEMETRY_ENDPOINT", TEST_TELEMETRY_ENDPOINT);
		const tempDir = join(tmpdir(), `pi-session-child-telemetry-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory({ telemetry: { noticeShown: true } }),
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.newSession({ rlmDepth: 1 });

		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		try {
			expect(session.rlmDepth).toBe(1);
			expect(existsSync(join(tempDir, "telemetry.json"))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("forwards daemon-backed agent message controllers into AgentSession", async () => {
		const tempDir = join(tmpdir(), `pi-session-services-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		const faux = registerFauxProvider();
		unregisters.push(() => faux.unregister());

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noPromptTemplates: true,
				noThemes: true,
				// No skills at all: capability gating is controller-driven, so the
				// messaging handlers must register without any discovered skill.
				skillsOverride: () => ({ skills: [], diagnostics: [] }),
			},
		});
		services.modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});

		const agentMessageController: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "current", sessionId: "session-current", runtimeKind: "top-level" },
				agents: [
					{
						activeSessionId: "worker",
						sessionId: "session-worker",
						runtimeKind: "top-level",
						cwd: tempDir,
						isStreaming: false,
						unfinishedActionCount: 0,
					},
				],
			}),
			sendAgentMessage: async () => {
				throw new Error("not used");
			},
		};

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			model: faux.getModel(),
			agentMessageController,
		});

		try {
			expect(() => session.handleAgentMessageHostRequest("agent_message.list")).toThrow(
				"unknown agent message request",
			);
			// Capability gating is controller-driven: the rlm::msg guest API is a
			// crate built-in, so a wired controller registers handlers even when no
			// model-visible skill mentions messaging.
			expect(
				(
					session as unknown as {
						_createHostRequestHandlers(): Record<string, unknown>;
					}
				)._createHostRequestHandlers(),
			).toHaveProperty("agent_message.send");
		} finally {
			session.dispose();
		}
	});

	it("registers orchestration host handlers only when their controllers are wired", async () => {
		const tempDir = join(tmpdir(), `pi-session-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		const authStorage = AuthStorage.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		const createSession = async (options: Parameters<typeof createAgentSessionFromServices>[0]) => {
			const { session } = await createAgentSessionFromServices(options);
			return session;
		};
		const hostRequestHandlers = (session: unknown) =>
			(
				session as {
					_createHostRequestHandlers(): Record<string, unknown>;
				}
			)._createHostRequestHandlers();

		const withoutControllers = await createSession({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-without")),
		});
		try {
			expect(hostRequestHandlers(withoutControllers)).not.toHaveProperty("agent_message.send");
			expect(hostRequestHandlers(withoutControllers)).not.toHaveProperty("agent_observe.list");
		} finally {
			withoutControllers.dispose();
		}

		const agentObserveController: AgentObserveController = {
			listAgents: () => ({
				current: {
					activeSessionId: "current",
					sessionId: "session-current",
					runtimeKind: "top-level",
					cwd: tempDir,
					status: "idle",
					isCurrent: true,
					isStreaming: false,
					isCompacting: false,
					attachedClients: 1,
					messageCount: 0,
					queuedCount: 0,
					isSessionActive: false,
				},
				agents: [],
			}),
			getAgent: () => {
				throw new Error("not used");
			},
			recentMessages: () => {
				throw new Error("not used");
			},
		};
		const withControllers = await createSession({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-with")),
			agentObserveController,
		});
		try {
			expect(hostRequestHandlers(withControllers)).toHaveProperty("agent_observe.list");
			expect(hostRequestHandlers(withControllers)).not.toHaveProperty("agent_message.send");
		} finally {
			withControllers.dispose();
		}

		const agentMessageController: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "current", sessionId: "session-current" },
				agents: [],
			}),
			sendAgentMessage: async () => {
				throw new Error("not used");
			},
		};
		const withMessageController = await createSession({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-with-message")),
			agentMessageController,
		});
		try {
			expect(hostRequestHandlers(withMessageController)).toHaveProperty("agent_message.send");
		} finally {
			withMessageController.dispose();
		}
	});
});
