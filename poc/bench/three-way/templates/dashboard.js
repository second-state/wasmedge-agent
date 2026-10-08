const data = JSON.parse(document.getElementById("benchmark-data").textContent);
const $ = (id) => document.getElementById(id);
const esc = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
const names = {
	"prime-ts": "Prime TS",
	"prime-rust": "Prime Rust",
	wasmedge: "WasmEdge interpreter",
	"wasmedge-aot": "WasmEdge AOT",
};
const colors = { "prime-ts": "#52cfe0", "prime-rust": "#b09bff", wasmedge: "#f3c875", "wasmedge-aot": "#64d4a7" };
const variants = [...new Set(data.charts.cases.map((row) => row.variantId))];
const caseIds = [...new Set(data.charts.cases.map((row) => row.caseId))];
const outcomes = {
	passed: ["通過", "#64d4a7"],
	failed: ["失敗", "#ef8c90"],
	infrastructure: ["Infra error", "#e7ad6d"],
	notApplicable: ["不適用", "#6b839e"],
	unexecuted: ["未完成", "#38465a"],
};
const states = {
	measured: ["已量測", "#64d4a7"],
	missing: ["未量測", "#d8a46d"],
	not_applicable: ["沒有此階段", "#6b839e"],
	not_run: ["此階段未發生", "#a391d9"],
	incomplete: ["量測中斷", "#ef8c90"],
};
const aliases = {
	"host.daemon_startup": "Daemon 啟動",
	"llm.request": "模型 request",
	"llm.time_to_first_byte": "模型首 byte",
	"llm.code_emission": "程式碼輸出窗口",
	"llm.code_ready": "程式碼就緒",
	"llm.tool_arguments_generation": "Tool arguments 輸出",
	"tool.execution": "工具整體執行",
	"cell.compile": "Cell Cargo 摘要",
	"cargo.command": "Cargo 命令（全部）",
	"cell.aot_compile": "Wasm→AOT 準備與編譯",
	"aot.command": "Wasm→AOT compiler 命令",
	"run.validated_elapsed": "初始化至驗收完成",
	"cell.source_prepare": "Cell source 準備",
	"cell.execution": "Wasm runtime 執行",
	"cell.python_prepare": "Python 準備",
	"cell.python_execute": "Python runtime 執行",
	"project.source_read": "讀取檔案",
	"guest.exact_match_transform": "比對與替換",
	"project.source_write": "寫入檔案",
	"guest.edit_verify": "修改驗證",
	"task.check": "Checker",
	"run.teardown": "清理",
	"task.agent_elapsed": "Agent 整體耗時",
	"run.user_elapsed": "使用者可見耗時",
};
const phaseOrder = Object.keys(aliases);
const label = (id) => names[id] ?? id;
const color = (id) => colors[id] ?? "#96abc6";
const time = (value) =>
	value === null || value === undefined
		? "—"
		: value >= 1000
			? `${(value / 1000).toFixed(2)} s`
			: `${value.toFixed(value < 1 ? 3 : 2)} ms`;
const ms = (value) =>
	value === null || value === undefined
		? "—"
		: value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 3 : 2 });
