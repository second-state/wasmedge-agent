import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const root = process.cwd();
const packageDir = join(root, "packages", "coding-agent");
const preparedTemplate = join(packageDir, "dist", "wasmedge-agent-runtime", "template");
const buildScript = readFileSync(join(root, "scripts", "build-binaries.sh"), "utf8");
const ciWorkflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const releaseWorkflow = readFileSync(join(root, ".github", "workflows", "build-binaries.yml"), "utf8");
const failures = [];

check(existsSync(join(preparedTemplate, "Cargo.toml")), "prepared dist template is missing Cargo.toml; run npm run build");
check(!existsSync(join(preparedTemplate, "target")), "prepared dist template includes target/");
check(!existsSync(join(preparedTemplate, "vendor")), "prepared dist template includes vendor/");
check(
	buildScript.includes('cp -r dist/wasmedge-agent-runtime "binaries/$platform/"'),
	"build-binaries.sh does not copy the prepared runtime sidecar into each platform directory",
);
check(ciWorkflow.includes("oven-sh/setup-bun@"), "CI does not install Bun before running the compiled-binary smoke");
check(releaseWorkflow.includes("oven-sh/setup-bun@"), "the release workflow does not install Bun before its check step");

const bun = findOnPath(process.platform === "win32" ? "bun.exe" : "bun");
if (bun) {
	smokeCompiledBinary(bun);
} else {
	console.log("Standalone binary smoke skipped: bun is not available on PATH.");
}

if (failures.length > 0) {
	console.error(["Standalone binary template check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}
console.log("Standalone binary template check passed.");

function check(condition, message) {
	if (!condition) failures.push(message);
}

function findOnPath(name) {
	for (const entry of (process.env.PATH || "").split(delimiter)) {
		const candidate = join(entry, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function smokeCompiledBinary(bun) {
	const releaseDir = mkdtempSync(join(tmpdir(), "prime-agent-binary-template-"));
	const homeDir = join(releaseDir, "home");
	const executable = join(releaseDir, process.platform === "win32" ? "prime-agent.exe" : "prime-agent");
	const template = join(releaseDir, "wasmedge-agent-runtime", "template");

	try {
		mkdirSync(homeDir, { recursive: true });
		const entrypoint = join(packageDir, "dist", "bun", "cli.js");
		const compile = spawnSync(bun, ["build", "--compile", entrypoint, "--outfile", executable], {
			encoding: "utf8",
			timeout: 120000,
		});
		if (compile.status !== 0) {
			failures.push(formatProcessFailure("Bun compile", compile));
			return;
		}
		const windowsProbe = spawnSync(
			bun,
			["build", "--compile", "--target=bun-windows-x64", entrypoint, "--outfile", join(releaseDir, "prime-agent.exe")],
			{ encoding: "utf8", timeout: 120000 },
		);
		if (windowsProbe.status !== 0) {
			failures.push(formatProcessFailure("Bun Windows cross-compile", windowsProbe));
			return;
		}

		cpSync(join(packageDir, "package.json"), join(releaseDir, "package.json"));
		mkdirSync(dirname(template), { recursive: true });
		cpSync(preparedTemplate, template, { recursive: true });
		const doctor = spawnSync(executable, ["doctor", "--json"], {
			encoding: "utf8",
			env: { ...process.env, HOME: homeDir },
			timeout: 60000,
		});
		if (doctor.status !== 0) {
			failures.push(formatProcessFailure("compiled binary doctor", doctor));
			return;
		}

		let report;
		try {
			report = JSON.parse(doctor.stdout);
		} catch (error) {
			failures.push(
				`compiled binary doctor returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\nstdout:\n${doctor.stdout}\nstderr:\n${doctor.stderr}`,
			);
			return;
		}
		const workspaceTemplate = report.runtime?.find((runtimeCheck) => runtimeCheck.name === "workspace template");
		check(workspaceTemplate?.ok === true, "compiled binary doctor did not pass the workspace template check");
		check(
			typeof workspaceTemplate?.detail === "string" &&
				realpathSync(workspaceTemplate.detail) === realpathSync(template),
			`compiled binary doctor resolved the wrong workspace template: ${workspaceTemplate?.detail ?? "missing"}`,
		);
	} finally {
		rmSync(releaseDir, { recursive: true, force: true });
	}
}

function formatProcessFailure(label, result) {
	return `${label} failed (status=${result.status ?? "none"}, signal=${result.signal ?? "none"}, error=${result.error?.message ?? "none"})\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`;
}
