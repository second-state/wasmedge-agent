import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUpdateRestore } from "../src/cli/daemon-update-restore.js";
import type { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { type DaemonCommand, type DaemonResponse, failure, success } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerLifecycle } from "../src/modes/daemon/daemon-worker-protocol.js";
import { createDeferred } from "./suite/scheduling.js";

const prompt = { type: "prompt", activeSessionId: "active", message: "continue" } as const;
const unavailable = failure(undefined, "prompt", "Session worker is disconnected", { code: "worker_unavailable" });

interface TestWorker {
	descriptor: { workerId: string; lifecycle: DaemonWorkerLifecycle; stopRequestedAt?: string };
	client?: Pick<DaemonClient, "request">;
	intentionalStop: boolean;
	transcriptCaches: Map<string, never>;
}

interface SupervisorHarness {
	shuttingDown: boolean;
	handleWorkerClose(worker: TestWorker, client: Pick<DaemonClient, "request">, error: Error): Promise<void>;
	forwardToWorker(worker: TestWorker, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
}

function createSupervisor(worker: TestWorker, assertRecoveryAllowed = async () => {}): SupervisorHarness {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		shuttingDown: false,
		workers: new Map([[worker.descriptor.workerId, worker]]),
		sessionInputPauses: new Map(),
		assertRecoveryAllowed,
		persistWorker: vi.fn(),
		syncAgentPeers: vi.fn(async () => {}),
		recoverWorker: vi.fn(async () => {}),
	}) as SupervisorHarness;
}

function createWorker(lifecycle: DaemonWorkerLifecycle = "ready"): TestWorker {
	return {
		descriptor: { workerId: "worker", lifecycle },
		intentionalStop: false,
		transcriptCaches: new Map<string, never>(),
	};
}

afterEach(() => vi.useRealTimers());

describe("update restoration during worker recovery", () => {
	it("resumes exactly once after a ready worker disconnects while recovery admission is pending", async () => {
		vi.useFakeTimers();
		const recoveryAdmission = createDeferred();
		const oldClient = { request: vi.fn<DaemonClient["request"]>() };
		const worker = createWorker();
		worker.client = oldClient;
		const supervisor = createSupervisor(worker, () => recoveryAdmission.promise);
		const closing = supervisor.handleWorkerClose(worker, oldClient, new Error("lost worker connection"));
		expect(worker.client).toBeUndefined();
		expect(worker.descriptor.lifecycle).toBe("ready");
		let commandId = 0;
		const request = vi.fn<DaemonClient["request"]>((command, timeoutMs) =>
			supervisor.forwardToWorker(worker, { ...command, id: `restore_${++commandId}` }, timeoutMs),
		);
		const resumed = requestUpdateRestore({ request }, prompt, 1000);
		await vi.advanceTimersByTimeAsync(100);
		expect(oldClient.request).not.toHaveBeenCalled();
		recoveryAdmission.resolve();
		await closing;
		expect(worker.descriptor.lifecycle).toBe("recovering");
		await vi.advanceTimersByTimeAsync(100);
		const recoveredClient = {
			request: vi.fn<DaemonClient["request"]>().mockResolvedValue(success("worker_1", "prompt")),
		};
		worker.client = recoveredClient;
		worker.descriptor.lifecycle = "ready";
		await vi.advanceTimersByTimeAsync(100);
		await expect(resumed).resolves.toMatchObject({ success: true, id: "restore_4" });
		expect(recoveredClient.request).toHaveBeenCalledExactlyOnceWith(prompt, 700);
	});

	it.each(["starting", "recovering"] as const)(
		"does not dispatch to a %s worker with a connected client",
		async (lifecycle) => {
			const worker = createWorker(lifecycle);
			worker.client = { request: vi.fn<DaemonClient["request"]>() };
			await expect(createSupervisor(worker).forwardToWorker(worker, prompt)).resolves.toMatchObject({
				success: false,
				errorInfo: { code: "worker_unavailable" },
			});
			expect(worker.client.request).not.toHaveBeenCalled();
		},
	);

	it.each(["failed", "shutdown", "intentional-stop", "stop-requested"])(
		"does not mark %s as retryable",
		async (state) => {
			const worker = createWorker(state === "failed" ? "failed" : "ready");
			worker.intentionalStop = state === "intentional-stop";
			if (state === "stop-requested") worker.descriptor.stopRequestedAt = new Date().toISOString();
			const supervisor = createSupervisor(worker);
			supervisor.shuttingDown = state === "shutdown";
			await expect(supervisor.forwardToWorker(worker, prompt)).rejects.toThrow("Session worker is");
		},
	);

	it("does not replay a request that throws after worker dispatch", async () => {
		const worker = createWorker();
		worker.client = { request: vi.fn<DaemonClient["request"]>().mockRejectedValue(new Error("worker disconnected")) };
		const supervisor = createSupervisor(worker);
		const request = vi.fn<DaemonClient["request"]>((command) => supervisor.forwardToWorker(worker, command));
		await expect(requestUpdateRestore({ request }, prompt, 1000)).rejects.toThrow("worker disconnected");
		expect(worker.client.request).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledOnce();
	});

	it.each([
		failure(undefined, "prompt", "Session worker is ready"),
		failure(undefined, "prompt", "uncertain", {
			code: "command_result_uncertain",
			clientId: "client",
			commandId: "cmd",
		}),
	])("does not retry an unclassified or uncertain rejection", async (response) => {
		const request = vi.fn<DaemonClient["request"]>().mockResolvedValue(response);
		await expect(requestUpdateRestore({ request }, prompt, 1000)).resolves.toBe(response);
		expect(request).toHaveBeenCalledOnce();
	});

	it("bounds repeated pre-dispatch rejections by the original command deadline", async () => {
		vi.useFakeTimers();
		const request = vi.fn<DaemonClient["request"]>().mockResolvedValue(unavailable);
		const resumed = requestUpdateRestore({ request }, prompt, 250);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(resumed).resolves.toBe(unavailable);
		expect(request.mock.calls.map((call) => call[1])).toEqual([250, 150, 50]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not issue a retry when scheduling resumes after the deadline", async () => {
		vi.useFakeTimers();
		const request = vi.fn<DaemonClient["request"]>().mockResolvedValue(unavailable);
		const resumed = requestUpdateRestore({ request }, prompt, 250);
		await vi.advanceTimersByTimeAsync(0);
		vi.setSystemTime(Date.now() + 500);
		await vi.advanceTimersByTimeAsync(100);
		await expect(resumed).resolves.toBe(unavailable);
		expect(request).toHaveBeenCalledOnce();
	});
});
