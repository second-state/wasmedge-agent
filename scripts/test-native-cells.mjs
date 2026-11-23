// Exercise the installed public launcher, a scripted native provider and real WASI guests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "wasmedge-native-"));
const cwd = join(temp, "project");
mkdirSync(cwd);
const launcher = join(root, "packages/coding-agent/dist/native-launch.js");
let session;
function rust(body, lib) {
	return {
		content: [
			{
				type: "toolCall",
				name: "rust",
				arguments: {
					code: `use agent_lib::prelude::*; fn main() -> Result<()> { ${body}; Ok(()) }`,
					...(lib ? { lib } : {}),
				},
			},
		],
	};
}
function run(args, script) {
	const run = spawnSync(process.execPath, [launcher, "--offline", ...args], {
		cwd,
		encoding: "utf8",
		timeout: 6 * 60_000,
		maxBuffer: 16 * 1024 * 1024,
		env: {
			...process.env,
			DO_NOT_TRACK: "1",
			WASMEDGE_AGENT_CODING_AGENT_DIR: join(temp, "agent"),
			WASMEDGE_AGENT_SESSION_DIR: join(temp, "sessions"),
			WASMEDGE_AGENT_TEMPLATE_DIR: join(root, "wasmedge-agent-runtime/template"),
			WASMEDGE_AGENT_FAUX_SCRIPT: JSON.stringify(script),
		},
	});
	assert.ifError(run.error);
	assert.equal(run.status, 0, run.stderr);
	return run.stdout;
}
function cells(responses, children, flags = []) {
	const transcript = run(
		[...(session ? ["--resume", session] : []), ...flags, "--mode", "json", "-p", "Run the fixture"],
		{ responses, children, repeatLastResponse: true },
	);
	return transcript
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((event) => event.type === "tool_execution_end")
		.map((event) => ({
			tool: event.toolName,
			text: event.result.content.map((block) => block.text ?? "").join(""),
			details: event.result.details,
		}));
}
const helper = "src/helpers/answer.rs";
function addSkill(name, expected) {
	const dir = join(temp, "agent", "skills", name);
	const crate = name.replaceAll("-", "_");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Native refinement fixture\n---\nRun the crate.\n`,
	);
	writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "${crate}"\nversion = "0.1.0"\nedition = "2021"\n`);
	writeFileSync(
		join(dir, "src/lib.rs"),
		`pub fn run() -> i32 { 7 }\n#[test] fn verifies() { assert_eq!(run(), ${expected}); }\n`,
	);
	return {
		action: "create",
		kind: "skill",
		id: name,
		title: name,
		content: "Return the fixture result",
		arguments: {},
		reference: { type: "rust", use: `agent_lib::skills::${crate}`, callable: "run" },
	};
}

try {
	mkdirSync(join(temp, "agent"));
	writeFileSync(join(temp, "agent", "settings.json"), JSON.stringify({ rlmMaxDepth: 3 }));
	const first = cells([
		rust(
			'rlm::state::set("n", &41)?; println!("saved={} depth={}/{}", helpers::answer::next(40), std::env::var("RLM_DEPTH")?, std::env::var("RLM_MAX_DEPTH")?)',
			[{ path: helper, content: "pub fn next(n:i64)->i64 { n+1 }" }],
		),
		rust('println!("bad")', [{ path: helper, content: "pub fn next(" }]),
		"first turn complete",
	]);
	assert.equal(first.length, 2);
	assert.match(first[0].text, /saved=41 depth=0\/3/);
	assert.match(first[1].text, /error|diagnostic/i);
	const files = readdirSync(join(temp, "sessions"), { recursive: true });
	const persisted = files.find((f) => f.endsWith(".jsonl") && !f.includes("artifacts"));
	assert.ok(persisted, "session file was persisted");
	session = join(temp, "sessions", persisted);
	const second = cells(
		[
			rust(
				'let n: i64 = rlm::state::get("n")?.unwrap(); let info=rlm::host_request("model.info",json!({}))?; println!("native={} resumed={}",info["id"],helpers::answer::next(n))',
			),
			{ content: [{ type: "toolCall", name: "bash", arguments: { command: "echo native-host-shell" } }] },
			rust('let h=rlm::spawn_named("check inherited library","child")?; println!("child={}",h.name)'),
			"parent complete",
		],
		{
			child: {
				responses: [
					rust(
						'std::fs::write("/workspace/child-result",format!("inherited={} depth={}/{}",helpers::answer::next(6), std::env::var("RLM_DEPTH")?, std::env::var("RLM_MAX_DEPTH")?))?',
					),
					"child complete",
				],
			},
		},
	);
	assert.deepEqual(
		second.map((e) => e.tool),
		["rust", "bash", "rust"],
	);
	assert.match(second[0].text, /native="faux-1" resumed=42/);
	assert.match(second[1].text, /native-host-shell/);
	assert.match(second[2].text, /child=child/);
	assert.equal(readFileSync(join(cwd, "child-result"), "utf8"), "inherited=7 depth=1/3");
	const edits = [addSkill("passing-native", 7), addSkill("failing-native", 8)];
	const refinement = run(["--resume", session, "--mode", "json", "-p", "/refine"], {
		responses: [JSON.stringify({ summary: "Register tested skills", edits })],
		repeatLastResponse: true,
	});
	const result = refinement
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.find((event) => event.type === "refine_complete")?.result;
	assert.ok(result, refinement.slice(-2500));
	assert.deepEqual(
		result.appliedEdits.map((edit) => [edit.id, edit.applied]),
		[
			["passing-native", true],
			["failing-native", false],
		],
		JSON.stringify(result.appliedEdits),
	);
	assert.match(result.appliedEdits[1].error, /test.*fail|assertion/i);
	const state = JSON.parse(readFileSync(result.harnessStatePath, "utf8"));
	assert.ok(state.entries.skill["passing-native"]);
	assert.equal(state.entries.skill["failing-native"], undefined);
	cells([rust('std::fs::write("/workspace/forbidden", "unexpected")?'), "complete"], undefined, ["--tools", "bash"]);
	assert.ok(!existsSync(join(cwd, "forbidden")), "restricted tool set executed a Rust cell");
	console.log(
		"Native host passed WasmEdge execution, library rollback, session reopen, host requests, bash, child inheritance and sandboxed skill refinement.",
	);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