const sum = (values) => values.reduce((a, b) => a + b, 0);
const median = (values) => {
	const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
	if (!sorted.length) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const short = (value, limit = 32) => (value.length > limit ? `${value.slice(0, limit - 1)}…` : value);
const options = (values, all = null) =>
	`${all === null ? "" : `<option value="">${esc(all)}</option>`}${values.map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join("")}`;
const selection = (select, values, all = null) => {
	const previous = select.value;
	select.innerHTML = options(values, all);
	if ([...select.options].some((option) => option.value === previous)) select.value = previous;
};
const legend = (entries) =>
	entries.map(([text, fill]) => `<span><i class="dot" style="background:${fill}"></i>${esc(text)}</span>`).join("");
const scoped = (row) =>
	(!$("case-filter").value || (row.caseId ?? row.benchmarkId) === $("case-filter").value) &&
	(!$("variant-filter").value || row.variantId === $("variant-filter").value);
const selectedVariants = () => variants.filter((id) => !$("variant-filter").value || id === $("variant-filter").value);
const text = (x, y, value, extra = "") => `<text x="${x}" y="${y}" ${extra}>${esc(value)}</text>`;
const svg = (width, height, title, body) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><style>text{fill:#a9b9cd;font:14px system-ui,-apple-system,sans-serif}text.value{fill:#e6edf8;font-family:ui-monospace,monospace;font-size:13px}text.heading{fill:#e6edf8;font-size:15px;font-weight:600}</style><rect width="${width}" height="${height}" fill="#131d2b"/>${body}</svg>`;
function axis(max, left, width, top, bottom, logarithmic = false, format = time) {
	const limit = max > 0 ? max * 1.08 : 1;
	const toX = (value) => left + width * (logarithmic ? Math.log10(1 + value) / Math.log10(1 + limit) : value / limit);
	let body = "";
	for (let i = 0; i <= 4; i++) {
		const value = logarithmic ? 10 ** ((Math.log10(1 + limit) * i) / 4) - 1 : (limit * i) / 4;
		const x = left + (width * i) / 4;
		body += `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="#29374b"/>${text(x, top - 10, format(value), 'text-anchor="middle" font-size="10"')}`;
	}
	return { body, toX };
}
function latency() {
	const rows = data.charts.cases.filter(scoped);
	const ids = [...new Set(rows.map((row) => row.caseId))];
	const shownVariants = selectedVariants();
	const metric = $("metric").value;
	const maximum = Math.max(0, ...rows.map((row) => row[metric] ?? 0));
	const groupHeight = 33 + 23 * shownVariants.length;
	const height = 42 + ids.length * groupHeight;
	const { body: grid, toX } = axis(maximum, 195, 550, 30, height - 10, $("scale").value === "log");
	let body = grid;
	ids.forEach((caseId, index) => {
		const y = 52 + index * groupHeight;
		body += text(0, y, caseId, 'class="heading"');
		shownVariants.forEach((variantId, variantIndex) => {
			const row = rows.find((entry) => entry.caseId === caseId && entry.variantId === variantId);
			const value = row?.[metric] ?? null;
			const lineY = y + 21 + variantIndex * 23;
			const n =
				metric === "penalizedMs"
					? (row?.counts.passed ?? 0) + (row?.counts.failed ?? 0)
					: (row?.successSamples ?? 0);
			const message =
				value === null
					? row?.contractExcludedSamples
						? "不符合 cell 對照"
						: row?.counts.notApplicable
							? "N/A"
							: row?.counts.failed
								? "失敗 · 無成功樣本"
								: "無量測"
					: `${time(value)} · n=${n}`;
			body += `<g role="button" tabindex="0" data-focus-case="${esc(caseId)}" aria-label="${esc(`${caseId} ${label(variantId)} ${message}`)}"><title>${esc(`${caseId} / ${label(variantId)} / ${message}`)}</title><rect x="0" y="${lineY - 16}" width="920" height="22" fill="transparent"/>${text(0, lineY, label(variantId))}`;
			if (value !== null)
				body += `<rect x="195" y="${lineY - 12}" width="${Math.max(0, toX(value) - 195)}" height="15" rx="3" fill="${color(variantId)}" opacity=".87" data-value-ms="${value}"/>`;
			body += `${text(value === null ? 201 : Math.min(toX(value) + 8, 755), lineY, message, 'class="value"')}</g>`;
		});
	});
	$("latency-chart").innerHTML = ids.length
		? svg(930, Math.max(90, height), "各案例各版本耗時比較", body)
		: '<p class="empty">沒有符合篩選的 cases。</p>';
	$("latency-note").textContent =
		metric === "penalizedMs"
			? "包含適用且已完成的失敗 runs，以 task deadline 計入 mean；infra / N/A 不計入。點 bar 可聚焦案例。"
			: "只計入成功且符合 cell 對照條件的 runs；n 是執行次數，未提供 CI。點長條可聚焦案例。";
}
const compilationStates = {
	measured: "已扣除此期間內全部 Cargo",
	not_run: "完整量測：沒有 Cargo 呼叫",
	unavailable: "量測不足，無法計算",
	excluded: "未納入成功耗時比較",
};
const compilationReasons = {
	"missing-all-cargo-capture": "缺少完整 Cargo 命令起訖紀錄；舊的 cell.compile 只涵蓋 cell 編譯，不能當成全部 Cargo。",
	"all-cargo-union-clipped-to-elapsed":
		"扣除所選期間內所有 Cargo 命令的 wall time，包含初始化、skill probe、cell、library gate 與 checker；重疊區間只算一次。",
	"complete-capture-no-cargo": "完整的 Cargo 捕捉紀錄確認沒有呼叫 Cargo，扣除 0 ms。",
	"invalid-cargo-clock-or-identity": "Cargo 命令時鐘、起訖時間或 ID 不完整，無法安全扣除。",
	"missing-task-clock": "缺少可對齊的任務起訖時間，無法安全扣除。",
	"elapsed-clock-mismatch": "整體耗時與起訖時間不一致，無法安全扣除。",
	"cell-comparison-contract-not-met": "未符合 Python／Rust cell 對照條件；保留原始資料並排除比較。",
	"not-successful-applicable-run": "此 run 失敗、未完成或不適用，不計入成功耗時比較。",
};
const compilationLabel = (run) => compilationStates[run.state];
const compilationReason = (run, deductionMetric) =>
	run[deductionMetric] === 0 && run.compileMs > 0
		? "本次有 Cargo 呼叫，但全部位於所選期間之外（例如 agent 完成後的 checker）；此期間扣除 0 ms。"
		: (compilationReasons[run.reason] ?? run.reason);
function compilation() {
	const rows = data.charts.cases.filter(scoped);
	const ids = [...new Set(rows.map((row) => row.caseId))];
	const shownVariants = selectedVariants();
	const metric = $("compilation-metric").value;
	const allCompilers = $("compilation-scope").value === "all";
	const summaryKey = allCompilers ? "withoutAllCompilation" : "withoutCompilation";
	const scopeLabel = allCompilers ? "全部 Cargo 與 AOT" : "全部 Cargo";
	const rawMetric = { agentMs: "rawAgentMs", userMs: "rawUserMs", validatedMs: "rawValidatedMs" }[metric];
	const sampleMetric = { agentMs: "agentSamples", userMs: "userSamples", validatedMs: "validatedSamples" }[metric];
	const remainingMetric = {
		agentMs: allCompilers ? "agentWithoutAllCompilationMs" : "agentWithoutCompilationMs",
		userMs: allCompilers ? "userWithoutAllCompilationMs" : "userWithoutCompilationMs",
		validatedMs: allCompilers ? "validatedWithoutAllCompilationMs" : "validatedWithoutCompilationMs",
	}[metric];
	const cargoMetric = { agentMs: "agentCargoMs", userMs: "userCargoMs", validatedMs: "validatedCargoMs" }[metric];
	const aotMetric = { agentMs: "agentAotMs", userMs: "userAotMs", validatedMs: "validatedAotMs" }[metric];
	const deductionMetric = allCompilers
		? { agentMs: "agentCompilerMs", userMs: "userCompilerMs", validatedMs: "validatedCompilerMs" }[metric]
		: cargoMetric;
	const maximum = Math.max(0, ...rows.map((row) => row[summaryKey][rawMetric] ?? 0));
	const groupHeight = 33 + 26 * shownVariants.length;
	const height = 42 + ids.length * groupHeight;
	const { body: grid, toX } = axis(maximum, 195, 650, 30, height - 10, $("compilation-scale").value === "log");
	let body = grid;
	ids.forEach((caseId, index) => {
		const y = 52 + index * groupHeight;
		body += text(0, y, caseId, 'class="heading"');
		shownVariants.forEach((variantId, variantIndex) => {
			const row = rows.find((entry) => entry.caseId === caseId && entry.variantId === variantId);
			const adjusted = row?.[summaryKey];
			const value = adjusted?.[metric] ?? null;
			const original = adjusted?.[rawMetric] ?? null;
			const n = adjusted?.[sampleMetric] ?? 0;
			const lineY = y + 21 + variantIndex * 26;
			const message =
				value === null
					? row?.contractExcludedSamples
						? "不符合 cell 對照"
						: adjusted?.unavailableSamples
							? "無法計算 · 見明細原因"
							: row?.counts.notApplicable
								? "N/A"
								: "無成功樣本"
					: `${time(value)} · ${n} 次成功執行`;
			const description = `${caseId} / ${label(variantId)} / 原始 ${time(original)} / 扣除後 ${message}`;
			body += `<g role="button" tabindex="0" data-focus-case="${esc(caseId)}" aria-label="${esc(description)}"><title>${esc(description)}</title><rect x="0" y="${lineY - 16}" width="1180" height="24" fill="transparent"/>${text(0, lineY, label(variantId))}`;
			if (original !== null)
				body += `<rect x="195" y="${lineY - 13}" width="${Math.max(0, toX(original) - 195)}" height="18" rx="3" fill="${color(variantId)}" opacity=".2" data-original-ms="${original}"/>`;
			if (value !== null)
				body += `<rect x="195" y="${lineY - 10}" width="${Math.max(0, toX(value) - 195)}" height="12" rx="2" fill="${color(variantId)}" opacity=".95" data-adjusted-ms="${value}" data-case-id="${esc(caseId)}" data-variant-id="${esc(variantId)}" data-samples="${n}"/>`;
			body += `${text(value === null ? 205 : Math.min(toX(original) + 9, 855), lineY, message, 'class="value"')}</g>`;
		});
	});
	$("compilation-chart").innerHTML = ids.length
		? svg(1190, Math.max(90, height), `逐次扣除${scopeLabel}後的各版本耗時 median`, body)
		: '<p class="empty">沒有符合篩選的 cases。</p>';
	const runs = data.charts.compilationRuns
		.filter(scoped)
		.sort(
			(a, b) =>
				caseIds.indexOf(a.caseId) - caseIds.indexOf(b.caseId) ||
				a.repetition - b.repetition ||
				variants.indexOf(a.variantId) - variants.indexOf(b.variantId),
		);
	const unavailable = runs.filter((run) => run.state !== "excluded" && run[remainingMetric] === null).length;
	$("compilation-note").textContent =
		`目前 ${sum(rows.map((row) => row[summaryKey][sampleMetric]))}/${sum(rows.map((row) => row.successSamples))} 次成功執行可計算扣除後時間；${unavailable} 次因 compiler 或時鐘量測不足而無法計算。兩組 median 使用相同樣本；點長條可聚焦案例，扣除原因見下方明細。`;
	$("compilation-summary").textContent = `逐次執行明細 · ${runs.length} 次（依案例、次數、版本排列）`;
	const shown = runs.slice(0, 200);
	$("compilation-table").innerHTML = shown.length
		? `<table><thead><tr><th>案例 / 版本</th><th>原始時間</th><th>全部 Cargo<br>期間內 wall time</th><th>Wasm→AOT<br>期間內 wall time</th><th>${scopeLabel}<br>合併扣除量</th><th>扣除後時間</th><th>為什麼扣除 / 保留原值？</th><th>編譯命令紀錄</th></tr></thead><tbody>${shown.map((run) => `<tr data-adjusted-run="${esc(run.runId)}"><td><strong>${esc(label(run.variantId))}</strong><br>${esc(run.caseId)} · 第 ${run.repetition} 次<details class="run-identity"><summary>Run ID</summary><code>${esc(run.runId)}</code></details></td><td class="number" data-column="original">${time(run[metric])}</td><td class="number" data-column="cargo">${time(run[cargoMetric])}</td><td class="number" data-column="aot">${time(run[aotMetric])}</td><td class="number" data-column="deduction">${run.state === "excluded" ? "未納入比較" : run[deductionMetric] === null ? "無法計算" : time(run[deductionMetric])}</td><td class="number" data-column="remaining">${time(run[remainingMetric])}</td><td><span class="state ${esc(run.state)}">${esc(allCompilers && run.state !== "excluded" && run[remainingMetric] === null ? "AOT 或 Cargo 量測不足" : allCompilers && run[remainingMetric] !== null ? (run[deductionMetric] === 0 ? "完整量測：此期間編譯扣除量為 0" : `已扣除此期間內${scopeLabel}`) : compilationLabel(run))}</span><div class="compilation-reason">${esc(allCompilers ? (run.state === "excluded" ? compilationReason(run, deductionMetric) : run[remainingMetric] === null ? "缺少完整 AOT／Cargo 命令紀錄或可對齊時鐘，不能假設扣除量為零。" : run[deductionMetric] === 0 ? "完整量測確認所選期間沒有 Cargo 或 AOT 命令，扣除 0 ms。" : "扣除 Cargo 與 AOT 命令在所選期間的聯集；重疊部分只算一次。") : compilationReason(run, deductionMetric))}</div></td><td>${run.compileSpanIds.length ? `<button type="button" data-compilation-run="${esc(run.runId)}">查看 Cargo 紀錄</button><br><small>${run.compileObservations} 筆時間 / ${run.compileSpanIds.length} 筆紀錄</small>` : "沒有 Cargo 命令紀錄"}${run.aotSpanIds.length ? `<br><button type="button" data-aot-run="${esc(run.runId)}">查看 ${run.aotSpanIds.length} 筆 AOT 紀錄</button>` : ""}</td></tr>`).join("")}</tbody></table>${runs.length > shown.length ? '<p class="note">顯示前 200 筆；CSV 保留完整扣除明細。</p>' : ""}`
		: '<p class="empty">尚無 run 紀錄。</p>';
}
function executionChart(rows) {
	const ids = [...new Set(rows.map((row) => row.caseId))];
	const shownVariants = selectedVariants();
	const metric = $("execution-metric").value;
	const groups = ids.flatMap((caseId) =>
		shownVariants.map((variantId) => {
			const all = rows.filter((row) => row.caseId === caseId && row.variantId === variantId);
			const measured = all.filter(
				(row) => row.state === "measured" && typeof row[metric] === "number" && Number.isFinite(row[metric]),
			);
			return { caseId, variantId, all, measured, value: median(measured.map((row) => row[metric])) };
		}),
	);
	const maximum = Math.max(0, ...groups.map((group) => group.value ?? 0));
	const groupHeight = 33 + 26 * shownVariants.length;
	const height = 42 + ids.length * groupHeight;
	const { body: grid, toX } = axis(
		maximum,
		195,
		620,
		30,
		height - 10,
		$("execution-scale").value === "log",
		(value) => `${ms(value)} ms`,
	);
	let body = grid;
	ids.forEach((caseId, index) => {
		const y = 52 + index * groupHeight;
		body += text(0, y, caseId, 'class="heading"');
		shownVariants.forEach((variantId, variantIndex) => {
			const group = groups.find((entry) => entry.caseId === caseId && entry.variantId === variantId);
			const value = group.value,
				n = group.measured.length;
			const lineY = y + 21 + variantIndex * 26;
			const runtime = variantId.startsWith("wasmedge") ? "Rust / Wasm" : "Python";
			const message =
				value === null
					? group.all.some((row) => row.state === "excluded")
						? "未納入 cell 對照"
						: group.all.length && group.all.every((row) => row.cellCalls === 0)
							? "未呼叫 cell"
							: "無完整量測"
					: `${ms(value)} ms · n=${n}`;
			const calls = sum(group.measured.map((row) => row.cellCalls));
			const failures = sum(group.measured.map((row) => row.runtimeFailures));
			const compileFailures = sum(group.measured.map((row) => row.compileFailures));
			const aotFailures = sum(group.measured.map((row) => row.aotFailures ?? 0));
			const zeros = sum(group.measured.map((row) => row.zeroResolutionCells));
			const description = `${caseId} / ${label(variantId)} / ${runtime} / ${message} / 所選 ${n} runs 共 ${calls} cells，runtime 失敗 ${failures}，Cargo 失敗 ${compileFailures}，AOT 失敗 ${aotFailures}${zeros ? `；${zeros} cells 回報 0 ms（低於解析度）` : ""}`;
			body += `<g role="button" tabindex="0" data-focus-case="${esc(caseId)}" data-variant-id="${esc(variantId)}" data-execution-metric="${esc(metric)}" data-samples="${n}"${value === null ? "" : ` data-execution-value-ms="${value}"`} aria-label="${esc(description)}"><title>${esc(description)}</title><rect x="0" y="${lineY - 16}" width="1140" height="24" fill="transparent"/>${text(0, lineY, label(variantId))}`;
			if (value !== null) {
				body += `<rect x="195" y="${lineY - 12}" width="${Math.max(0, toX(value) - 195)}" height="15" rx="3" fill="${color(variantId)}" opacity=".9"/>`;
				if (value === 0) body += `<circle cx="195" cy="${lineY - 4}" r="3" fill="${color(variantId)}"/>`;
			}
			body += `${text(value === null ? 205 : Math.min(toX(value) + 9, 835), lineY, message, 'class="value"')}</g>`;
		});
	});
	const title =
		metric === "totalExecutionMs"
			? "各案例 cell 執行時間合計（ms / run）"
			: "各案例成功 cell 平均執行時間（ms / cell）";
	$("execution-chart").innerHTML = ids.length
		? svg(1150, Math.max(90, height), title, body)
		: '<p class="empty">尚無 cell 執行紀錄。</p>';
	$("execution-chart-note").textContent =
		`${metric === "totalExecutionMs" ? "每次 run 先合計成功與 runtime 失敗的 cell 執行時間，再取 runs 的 median。" : "每次 run 先計算成功 cell 的平均執行時間，再取 runs 的 median；各 run 權重相同。"}單位 ms，n 是完整且可比較的 run 數；n=1 時就是單筆值。缺失與未納入比較的資料不補零，0 ms 回報低於解析度。點長條可聚焦案例；cell 次數與失敗紀錄見 tooltip 及下方明細。`;
}
function execution() {
	const rows = data.charts.executionRuns
		.filter(scoped)
		.sort(
			(a, b) =>
				caseIds.indexOf(a.caseId) - caseIds.indexOf(b.caseId) ||
				a.repetition - b.repetition ||
				variants.indexOf(a.variantId) - variants.indexOf(b.variantId),
		);
	const measured = rows.filter((row) => row.state === "measured");
	executionChart(rows);
	$("execution-note").textContent =
		`${measured.length}/${rows.length} 次 run 有完整且可比較的 cell 執行時間。每列是一個 run；合計含成功與 runtime 失敗的 cell，編譯失敗不計入 runtime。`;
	$("execution-table").innerHTML = rows.length
		? `<table><thead><tr><th>案例 / 次數</th><th>版本 / Cell runtime</th><th>Cell 呼叫數</th><th>成功 / runtime 失敗<br>／Cargo 失敗／AOT 失敗</th><th>執行時間合計<br>ms / run</th><th>成功 cell 平均<br>ms / cell</th><th>失敗執行時間<br>ms / run</th><th>量測狀態</th></tr></thead><tbody>${rows.map((row) => `<tr data-execution-run="${esc(row.runId)}"><td>${esc(row.caseId)}<br>第 ${row.repetition} 次</td><td><strong style="color:${color(row.variantId)}">${esc(label(row.variantId))}</strong><br>${esc(row.runtime)}</td><td class="number">${row.cellCalls}</td><td class="number">${row.successfulCells} / ${row.runtimeFailures} / ${row.compileFailures} / ${row.aotFailures ?? 0}</td><td class="number" data-column="execution-total">${ms(row.totalExecutionMs)}</td><td class="number">${ms(row.meanSuccessfulCellMs)}</td><td class="number">${ms(row.failedExecutionMs)}</td><td>${row.state === "measured" ? "完整量測" : row.state === "excluded" ? "未納入成功比較" : row.cellCalls === 0 ? "未呼叫 cell，沒有 runtime 執行時間可比較" : `量測不足（缺 ${row.missingCells} cells 或 ID 不完整）`}${row.zeroResolutionCells ? `<br><small>${row.zeroResolutionCells} cells 回報 0 ms（低於回報解析度）</small>` : ""}${row.executionSpanIds.length ? `<br><button type="button" data-execution-drill="${esc(row.runId)}">查看執行紀錄</button>` : ""}</td></tr>`).join("")}</tbody></table>`
		: '<p class="empty">尚無 cell 執行紀錄。</p>';
}
function stacked(id, entries, categories, title, totalsLabel) {
	const height = 16 + entries.length * 64;
	let body = "";
	entries.forEach((entry, index) => {
		const y = 22 + index * 64;
		const total = sum(Object.keys(categories).map((key) => entry.counts[key] ?? 0));
		body +=
			text(0, y, label(entry.variantId), 'class="heading"') +
			text(495, y, totalsLabel(entry, total), 'class="value" text-anchor="end"');
		let x = 0;
		for (const [key, [name, fill]] of Object.entries(categories)) {
			const count = entry.counts[key] ?? 0;
			const width = total ? (495 * count) / total : 0;
			if (count)
				body += `<g><title>${esc(`${label(entry.variantId)} · ${name}: ${count}/${total}`)}</title><rect x="${x}" y="${y + 8}" width="${width}" height="17" rx="2" fill="${fill}"/>${width >= 30 ? text(x + width / 2, y + 20, count, 'text-anchor="middle" style="fill:#0c121b;font-size:10px;font-weight:650"') : ""}</g>`;
			x += width;
		}
		if (!total) body += text(0, y + 21, "尚無資料");
	});
	$(id).innerHTML = svg(500, Math.max(90, height), title, body);
}
function overview() {
	const rows = data.charts.cases.filter(scoped);
	const runs = data.runs.filter(scoped);
	const spans = data.spans.filter(scoped);
	const counts = Object.fromEntries(
		Object.keys(outcomes).map((key) => [key, sum(rows.map((row) => row.counts[key]))]),
	);
	const applicable = counts.passed + counts.failed;
	$("kpi-runs").textContent = `${runs.length} / ${sum(rows.map((row) => row.planned))}`;
	$("kpi-correct").textContent = applicable ? `${counts.passed} / ${applicable}` : "—";
	$("kpi-correct-note").textContent =
		`失敗 ${counts.failed} · Infra ${counts.infrastructure} · N/A ${counts.notApplicable}`;
	$("kpi-requests").textContent = sum(
		runs
			.filter((run) => !["replay-fixed-v1", "none-direct-runtime"].includes(run.modelId))
			.map((run) => run.requestCount ?? 0),
	);
	$("kpi-cases").textContent = new Set(rows.map((row) => row.caseId)).size;
	const measured = spans.filter((span) => span.measurementState === "measured").length;
	$("kpi-measured").textContent = measured.toLocaleString("en-US");
	$("kpi-measured-note").textContent =
		`${spans.length.toLocaleString("en-US")} records · ${spans.length ? ((100 * measured) / spans.length).toFixed(1) : "—"}% measured`;
	const runEntries = selectedVariants().map((variantId) => ({
		variantId,
		counts: Object.fromEntries(
			Object.keys(outcomes).map((key) => [
				key,
				sum(rows.filter((row) => row.variantId === variantId).map((row) => row.counts[key])),
			]),
		),
	}));
	const phaseEntries = selectedVariants().map((variantId) => ({
		variantId,
		counts: Object.fromEntries(
			Object.keys(states).map((state) => [
				state,
				spans.filter((span) => span.variantId === variantId && span.measurementState === state).length,
			]),
		),
	}));
	stacked(
		"correctness-chart",
		runEntries,
		outcomes,
		"各版本 correctness 與規劃完整性",
		(entry, total) => `${entry.counts.passed} pass / ${total} slots`,
	);
	stacked(
		"coverage-chart",
		phaseEntries,
		states,
		"各版本 span 量測狀態分布",
		(entry, total) => `${entry.counts.measured} / ${total} measured`,
	);
}
function heatmap() {
	const ids = caseIds.filter((id) => !$("case-filter").value || id === $("case-filter").value);
	selection(
		$("phase-case"),
		ids.map((id) => [id, id]),
	);
	const caseId = $("phase-case").value;
	const shownVariants = selectedVariants();
	const entries = data.charts.phases.filter((row) => row.caseId === caseId && shownVariants.includes(row.variantId));
	const search = $("phase-search").value.toLowerCase();
	const phaseNames = [...new Set(entries.map((entry) => entry.phase))].filter(
		(phase) =>
			(!search || `${phase} ${aliases[phase] ?? ""}`.toLowerCase().includes(search)) &&
			($("show-unmeasured").checked || entries.some((entry) => entry.phase === phase && entry.medianMs !== null)),
	);
	const order = (phase) => (phaseOrder.includes(phase) ? phaseOrder.indexOf(phase) : 1000);
	phaseNames.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
	const max = Math.max(0, ...entries.map((entry) => entry.medianMs ?? 0));
	const body = phaseNames
		.map(
			(phase) =>
				"<tr><td><code>" +
				esc(phase) +
				"</code>" +
				(aliases[phase] ? `<div class="phase-label">${esc(aliases[phase])}</div>` : "") +
				"</td>" +
				shownVariants
					.map((variantId) => {
						const entry = entries.find((row) => row.phase === phase && row.variantId === variantId);
						const value = entry?.medianMs ?? null;
						const nonMeasured = Object.entries(entry?.states ?? {})
							.filter(([state]) => state !== "measured")
							.map(([state, count]) => `${states[state]?.[0] ?? state} ${count}`)
							.join(" · ");
						const description =
							value === null
								? nonMeasured || "無紀錄"
								: `n=${entry.observations}${entry.errorObservations ? ` · error ${entry.errorObservations}` : ""}${nonMeasured ? ` · ${nonMeasured}` : ""}`;
						const alpha = value === null ? 0 : 0.06 + (0.32 * Math.log1p(value)) / Math.log1p(max || 1);
						return `<td><button type="button" class="heat-cell${entry?.errorObservations ? " has-errors" : ""}" style="background:rgba(82,207,224,${alpha})" data-drill-phase="${esc(phase)}" data-drill-case="${esc(caseId)}" data-drill-variant="${esc(variantId)}" aria-label="${esc(`${caseId} ${label(variantId)} ${phase}: ${value === null ? description : `${ms(value)} ms ${description}`}`)}" title="${esc(`${phase} · ${description}`)}"${value === null ? "" : ` data-value-ms="${value}"`}><span class="number">${value === null ? "—" : ms(value)}</span><small>${esc(description)}</small></button></td>`;
					})
					.join("") +
				"</tr>",
		)
		.join("");
	$("phase-chart").innerHTML = phaseNames.length
		? `<table class="heatmap"><thead><tr><th>Phase · median ms / observation</th>${shownVariants.map((id) => `<th style="color:${color(id)}">${esc(label(id))}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`
		: '<p class="empty">沒有符合篩選的階段。</p>';
}
const familyColor = (phase) =>
	phase.startsWith("llm.")
		? "#52cfe0"
		: phase.includes("compile") || phase.startsWith("compiler.")
			? "#b09bff"
			: phase.startsWith("cell.") || phase.startsWith("guest.")
				? "#64d4a7"
				: phase.startsWith("task.check")
					? "#efa0c3"
					: "#a0aec4";
function timeline() {
	const runs = data.runs.filter(scoped);
	selection(
		$("timeline-run"),
		runs.map((run) => [run.runId, `${run.caseId} · ${label(run.variantId)} · r${run.repetition}`]),
	);
	const runId = $("timeline-run").value;
	const spans = data.spans.filter(
		(span) =>
			span.runId === runId &&
			span.measurementState === "measured" &&
			span.startMonoNs !== null &&
			span.endMonoNs !== null,
	);
	const clocks = [
		...new Set(spans.map((span) => span.clockId).filter((clock) => clock && !clock.startsWith("duration-only:"))),
	];
	selection(
		$("timeline-clock"),
		clocks.map((clock) => [
			clock,
			clock.startsWith("collector:") ? `Collector monotonic · ${short(clock, 40)}` : clock,
		]),
	);
	const clock = $("timeline-clock").value;
	const actual = spans
		.filter((span) => span.clockId === clock)
		.sort((a, b) =>
			BigInt(a.startMonoNs) < BigInt(b.startMonoNs) ? -1 : BigInt(a.startMonoNs) > BigInt(b.startMonoNs) ? 1 : 0,
		);
	if (!actual.length) $("timeline-chart").innerHTML = '<p class="empty">沒有可在同一 clock 對齊的量測。</p>';
	else {
		const origin = BigInt(actual[0].startMonoNs);
		const extent = Math.max(...actual.map((span) => Number(BigInt(span.endMonoNs) - origin) / 1e6));
		const rows = actual.slice(0, 150);
		const height = 50 + rows.length * 23;
		const { body: grid, toX } = axis(extent, 220, 680, 35, height - 8);
		let body = grid;
		rows.forEach((span, index) => {
			const y = 52 + index * 23;
			const start = Number(BigInt(span.startMonoNs) - origin) / 1e6;
			const end = Number(BigInt(span.endMonoNs) - origin) / 1e6;
			const description = `${span.name} · ${time(span.durationMs)} · offset ${time(start)} · ${span.outcome} · ${span.requestId ?? span.cellId ?? ""}`;
			body += `<g role="button" tabindex="0" data-trace-span="${esc(span.spanId)}" data-clock-id="${esc(span.clockId)}" aria-label="${esc(description)}"><title>${esc(description)}</title><rect x="0" y="${y - 16}" width="1020" height="22" fill="transparent"/>${text(0, y, short(`${aliases[span.name] ?? span.name}${span.requestId ? ` / ${span.requestId}` : ""}`, 28))}<rect x="${toX(start)}" y="${y - 11}" width="${Math.max(0.7, toX(end) - toX(start))}" height="14" rx="2" fill="${span.outcome === "ok" ? familyColor(span.name) : "#ef8c90"}" opacity=".85"/>${text(915, y, time(span.durationMs), 'class="value"')}</g>`;
		});
		$("timeline-chart").innerHTML = svg(1030, height, "單一 clock 的相對時間軸", body);
	}
	const imported = spans.filter((span) => span.clockId?.startsWith("duration-only:"));
	$("timeline-note").textContent =
		`此 clock ${actual.length} spans${actual.length > 150 ? "，圖中顯示前 150 筆" : ""}；下方 ${imported.length} 筆獨立 duration 不放入此時間軸。`;
	$("duration-summary").textContent = `${imported.length} 筆獨立 duration observations（無共同起點）`;
	$("duration-table").innerHTML = imported.length
		? `<table><thead><tr><th>Phase</th><th>Cell / command</th><th>Duration</th><th>Outcome</th></tr></thead><tbody>${imported
				.slice(0, 200)
				.map(
					(span) =>
						`<tr><td><code>${esc(span.name)}</code></td><td><code>${esc(span.cellId ?? span.commandId ?? "")}</code></td><td class="number">${time(span.durationMs)}</td><td>${esc(span.outcome)}</td></tr>`,
				)
				.join(
					"",
				)}</tbody></table>${imported.length > 200 ? '<p class="note">顯示前 200 筆；完整資料可從 trace / CSV 查看。</p>' : ""}`
		: '<p class="empty">這次 run 沒有獨立 duration observations。</p>';
}
function trace() {
	const term = $("trace-search").value.toLowerCase();
	let rows = data.spans.filter(
		(span) =>
			scoped(span) &&
			(!$("trace-phase").value || span.name === $("trace-phase").value) &&
			(!$("trace-state").value || span.measurementState === $("trace-state").value) &&
			(!$("trace-outcome").value || span.outcome === $("trace-outcome").value) &&
			(!term || JSON.stringify(span).toLowerCase().includes(term)),
	);
	if ($("trace-sort").value === "duration")
		rows = [...rows].sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
	const shown = rows.slice(0, $("trace-limit").value === "all" ? rows.length : Number($("trace-limit").value));
	$("trace-count").textContent = `· ${rows.length.toLocaleString("en-US")} spans`;
	$("trace-note").textContent = `顯示 ${shown.length}/${rows.length} 筆；CSV 保留全部原始資料。`;
	$("trace-table").innerHTML =
		`<table><thead><tr><th>Case / variant</th><th>Phase</th><th>Duration</th><th>State / outcome</th><th>Run / cell / request</th><th>Reason / attributes</th></tr></thead><tbody>${shown.map((span) => `<tr><td>${esc(span.benchmarkId)}<br>${esc(label(span.variantId))}</td><td><code>${esc(span.name)}</code></td><td class="number">${time(span.durationMs)}</td><td><span class="state ${esc(span.measurementState)}">${esc(span.measurementState)}</span><br>${esc(span.outcome)}</td><td><code>${esc(span.runId)}<br>${esc(span.cellId ?? span.toolCallId ?? "")}<br>${esc(span.requestId ?? "")}</code></td><td>${esc(span.reason ?? "")}<details><summary>attributes / clock</summary><pre>${esc(JSON.stringify({ clockId: span.clockId, startMonoNs: span.startMonoNs, endMonoNs: span.endMonoNs, ...span.attributes }, null, 2))}</pre></details></td></tr>`).join("")}</tbody></table>`;
}
function render() {
	overview();
	latency();
	compilation();
	execution();
	heatmap();
	timeline();
	trace();
}

