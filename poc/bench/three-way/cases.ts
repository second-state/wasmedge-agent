import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { record } from "./files.js";
import type { Case, RuntimeStep, VariantId } from "./types.js";

const py = (code: string, marker = "BENCH_OK"): RuntimeStep => ({
	op: "execute",
	code,
	expectedStatus: ["ok"],
	stdoutIncludes: marker,
});
const rs = (code: string, marker = "BENCH_OK"): RuntimeStep =>
	py(`use agent_lib::prelude::*; fn main() -> Result<()> { ${code} Ok(()) }`, marker);
const phasePy = (name: string, body: string) =>
	`import time, json\n_bench_start = time.perf_counter_ns()\n${body}\nprint('BENCH_PHASE:' + json.dumps({'name':'${name}', 'durationMs':(time.perf_counter_ns()-_bench_start)/1e6}))\nprint('BENCH_OK')`;
const phaseRs = (name: string, body: string) =>
	`let start = std::time::Instant::now(); ${body} println!("BENCH_PHASE:{}", serde_json::json!({"name":"${name}","durationMs":start.elapsed().as_secs_f64()*1000.0})); println!("BENCH_OK");`;
const noop = { python: py("print('BENCH_OK')"), wasm: rs('println!("BENCH_OK");') };
const both = (python: RuntimeStep[], wasm: RuntimeStep[]): Partial<Record<VariantId, RuntimeStep[]>> => ({
	"prime-ts": python,
	"prime-rust": python,
	wasmedge: wasm,
	"wasmedge-aot": wasm,
});

