import type { DaemonClient } from "../modes/daemon/daemon-client.js";
import type { DaemonResponse } from "../modes/daemon/daemon-protocol.js";

type RestoreCommand = Extract<
	Parameters<DaemonClient["request"]>[0],
	{ type: "append_custom_message" | "restore_next_turn" | "restore_actions" | "prompt" | "resume_queue" }
>;

export async function requestUpdateRestore(
	client: Pick<DaemonClient, "request">,
	command: RestoreCommand,
	timeoutMs: number,
): Promise<DaemonResponse> {
	const deadline = Date.now() + timeoutMs;
	let remaining = timeoutMs;
	// Only a pre-dispatch rejection is safe to retry with a fresh command ID.
	// Transport failures and timeouts may have executed and are never replayed here.
	while (true) {
		const response = await client.request(command, remaining);
		if (response.success || response.errorInfo?.code !== "worker_unavailable") return response;
		if (deadline - Date.now() <= 100) return response;
		await new Promise((resolve) => setTimeout(resolve, 100));
		remaining = deadline - Date.now();
		if (remaining <= 0) return response;
	}
}