if (!data.runs.some((run) => run.validatedElapsedMs !== null && run.validatedElapsedMs !== undefined))
	$("compilation-metric").value = "agentMs";
$("model").textContent = data.report.modelId ?? "Offline replay / direct runtime";
if (data.report.cellComparison?.endToEndRuns) {
	const audit = data.report.cellComparison;
	$("cell-contract-notice").hidden = false;
	$("cell-contract-notice").textContent = audit.notControlledRuns
		? `此為舊的 native-tools 資料：${audit.notControlledRuns} 次執行未限制 cell 工具，不符合 Python cell/runtime vs Rust cell/Wasm runtime 對照。原始紀錄保留，耗時比較排除這些資料。`
		: `Cell 對照：${audit.compliantRuns}/${audit.endToEndRuns} 次符合逐回合 cell 執行規則，${audit.violatedRuns} 次違規。讀取、計算與修改由 Python / Rust cell 完成，外部專案 checker 另列計時。`;
}
$("plan-date").textContent = `Plan ${new Date(data.report.planCreatedAt).toLocaleString("zh-TW")}`;
$("integrity").textContent =
	`${data.report.complete ? "全部 slots 已完成" : "仍有未完成 slots"} · integrity errors ${data.report.integrityErrors.length}`;
$("variant-legend").innerHTML = legend(variants.map((id) => [label(id), color(id)]));
$("outcome-legend").innerHTML = legend(Object.values(outcomes));
$("state-legend").innerHTML = legend(Object.values(states));
selection(
	$("case-filter"),
	caseIds.map((id) => [id, id]),
	"所有案例",
);
selection(
	$("variant-filter"),
	variants.map((id) => [id, label(id)]),
	"所有版本",
);
selection(
	$("trace-phase"),
	[...new Set(data.spans.map((span) => span.name))].sort().map((phase) => [phase, phase]),
	"所有 phases",
);
selection(
	$("trace-state"),
	[...new Set(data.spans.map((span) => span.measurementState))].sort().map((state) => [state, state]),
	"所有 states",
);
selection(
	$("trace-outcome"),
	[...new Set(data.spans.map((span) => span.outcome))].sort().map((outcome) => [outcome, outcome]),
	"所有 outcomes",
);
for (const id of ["case-filter", "variant-filter"]) $(id).addEventListener("change", render);
for (const id of ["metric", "scale"]) $(id).addEventListener("change", latency);
for (const id of ["compilation-metric", "compilation-scale", "compilation-scope"])
	$(id).addEventListener("change", compilation);
