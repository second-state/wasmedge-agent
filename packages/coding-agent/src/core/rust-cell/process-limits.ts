import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ProcessResourceGroup } from "./process-group.js";

export interface ProcessLimits {
	/** Aggregate cgroup memory, including charged file cache; MiB, not virtual address space. */
	memoryMaxMb?: number | null;
	/** CPU bandwidth relative to one core; 100 permits one core, 200 permits two. */
	cpuQuotaPercent?: number | null;
	/** Maximum processes and threads in the selected cgroup budget. */
	tasksMax?: number | null;
}

const MAXIMUMS = { memoryMaxMb: 0xffff_ffff, cpuQuotaPercent: 100_000, tasksMax: 4_194_304 } as const;

export function normalizeProcessLimits(
	value: unknown,
	platform = process.platform,
	setting = "rustCell.processLimits",
): Readonly<ProcessLimits> | undefined {
	if (value == null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${setting} must be an object or null`);
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !Object.hasOwn(MAXIMUMS, key)))
		throw new Error(`${setting} supports only memoryMaxMb, cpuQuotaPercent and tasksMax`);
	const limits: ProcessLimits = {};
	for (const key of Object.keys(MAXIMUMS) as (keyof ProcessLimits)[]) {
		const number = input[key];
		if (number == null) continue;
		if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > MAXIMUMS[key])
			throw new Error(`${setting}.${key} must be an integer between 1 and ${MAXIMUMS[key]}, or null`);
		limits[key] = number;
	}
	if (!Object.keys(limits).length) return undefined;
	if (platform !== "linux") throw new Error(`${setting} requires Linux with systemd and cgroup v2`);
	return Object.freeze(limits);
}

export function runtimeProcessLimits(
	value: unknown,
	cargoSandbox: unknown,
	setting = "rustCell.processLimits",
): Readonly<ProcessLimits> | undefined {
	const limits = normalizeProcessLimits(value, process.platform, setting);
	if (limits && cargoSandbox !== "bubblewrap") throw new Error(`${setting} requires cargoSandbox: "bubblewrap"`);
	return limits;
}

// systemd can accept properties even when a controller is unavailable. Check
// the actual scope's kernel controls before any compiler or guest is launched.
const VERIFY_LIMITS = `
fail() { printf 'Process resource limits unavailable: %s\\n' "$1" >&2; exit 125; }
unit=$1
slice=$2
shift 2
group=
while IFS=: read -r hierarchy controllers path; do
  if [ "$hierarchy" = 0 ]; then group=$path; break; fi
done < /proc/self/cgroup
case "$group" in
  /*/"$unit") ;;
  *) fail 'command did not enter its cgroup v2 scope' ;;
esac
if [ "$slice" != - ]; then
  parent=\${group%/*}
  case "$parent" in
    /*/"$slice") ;;
    *) fail 'command did not enter its agent tree slice' ;;
  esac
fi
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

export function processLimitControls(
	limits: ProcessLimits,
	scope: boolean,
): { properties: string[]; expected: string[] } {
	const properties: string[] = [];
	const expected: string[] = [];
	if (limits.memoryMaxMb != null) {
		const bytes = String(limits.memoryMaxMb * 1024 * 1024);
		properties.push(`MemoryMax=${bytes}`, "MemorySwapMax=0");
		expected.push("memory.max", bytes, "memory.swap.max", "0");
		if (scope) {
			properties.push("OOMPolicy=kill");
			expected.push("memory.oom.group", "1");
		}
	}
	if (limits.cpuQuotaPercent != null) {
		properties.push(`CPUQuota=${limits.cpuQuotaPercent}%`, "CPUQuotaPeriodSec=100ms");
		expected.push("cpu.max", `${limits.cpuQuotaPercent * 1000} 100000`);
	}
	if (limits.tasksMax != null) {
		properties.push(`TasksMax=${limits.tasksMax}`);
		expected.push("pids.max", String(limits.tasksMax));
	}
	return { properties, expected };
}

export function systemdUserEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const runtimeDir = `/run/user/${process.getuid!()}`;
	return { ...env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` };
}

/** Scope execution preserves the caller's cwd, environment and stdio pipes. */
export function resourceLimitedCommand(
	command: ProcessCommand,
	value?: ProcessLimits | null,
	group?: ProcessResourceGroup | null,
): ProcessCommand {
	const limits = normalizeProcessLimits(value);
	if (!limits && !group) return command;
	if (!existsSync("/usr/bin/systemd-run") || !existsSync("/sys/fs/cgroup/cgroup.controllers"))
		throw new Error("Process resource limits require /usr/bin/systemd-run and cgroup v2");
	group?.ensure();
	const unit = `wasmedge-agent-${randomUUID()}.scope`;
	const { properties, expected } = processLimitControls(limits ?? {}, true);
	if (group) {
		const tree = processLimitControls(group.limits, false);
		for (let i = 0; i < tree.expected.length; i += 2) expected.push(`../${tree.expected[i]}`, tree.expected[i + 1]);
		if (group.limits.memoryMaxMb != null && limits?.memoryMaxMb == null) {
			properties.push("OOMPolicy=kill");
			expected.push("memory.oom.group", "1");
		}
	}
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
			...(group ? [`--slice=${group.unit}`] : []),
			...properties.map((property) => `--property=${property}`),
			"--",
			"/bin/sh",
			"-eu",
			"-c",
			VERIFY_LIMITS,
			"process-limits",
			unit,
			group?.unit ?? "-",
			...expected,
			"--",
			command.bin,
			...command.args,
		],
		env: systemdUserEnvironment(command.env),
	};
}
