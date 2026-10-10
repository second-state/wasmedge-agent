import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../files.js";
import { batchRange, type WorkloadSpec } from "./cases.js";

export function fileHash(path: string): string {
	const hash = createHash("sha256"),
		buffer = Buffer.allocUnsafe(1024 * 1024),
		fd = openSync(path, "r");
	try {
		for (;;) {
			const n = readSync(fd, buffer);
			if (!n) break;
			hash.update(buffer.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

class Writer {
	private readonly fd: number;
	private readonly buffer = Buffer.allocUnsafe(65536);
	private used = 0;
	constructor(path: string) {
		this.fd = openSync(path, "w", 0o600);
	}
	private writeAll(value: Buffer): void {
		let offset = 0;
		while (offset < value.length) offset += writeSync(this.fd, value, offset, value.length - offset);
	}
	bytes(value: Buffer): void {
		if (value.length > this.buffer.length) {
			this.flush();
			this.writeAll(value);
			return;
		}
		if (this.used + value.length > this.buffer.length) this.flush();
		value.copy(this.buffer, this.used);
		this.used += value.length;
	}
	u32(value: number): void {
		if (this.used + 4 > this.buffer.length) this.flush();
		this.buffer.writeUInt32LE(value, this.used);
		this.used += 4;
	}
	flush(): void {
		if (this.used) {
			this.writeAll(this.buffer.subarray(0, this.used));
			this.used = 0;
		}
	}
	close(): void {
		this.flush();
		closeSync(this.fd);
	}
}

export function nextRandom(value: number): number {
	return (value * 1664525 + 1013904223) % 4294967296;
}
export function simulationOracle(seed: number, steps: number, events?: Uint8Array): number[] {
	let q = 0,
		completed = 0,
		expired = 0,
		rejected = 0,
		x = seed;
	for (let i = 0; i < steps; i++) {
		x = nextRandom(x);
		const kind = events ? events[i] : Math.floor(x / 1073741824);
		switch (kind) {
			case 0:
			case 1:
				if (q === 64) rejected++;
				else q++;
				break;
			case 2:
				if (q) {
					q--;
					completed++;
				}
				break;
			case 3:
				if (q) {
					q--;
					expired++;
				}
				break;
			default:
				throw new Error("Invalid simulation event");
		}
	}
	return [q, completed, expired, rejected];
}

export interface EventRecord {
	timestamp: number;
	key: number;
	seq: number;
	amount: number;
	kind: number;
}
// Object state and table-driven admission are independent of the guest's packed state.
export interface EventState {
	open: boolean;
	since: number;
	pending: number;
	seq: number;
	duplicate: number;
	timeout: number;
	invalid: number;
	completed: number;
	cancelled: number;
	total: number;
}
export function emptyEventState(): EventState {
	return {
		open: false,
		since: 0,
		pending: 0,
		seq: -1,
		duplicate: 0,
		timeout: 0,
		invalid: 0,
		completed: 0,
		cancelled: 0,
		total: 0,
	};
}
export function applyEvent(state: EventState, event: EventRecord): void {
	if (event.seq <= state.seq) {
		state.duplicate++;
		return;
	}
	state.seq = event.seq;
	if (state.open && event.timestamp - state.since > 30000) {
		state.timeout++;
		state.open = false;
		state.pending = 0;
	}
	const admitted =
		event.kind === 1
			? !state.open
			: state.open && event.kind >= 2 && event.kind <= 4 && (event.kind !== 2 || event.amount >= 0);
	if (!admitted) {
		state.invalid++;
		return;
	}
	switch (event.kind) {
		case 1:
			state.open = true;
			state.since = event.timestamp;
			state.pending = 0;
			break;
		case 2:
			state.pending += event.amount;
			break;
		case 3:
			state.completed++;
			state.total += state.pending;
			state.pending = 0;
			state.open = false;
			break;
		case 4:
			state.cancelled++;
			state.pending = 0;
			state.open = false;
			break;
	}
}
export function eventSummary(states: EventState[]): number[][] {
	return states.map((s) => [
		Number(s.open),
		s.since,
		s.pending,
		s.seq,
		s.duplicate,
		s.timeout,
		s.invalid,
		s.completed,
		s.cancelled,
		s.total,
	]);
}

export function graphOracle(nodes: number, edges: [number, number][], roots: number[]): Buffer {
	const adjacency: number[][] = Array.from({ length: nodes }, () => []);
	for (const [depender, dependency] of edges) adjacency[dependency].push(depender);
	const width = Math.ceil(nodes / 8),
		output = Buffer.alloc(width * roots.length);
	for (let query = 0; query < roots.length; query++) {
		const seen = new Set<number>(),
			stack = [roots[query]];
		while (stack.length) {
			const node = stack.pop()!;
			if (seen.has(node)) continue;
			seen.add(node);
			for (const child of adjacency[node]) if (!seen.has(child)) stack.push(child);
		}
		for (const node of seen) output[query * width + (node >> 3)] |= 1 << (node & 7);
	}
	return output;
}

export interface FixtureManifest {
	version: 1;
	seed: number;
	inputs: { path: string; bytes: number; sha256: string }[];
	expected: { path: string; bytes: number; sha256: string }[];
}

export function generateFixture(project: string, oracle: string, spec: WorkloadSpec, seed: number): FixtureManifest {
	mkdirSync(project, { recursive: true });
	mkdirSync(oracle, { recursive: true });
	let random = seed >>> 0;
	const rng = () => {
		random = nextRandom(random);
		return random;
	};
	const inputs = ["workload.json"];
	const expected: string[] = [];
	writeJson(join(project, "workload.json"), { ...spec, seed });
	if (spec.kind === "graph") {
		const edges: [number, number][] = [],
			active = Math.floor(spec.nodes * 0.9);
		for (let i = 0; i < spec.edges; i++) {
			const dependency = rng() % active;
			const depender = i % 4 === 0 ? (dependency + 1) % active : rng() % active;
			edges.push([depender, dependency]);
		}
		const roots = Array.from({ length: spec.queries }, (_, i) => (i % 16 === 0 ? spec.nodes - 1 : rng() % active));
		const file = new Writer(join(project, "graph.bin"));
		for (const n of [spec.nodes, edges.length, roots.length]) file.u32(n);
		for (const edge of edges) for (const n of edge) file.u32(n);
		for (const n of roots) file.u32(n);
		file.close();
		inputs.push("graph.bin");
		for (let batch = 0; batch < spec.batches; batch++) {
			const [lo, hi] = batchRange(roots.length, spec.batches, batch),
				path = `result-${batch}.bin`;
			writeFileSync(join(oracle, path), graphOracle(spec.nodes, edges, roots.slice(lo, hi)));
			expected.push(path);
		}
	} else if (spec.kind === "events") {
		const states = Array.from({ length: spec.keys }, emptyEventState),
			sequences = new Uint32Array(spec.keys);
		let timestamp = 0;
		for (let batch = 0; batch < spec.batches; batch++) {
			const path = `events-${batch}.${spec.format === "binary" ? "bin" : "jsonl"}`,
				file = new Writer(join(project, path));
			const [lo, hi] = batchRange(spec.events, spec.batches, batch);
			for (let i = lo; i < hi; i++) {
				const key = rng() % spec.keys;
				timestamp += i % 997 === 0 ? 30001 : 1;
				sequences[key]++;
				const event: EventRecord = {
					timestamp,
					key,
					seq: i % 31 === 0 && sequences[key] > 1 ? sequences[key] - 1 : sequences[key],
					amount: i % 29 === 0 ? -1 : rng() % 1000,
					kind: i % 113 === 0 ? 7 : i % 7 === 0 ? 1 + (rng() % 4) : 1 + ((sequences[key] - 1) % 4),
				};
				applyEvent(states[key], event);
				if (spec.format === "binary") {
					const bytes = Buffer.alloc(32);
					bytes.writeBigUInt64LE(BigInt(timestamp));
					bytes.writeUInt32LE(key, 8);
					bytes.writeUInt32LE(event.seq, 12);
					bytes.writeBigInt64LE(BigInt(event.amount), 16);
					bytes[24] = event.kind;
					file.bytes(bytes);
				} else
					file.bytes(Buffer.from(`${JSON.stringify([timestamp, key, event.seq, event.amount, event.kind])}\n`));
			}
			file.close();
			inputs.push(path);
			const output = `result-${batch}.json`;
			writeJson(join(oracle, output), eventSummary(states));
			expected.push(output);
		}
	} else {
		for (let batch = 0; batch < spec.batches; batch++) {
			const [lo, hi] = batchRange(spec.trajectories, spec.batches, batch);
			const path = `seeds-${batch}.bin`,
				seeds = new Writer(join(project, path)),
				out = `result-${batch}.bin`,
				output = new Writer(join(oracle, out));
			const eventPath = `simulation-events-${batch}.bin`,
				events = spec.simulationMode === "events" ? new Writer(join(project, eventPath)) : undefined;
			for (let i = lo; i < hi; i++) {
				const initial = rng();
				seeds.u32(initial);
				let choices: Uint8Array | undefined;
				if (events) {
					choices = new Uint8Array(spec.steps);
					let x = initial;
					for (let step = 0; step < spec.steps; step++) {
						x = nextRandom(x);
						choices[step] = Math.floor(x / 1073741824);
					}
					events.bytes(Buffer.from(choices));
				}
				for (const n of simulationOracle(initial, spec.steps, choices)) output.u32(n);
			}
			seeds.close();
			output.close();
			events?.close();
			inputs.push(path);
			if (events) inputs.push(eventPath);
			expected.push(out);
		}
	}
	const identity = (directory: string, path: string) => ({
		path,
		bytes: statSync(join(directory, path)).size,
		sha256: fileHash(join(directory, path)),
	});
	const manifest: FixtureManifest = {
		version: 1,
		seed,
		inputs: inputs.map((p) => identity(project, p)),
		expected: expected.map((p) => identity(oracle, p)),
	};
	writeJson(join(oracle, "manifest.json"), manifest);
	return manifest;
}

export function verifyWorkload(
	project: string,
	oracle: string,
	spec: WorkloadSpec,
	batch: number,
): { pass: boolean; reason: string; expectedHash: string; actualHash: string | null } {
	const manifest = readJson(join(oracle, "manifest.json")) as FixtureManifest;
	const output = manifest.expected[batch];
	if (!output || output.path !== `result-${batch}.${spec.kind === "events" ? "json" : "bin"}`)
		throw new Error("Invalid oracle manifest");
	const expectedHash = fileHash(join(oracle, output.path));
	if (expectedHash !== output.sha256) throw new Error("Oracle content changed");
	try {
		const path = join(project, output.path),
			actualHash = fileHash(path);
		const pass =
			spec.kind === "events"
				? JSON.stringify(readJson(path)) === JSON.stringify(readJson(join(oracle, output.path)))
				: statSync(path).size === output.bytes && actualHash === expectedHash;
		return { pass, reason: pass ? "exact-output-match" : "output-mismatch", expectedHash, actualHash };
	} catch {
		return { pass: false, reason: "missing-or-invalid-output", expectedHash, actualHash: null };
	}
}

export function verifyFixtureInputs(project: string, oracle: string): boolean {
	const manifest = readJson(join(oracle, "manifest.json")) as FixtureManifest;
	try {
		return manifest.inputs.every(
			(input) =>
				statSync(join(project, input.path)).size === input.bytes &&
				fileHash(join(project, input.path)) === input.sha256,
		);
	} catch {
		return false;
	}
}
