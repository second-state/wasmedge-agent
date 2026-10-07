import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

export interface ProcessLimits {
	/** Aggregate cgroup memory, including charged file cache; MiB, not virtual address space. */
	memoryMaxMb?: number | null;
	/** CPU bandwidth relative to one core; 100 permits one core, 200 permits two. */
	cpuQuotaPercent?: number | null;
	/** Maximum processes and threads in one invocation's cgroup. */
	tasksMax?: number | null;
}

const MAXIMUMS = { memoryMaxMb: 0xffff_ffff, cpuQuotaPercent: 100_000, tasksMax: 4_194_304 } as const;

export function normalizeProcessLimits(
	value: unknown,
	platform = process.platform,
): Readonly<ProcessLimits> | undefined {
	if (value == null) return undefined;
	if (typeof value !== "object" || Array.isArray(value))
		throw new Error("rustCell.processLimits must be an object or null");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !Object.hasOwn(MAXIMUMS, key)))
		throw new Error("rustCell.processLimits supports only memoryMaxMb, cpuQuotaPercent and tasksMax");
	const limits: ProcessLimits = {};
	for (const key of Object.keys(MAXIMUMS) as (keyof ProcessLimits)[]) {
		const number = input[key];
		if (number == null) continue;
		if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > MAXIMUMS[key])
			throw new Error(`rustCell.processLimits.${key} must be an integer between 1 and ${MAXIMUMS[key]}, or null`);
		limits[key] = number;
	}
	if (!Object.keys(limits).length) return undefined;
	if (platform !== "linux") throw new Error("rustCell.processLimits requires Linux with systemd and cgroup v2");
	return Object.freeze(limits);
}

export function runtimeProcessLimits(value: unknown, cargoSandbox: unknown): Readonly<ProcessLimits> | undefined {
	const limits = normalizeProcessLimits(value);
	if (limits && cargoSandbox !== "bubblewrap")
		throw new Error('rustCell.processLimits requires cargoSandbox: "bubblewrap"');
	return limits;
}

// systemd can accept properties even when a controller is unavailable. Check
// the actual scope's kernel controls before any compiler or guest is launched.
const VERIFY_LIMITS = `
fail() { printf 'Process resource limits unavailable: %s\\n' "$1" >&2; exit 125; }
unit=$1
shift
group=
while IFS=: read -r hierarchy controllers path; do
  if [ "$hierarchy" = 0 ]; then group=$path; break; fi
done < /proc/self/cgroup
case "$group" in
  /*/"$unit") ;;
  *) fail 'command did not enter its cgroup v2 scope' ;;
esac
while [ "$1" != -- ]; do
  field=$1
  expected=$2
  shift 2
  actual=
  read -r actual < "/sys/fs/cgroup$group/$field" || fail "$field is not readable"
  [ "$actual" = "$expected" ] || fail "$field is not enforced"
done
shift
exec "$@"
`;

export interface ProcessCommand {
	bin: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

/** Scope execution preserves the caller's cwd, environment and stdio pipes. */
export function resourceLimitedCommand(command: ProcessCommand, value?: ProcessLimits | null): ProcessCommand {
	const limits = normalizeProcessLimits(value);
	if (!limits) return command;
	if (!existsSync("/usr/bin/systemd-run") || !existsSync("/sys/fs/cgroup/cgroup.controllers"))
		throw new Error("Process resource limits require /usr/bin/systemd-run and cgroup v2");
	const unit = `wasmedge-agent-${randomUUID()}.scope`;
	const properties: string[] = [];
	const expected: string[] = [];
	if (limits.memoryMaxMb != null) {
		const bytes = String(limits.memoryMaxMb * 1024 * 1024);
		properties.push(`MemoryMax=${bytes}`, "MemorySwapMax=0", "OOMPolicy=kill");
		expected.push("memory.max", bytes, "memory.swap.max", "0", "memory.oom.group", "1");
	}
	if (limits.cpuQuotaPercent != null) {
		properties.push(`CPUQuota=${limits.cpuQuotaPercent}%`, "CPUQuotaPeriodSec=100ms");
		expected.push("cpu.max", `${limits.cpuQuotaPercent * 1000} 100000`);
	}
	if (limits.tasksMax != null) {
		properties.push(`TasksMax=${limits.tasksMax}`);
		expected.push("pids.max", String(limits.tasksMax));
	}
	const runtimeDir = `/run/user/${process.getuid!()}`;
	return {
		bin: "/usr/bin/systemd-run",
		args: [
			"--user",
			"--scope",
			"--expand-environment=no",
			"--quiet",
			"--collect",
			"--description=wasmedge-agent runtime process",
			`--unit=${unit}`,
			...properties.map((property) => `--property=${property}`),
			"--",
			"/bin/sh",
			"-eu",
			"-c",
			VERIFY_LIMITS,
			"process-limits",
			unit,
			...expected,
			"--",
			command.bin,
			...command.args,
		],
		env: {
			...command.env,
			XDG_RUNTIME_DIR: runtimeDir,
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
		},
	};
}
