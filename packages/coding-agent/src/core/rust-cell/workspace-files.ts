import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { cp } from "node:fs/promises";
import type { ProvisioningContext } from "./provisioning.js";

/** Drain the current filesystem call before a caller can remove its staging tree. */
export async function copyWorkspacePath(
	source: string,
	destination: string,
	context: ProvisioningContext,
	filter?: (path: string) => boolean,
): Promise<void> {
	context.check();
	await cp(source, destination, {
		recursive: true,
		preserveTimestamps: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
		filter: (path) => {
			context.check();
			return filter?.(path) ?? true;
		},
	});
	context.check();
}

export async function hashWorkspaceFile(
	path: string,
	context: { signal?: AbortSignal; check(): void },
): Promise<string> {
	context.check();
	const hash = createHash("sha256");
	const stream = createReadStream(path, { signal: context.signal });
	const closed = new Promise<void>((resolve) => stream.once("close", resolve));
	try {
		for await (const chunk of stream) {
			context.check();
			hash.update(chunk);
		}
	} catch (error) {
		context.check();
		throw error;
	} finally {
		// An aborted iterator can reject before the underlying file has closed.
		stream.destroy();
		await closed;
	}
	context.check();
	return hash.digest("hex");
}