export function cases(root: string, suite: string): Case[] {
	const result: Case[] = [];
	function runtime(
		id: string,
		python: RuntimeStep[],
		wasm: RuntimeStep[],
		fixture: Record<string, string> = {},
		parameters: Record<string, unknown> = {},
	) {
		result.push({
			id,
			lane: "runtime",
			scale: "small",
			cacheCondition: "template-warm-new-workspace",
			turns: [],
			taskBudgetMs: 300000,
			fixture,
			tools: "native",
			check: { kind: "marker", value: "BENCH_OK" },
			parameters,
			runtime: both(python, wasm),
		});
	}
	result.push({
		id: "H01-startup",
		lane: "host",
		scale: "empty-session",
		cacheCondition: "new-daemon",
		turns: ["Reply exactly BENCH_OK."],
		taskBudgetMs: 60000,
		fixture: {},
		tools: "none",
		check: { kind: "marker", value: "BENCH_OK" },
		parameters: {},
		replay: Object.fromEntries(
			["prime-ts", "prime-rust", "wasmedge", "wasmedge-aot"].map((id) => [
				id,
				[{ text: "BENCH_OK", chunkBytes: 16 }],
			]),
		),
	});
	result.push({
		id: "H02-stream",
		lane: "host",
		scale: "context8k-output64k-chunk64",
		cacheCondition: "new-daemon",
		turns: [`${"context ".repeat(1024)}\nReply with the supplied output.`],
		taskBudgetMs: 90000,
		fixture: {},
		tools: "none",
		check: { kind: "marker", value: "BENCH_OK" },
		parameters: { contextBytes: 8192, outputBytes: 65536, chunkCodePoints: 64, delayMs: 0 },
		replay: Object.fromEntries(
			["prime-ts", "prime-rust", "wasmedge", "wasmedge-aot"].map((id) => [
				id,
				[{ text: `${"x".repeat(65527)} BENCH_OK`, chunkBytes: 64 }],
			]),
		),
	});
	result.push({
		id: "H03-dispatch",
		lane: "host",
		scale: "10-native-commands",
		cacheCondition: "new-daemon",
		turns: ["Execute the fixed commands, then reply BENCH_OK."],
		taskBudgetMs: 120000,
		fixture: {},
		tools: "bash",
		check: { kind: "marker", value: "BENCH_OK" },
		parameters: { commands: 10 },
		replay: Object.fromEntries(
			["prime-ts", "prime-rust", "wasmedge", "wasmedge-aot"].map((id) => [
				id,
				[
					...Array.from({ length: 10 }, () => ({
						tool: { name: "bash", arguments: { command: "printf BENCH_COMMAND_OK" } },
						chunkBytes: 64,
					})),
					{ text: "BENCH_OK" },
				],
			]),
		),
	});
	runtime("R01-noop", [noop.python, noop.python], [noop.wasm, noop.wasm]);
	const helperPy = py("def bench_answer():\n    return 42\nprint('BENCH_OK')");
	const helperRs = {
		...rs('assert_eq!(agent_lib::helpers::bench::answer(),42); println!("BENCH_OK");'),
		lib: [{ path: "src/helpers/bench.rs", content: "pub fn answer() -> u32 {42}" }],
	};
	runtime(
		"R02-source-cache",
		[noop.python, noop.python, py("x=1\nprint('BENCH_OK')"), helperPy],
		[
			noop.wasm,
			noop.wasm,
			rs('let x=1; assert_eq!(x,1); println!("BENCH_OK");'),
			helperRs,
			{ op: "clear-target", expectedStatus: ["ok"] },
			noop.wasm,
		],
		{},
		{ coldScope: "owned-workspace-target-only", pythonColdTarget: "not_applicable" },
	);
	let checksum = 0;
	for (let i = 0; i < 100000; i++) checksum = (Math.imul(checksum, 1664525) + i + 1013904223) >>> 0;
	runtime(
		"R03-cpu",
		[
			py(
				phasePy(
					"guest.compute",
					`x=0\nfor i in range(100000):\n    x=(x*1664525+i+1013904223)&0xffffffff\nassert x==${checksum}`,
				),
			),
		],
		[
			rs(
				phaseRs(
					"guest.compute",
					`let mut x=0u32; for i in 0..100000u32 { x=x.wrapping_mul(1664525).wrapping_add(i).wrapping_add(1013904223); } assert_eq!(x,${checksum}); std::hint::black_box(x);`,
				),
			),
		],
		{},
		{ iterations: 100000, checksum, arithmetic: "uint32-wrapping" },
	);
	const data = `${Array.from({ length: 10000 }, (_, i) => JSON.stringify({ id: i, value: i % 17 })).join("\n")}\n`;
	const csv = `id,multiplier\n${Array.from({ length: 10000 }, (_, i) => `${i},2`).join("\n")}\n`;
	const sum = Array.from({ length: 10000 }, (_, i) => (i % 17) * 2).reduce((a, b) => a + b, 0);
	runtime(
		"R04-data-join",
		[
			py(phasePy("guest.input.read", "text=open('rows.jsonl').read(); csv_text=open('rows.csv').read()")),
			py(
				phasePy(
					"guest.input.parse_join",
					`rows=[json.loads(line) for line in text.splitlines()]\nindex={int(line.split(',')[0]):int(line.split(',')[1]) for line in csv_text.splitlines()[1:]}\nassert sum(row['value']*index[row['id']] for row in rows)==${sum}`,
				),
			),
		],
		[
			rs(
				phaseRs(
					"guest.input.read",
					'let a=std::fs::read_to_string("/workspace/rows.jsonl")?; let b=std::fs::read_to_string("/workspace/rows.csv")?; assert!(!a.is_empty()&&!b.is_empty());',
				),
			),
			rs(
				phaseRs(
					"guest.input.read_parse_join",
					`let text=std::fs::read_to_string("/workspace/rows.jsonl")?; let csv=std::fs::read_to_string("/workspace/rows.csv")?; let index:std::collections::HashMap<u64,u64>=csv.lines().skip(1).map(|line|{let (a,b)=line.split_once(',').unwrap();(a.parse().unwrap(),b.parse().unwrap())}).collect(); let mut sum=0u64; for line in text.lines(){let row:serde_json::Value=serde_json::from_str(line)?;sum+=row["value"].as_u64().unwrap()*index[&row["id"].as_u64().unwrap()];} assert_eq!(sum,${sum});`,
				),
			),
		],
		{ "rows.jsonl": data, "rows.csv": csv },
		{
			rows: 10000,
			bytes: Buffer.byteLength(data) + Buffer.byteLength(csv),
			stateStrategy: "Python-resident-vs-Wasm-reparse;report-separately",
		},
	);
	const tree = Object.fromEntries(
		Array.from({ length: 100 }, (_, i) => [
			`files/f${String(i).padStart(4, "0")}.txt`,
			`${"x".repeat(4080)} TODO item\n`,
		]),
	);
	runtime(
		"R05-repository-scan",
		[
			py(
				phasePy(
					"guest.input.scan",
					"from pathlib import Path\npaths=sorted(Path('files').glob('*.txt'))\nassert sum('TODO' in p.read_text() for p in paths)==100",
				),
			),
		],
		[
			rs(
				phaseRs(
					"guest.input.scan",
					'let mut paths=std::fs::read_dir("/workspace/files")?.collect::<std::result::Result<Vec<_>,_>>()?; paths.sort_by_key(|p|p.path()); let mut n=0; for p in paths {if std::fs::read_to_string(p.path())?.contains("TODO"){n+=1;}} assert_eq!(n,100);',
				),
			),
		],
		tree,
		{ files: 100 },
	);
	runtime(
		"R06-exact-edits",
		[
			py(
				phasePy(
					"guest.exact_edits",
					`from pathlib import Path
_read_ns=_transform_ns=_write_ns=_verify_ns=0
for p in sorted(Path('files').glob('*.txt')):
    _step_start=time.perf_counter_ns(); s=p.read_text(); _read_ns+=time.perf_counter_ns()-_step_start
    _step_start=time.perf_counter_ns(); assert s.count('TODO')==1; replacement=s.replace('TODO','DONE'); _transform_ns+=time.perf_counter_ns()-_step_start
    _step_start=time.perf_counter_ns(); p.write_text(replacement); _write_ns+=time.perf_counter_ns()-_step_start
    _step_start=time.perf_counter_ns(); s=p.read_text(); assert 'DONE' in s and 'TODO' not in s; _verify_ns+=time.perf_counter_ns()-_step_start
for _name,_ns in [('project.source_read',_read_ns),('guest.exact_match_transform',_transform_ns),('project.source_write',_write_ns),('guest.edit_verify',_verify_ns)]:
    print('BENCH_PHASE:'+json.dumps({'name':_name,'durationMs':_ns/1e6}))`,
				),
			),
		],
		[
			rs(
				phaseRs(
					"guest.exact_edits",
					`let (mut read_ns,mut transform_ns,mut write_ns,mut verify_ns)=(0u128,0u128,0u128,0u128);
let mut paths=std::fs::read_dir("/workspace/files")?.collect::<std::result::Result<Vec<_>,_>>()?;
paths.sort_by_key(|p|p.path());
for p in paths {
    let p=p.path();
    let step_start=std::time::Instant::now(); let s=std::fs::read_to_string(&p)?; read_ns+=step_start.elapsed().as_nanos();
    let step_start=std::time::Instant::now(); assert_eq!(s.matches("TODO").count(),1); let replacement=s.replace("TODO","DONE"); transform_ns+=step_start.elapsed().as_nanos();
    let step_start=std::time::Instant::now(); std::fs::write(&p,replacement)?; write_ns+=step_start.elapsed().as_nanos();
    let step_start=std::time::Instant::now(); let s=std::fs::read_to_string(&p)?; assert!(s.contains("DONE")&&!s.contains("TODO")); verify_ns+=step_start.elapsed().as_nanos();
}
for (name,ns) in [("project.source_read",read_ns),("guest.exact_match_transform",transform_ns),("project.source_write",write_ns),("guest.edit_verify",verify_ns)] {
    println!("BENCH_PHASE:{}",serde_json::json!({"name":name,"durationMs":ns as f64/1e6}));
}`,
				),
			),
		],
		tree,
		{ files: 100, durability: "write-close-no-fsync" },
	);
	runtime(
		"R07-state-serialized",
		[
			py(phasePy("guest.state.save", "blob=bytes([42])*1048576\nopen('state.bin','wb').write(blob)")),
			...Array.from({ length: 5 }, () =>
				py(phasePy("guest.state.load", "assert open('state.bin','rb').read()==bytes([42])*1048576")),
			),
		],
		[
			rs(phaseRs("guest.state.save", 'std::fs::write("/workspace/state.bin",vec![42u8;1048576])?;')),
			...Array.from({ length: 5 }, () =>
				rs(phaseRs("guest.state.load", 'assert_eq!(std::fs::read("/workspace/state.bin")?,vec![42u8;1048576]);')),
			),
		],
		{},
		{ bytes: 1048576, stateStrategy: "common-file-serialized", fsync: false },
	);
	runtime(
		"R08-helper-reuse",
		[helperPy, ...Array.from({ length: 10 }, () => py("assert bench_answer()==42\nprint('BENCH_OK')"))],
		[
			helperRs,
			...Array.from({ length: 10 }, () =>
				rs('assert_eq!(agent_lib::helpers::bench::answer(),42); println!("BENCH_OK");'),
			),
		],
		{},
		{ helperUses: 10 },
	);
	runtime(
		"R09-bridge",
		[
			py(
				phasePy(
					"bridge.roundtrip",
					"from rlm import host_request as bench_request\nfor n in range(100):\n    value=await bench_request('bench.echo', {'n':n,'payload':'x'*1024})\n    assert value['n']==n and len(value['payload'])==1024",
				),
			),
		],
		[
			rs(
				phaseRs(
					"bridge.roundtrip",
					'for n in 0..100 {let value=rlm::host_request("bench.echo",serde_json::json!({"n":n,"payload":"x".repeat(1024)}))?;assert_eq!(value["n"],n);assert_eq!(value["payload"].as_str().unwrap().len(),1024);}',
				),
			),
		],
		{},
		{ requests: 100, payloadBytes: 1024 },
	);
	runtime(
		"R10-native-command",
		[
			py(
				phasePy(
					"bridge.command_roundtrip",
					"from rlm import host_request as bench_request\nresult=await bench_request('bench.command',{'command':'printf BENCH_COMMAND_OK'})\nassert result['stdout']=='BENCH_COMMAND_OK' and result['exitCode']==0",
				),
			),
		],
		[
			rs(
				phaseRs(
					"bridge.command_roundtrip",
					'let result=rlm::host_request("bench.command",serde_json::json!({"command":"printf BENCH_COMMAND_OK"}))?; assert_eq!(result["stdout"],"BENCH_COMMAND_OK"); assert_eq!(result["exitCode"],0);',
				),
			),
		],
		{},
		{ command: "printf BENCH_COMMAND_OK", capability: "production-bridge-with-common-reference-command-handler" },
	);
	runtime(
		"R11-persistence",
		[
			py("blob=bytes([42])*1048576\nprint('BENCH_OK')"),
			{ op: "snapshot", expectedStatus: ["ok"] },
			{ op: "restart", expectedStatus: ["ok"] },
			{ op: "restore", expectedStatus: ["ok"] },
			py("assert blob==bytes([42])*1048576\nprint('BENCH_OK')"),
		],
		[
			rs('rlm::state::put_blob("sample",&vec![42u8;1048576])?; println!("BENCH_OK");'),
			{ op: "restart", expectedStatus: ["ok"] },
			rs('assert_eq!(rlm::state::get_blob("sample")?.unwrap(),vec![42u8;1048576]); println!("BENCH_OK");'),
		],
		{},
		{ bytes: 1048576, persistenceContract: "Python-namespace-snapshot-vs-Wasm-explicit-blob-and-Git" },
	);
	runtime(
		"R12-error-repair",
		[{ ...py("x = ("), expectedStatus: ["error"], stdoutIncludes: undefined }, noop.python],
		[{ ...rs('let x: u32 = "bad";'), expectedStatus: ["compile_error"], stdoutIncludes: undefined }, noop.wasm],
		{},
		{ failure: "deliberate-invalid-source", repair: "fixed-reference-no-LLM" },
	);
	runtime(
		"R14-abort",
		[
			noop.python,
			{
				...py("import time\ntime.sleep(60)"),
				abortAfterMs: 2500,
				expectedStatus: ["aborted", "error"],
				stdoutIncludes: undefined,
			},
			noop.python,
		],
		[
			noop.wasm,
			{
				...rs("std::thread::sleep(std::time::Duration::from_secs(60));"),
				abortAfterMs: 2500,
				expectedStatus: ["aborted"],
				stdoutIncludes: undefined,
			},
			noop.wasm,
		],
		{},
		{ abortAfterMs: 2500 },
	);
	runtime(
		"R13-output",
		[py(phasePy("guest.output", "print('x'*16384)"))],
		[rs(phaseRs("guest.output", 'println!("{}","x".repeat(16384));'))],
		{},
		{ outputBytes: 16384, withinCommonOutputLimit: true },
	);
	runtime(
		"R15-concurrent-sessions",
		[noop.python],
		[noop.wasm],
		{},
		{ workers: 4, topology: "independent-production-runtimes-not-RLM-tree" },
	);
	runtime(
		"R16-long-session",
		Array.from({ length: 100 }, () => noop.python),
		Array.from({ length: 100 }, () => noop.wasm),
		{},
		{ cells: 100, modelContext: "not_applicable-direct-runtime" },
	);
	const taskRoot = join(root, "poc/bench/tasks");
	for (const id of readdirSync(taskRoot).sort()) {
		const spec: unknown = JSON.parse(readFileSync(join(taskRoot, id, "task.json"), "utf8"));
		if (!record(spec) || !Array.isArray(spec.turns) || !spec.turns.every((value) => typeof value === "string"))
			throw new Error(`Invalid task: ${id}`);
		result.push({
			id: `E-${id}`,
			lane: "end-to-end",
			scale: "existing-task",
			cacheCondition: "template-warm-new-daemon",
			turns: spec.turns,
			taskDir: join(taskRoot, id),
			taskBudgetMs: Number(spec.timeoutMs ?? 600000),
			fixture: {},
			tools: "runtime-only",
			check: { kind: "existing" },
			parameters: { taskId: id },
		});
	}
	const smokeIds = new Set([
		"H01-startup",
		"H02-stream",
		"H03-dispatch",
		"R01-noop",
		"R03-cpu",
		"R09-bridge",
		"R12-error-repair",
		"E-03-fix-bug",
		"E-08-rust-rename",
		"E-09-helper-accumulation",
		"E-11-join-report",
	]);
	if (suite === "all") return result;
	if (suite === "smoke") return result.filter((item) => smokeIds.has(item.id));
	if (["host", "runtime", "end-to-end"].includes(suite)) return result.filter((item) => item.lane === suite);
	const ids = suite.split(",");
	if (ids.some((id) => !["host", "runtime", "end-to-end"].includes(id) && !result.some((item) => item.id === id)))
		throw new Error("Unknown case selection");
	return result.filter((item) => ids.includes(item.id) || ids.includes(item.lane));
}