for (const id of ["execution-metric", "execution-scale"]) $(id).addEventListener("change", execution);
for (const id of ["phase-case", "show-unmeasured"]) $(id).addEventListener("change", heatmap);
$("phase-search").addEventListener("input", heatmap);
for (const id of ["timeline-run", "timeline-clock"]) $(id).addEventListener("change", timeline);
for (const id of ["trace-phase", "trace-state", "trace-outcome", "trace-sort", "trace-limit"])
	$(id).addEventListener("change", trace);
$("trace-search").addEventListener("input", trace);
$("reset").addEventListener("click", () => {
	for (const id of [
		"case-filter",
		"variant-filter",
		"trace-phase",
		"trace-state",
		"trace-outcome",
		"trace-search",
		"phase-search",
	])
		$(id).value = "";
	$("show-unmeasured").checked = true;
	$("phase-case").value = caseIds[0] ?? "";
	$("timeline-run").value = data.runs[0]?.runId ?? "";
	render();
});
function focusCase(event) {
	const target = event.target.closest("[data-focus-case]");
	if (!target || (event.type === "keydown" && !["Enter", " "].includes(event.key))) return;
	event.preventDefault();
	$("case-filter").value = target.dataset.focusCase;
	render();
}
$("latency-chart").addEventListener("click", focusCase);
$("latency-chart").addEventListener("keydown", focusCase);
$("compilation-chart").addEventListener("click", focusCase);
$("compilation-chart").addEventListener("keydown", focusCase);
$("execution-chart").addEventListener("click", focusCase);
$("execution-chart").addEventListener("keydown", focusCase);
$("compilation-table").addEventListener("click", (event) => {
	const target = event.target.closest("[data-compilation-run], [data-aot-run]");
	if (!target) return;
	const run = data.charts.compilationRuns.find(
		(entry) => entry.runId === (target.dataset.compilationRun ?? target.dataset.aotRun),
	);
	if (!run) return;
	$("case-filter").value = run.caseId;
	$("variant-filter").value = run.variantId;
	$("trace-phase").value = target.dataset.aotRun ? "aot.command" : "cargo.command";
	$("trace-state").value = "";
	$("trace-outcome").value = "";
	$("trace-search").value = run.runId;
	render();
	$("timeline-run").value = run.runId;
	timeline();
	$("trace-details").open = true;
	$("trace-details").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("execution-table").addEventListener("click", (event) => {
	const target = event.target.closest("[data-execution-drill]");
	if (!target) return;
	const run = data.charts.executionRuns.find((row) => row.runId === target.dataset.executionDrill);
	if (!run) return;
	$("case-filter").value = run.caseId;
	$("variant-filter").value = run.variantId;
	$("trace-phase").value = run.variantId.startsWith("wasmedge") ? "cell.execution" : "cell.python_execute";
	$("trace-state").value = "";
	$("trace-outcome").value = "";
	$("trace-search").value = run.runId;
	render();
	$("trace-details").open = true;
	$("trace-details").scrollIntoView({ behavior: "smooth", block: "start" });
});
function focusSpan(event) {
	const target = event.target.closest("[data-trace-span]");
	if (!target || (event.type === "keydown" && !["Enter", " "].includes(event.key))) return;
	event.preventDefault();
	for (const id of ["trace-phase", "trace-state", "trace-outcome"]) $(id).value = "";
	$("trace-search").value = target.dataset.traceSpan;
	trace();
	$("trace-details").open = true;
	$("trace-details").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("timeline-chart").addEventListener("click", focusSpan);
$("timeline-chart").addEventListener("keydown", focusSpan);
$("phase-chart").addEventListener("click", (event) => {
	const target = event.target.closest("[data-drill-phase]");
	if (!target) return;
	$("case-filter").value = target.dataset.drillCase;
	$("trace-phase").value = target.dataset.drillPhase;
	$("trace-state").value = "";
	$("trace-outcome").value = "";
	$("trace-search").value = "";
	render();
	const run = data.runs.find(
		(run) => run.caseId === target.dataset.drillCase && run.variantId === target.dataset.drillVariant,
	);
	if (run) {
		$("timeline-run").value = run.runId;
		timeline();
	}
	$("trace-details").open = true;
	$("trace-details").scrollIntoView({ behavior: "smooth", block: "start" });
});
for (const button of document.querySelectorAll("[data-export]"))
	button.addEventListener("click", () => {
		const chart = $(button.dataset.export).querySelector("svg");
		if (!chart) return;
		const blob = new Blob([new XMLSerializer().serializeToString(chart)], { type: "image/svg+xml" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${button.dataset.export}.svg`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	});
render();
