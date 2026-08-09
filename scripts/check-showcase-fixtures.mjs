/** Ties the hard numbers in examples/showcase/README.md back to the fixtures
 * they describe. The walkthrough prints exact expected outcomes for every
 * mission; if a fixture edit moves one of them and the prose is not updated,
 * a first-time reader watches a correct agent run disagree with the README and
 * concludes the runtime is broken. This check makes that drift fail the build.
 *
 * It also guards two properties the fixtures must keep for the missions to be
 * answerable at all:
 *   - each line carries at most one of the three defects and the truncated ones
 *     keep a parseable timestamp, so a cell classifying by field count and one
 *     classifying by timestamp reach the same 5/5/5 split. A cell that tests
 *     the latency field first cannot be made to agree — a truncated line has no
 *     latency to read — which is why the missions ask for the field count;
 *   - the fixtures stay byte-clean (LF endings, uniform 2-decimal money), so
 *     a cell that splits on '\n' or parses cents positionally is not trapped. */

import { readFileSync } from "node:fs";

const LOG_PATH = "examples/showcase/project/logs/access.log";
const CSV_PATH = "examples/showcase/project/data/inventory.csv";
const NOTES_PATH = "examples/showcase/project/notes.md";
const README_PATH = "examples/showcase/README.md";

const failures = [];

const logRaw = readFileSync(LOG_PATH, "utf-8");
const csvRaw = readFileSync(CSV_PATH, "utf-8");
const notesRaw = readFileSync(NOTES_PATH, "utf-8");
// Missions quote numbers across wrapped lines, and notes.md wraps its format
// spec mid-sentence, so compare against whitespace-normalized copies rather
// than the raw text. The raw text is still what the byte-hygiene loop reads.
const readme = readFileSync(README_PATH, "utf-8").replace(/\s+/g, " ");
const notes = notesRaw.replace(/\s+/g, " ");

for (const [label, text] of [
	["access.log", logRaw],
	["inventory.csv", csvRaw],
	["notes.md", notesRaw],
]) {
	// A trailing \r rides on the last field, so `"96.4\r".parse::<f64>()` fails
	// in the sandbox while `.lines()` silently hides it on the host.
	check(!text.includes("\r"), `${label}: contains CR bytes; fixtures must use LF endings`);
	// Trailing blanks survive `.lines()` and break the anchored formats the
	// missions parse, while `split_whitespace()` hides them — so the counts
	// below would disagree for a reason no diagnostic points at.
	check(!/[ \t]+$/m.test(text), `${label}: has trailing whitespace on some line; fixtures must be byte-clean`);
}
// Batched, not fatal: the split below no longer depends on this holding, and
// ending the run here would hide every log, CSV and README failure behind one
// stray byte — the fix-rerun-discover loop this report exists to remove.
check(logRaw.endsWith("\n") && !logRaw.endsWith("\n\n"), "access.log: must end with exactly one newline");

const logLines = dropTrailingBlanks(logRaw.split("\n"));
const TIMESTAMP = /^\[\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} \+\d{4}\]$/;
const RECORD = /^(\S+) - - \[(\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}) \+\d{4}\] "([A-Z]+) (\S+) HTTP\/1\.1" (\d{3}) (\d+) (\d+)ms$/;

/** Rust's `split_whitespace()` ignores leading and trailing runs; JS's
 * `split(/\s+/)` emits an empty string for each, which would count a stray
 * trailing space as an extra field and misreport the line as truncated. */
function fieldsOf(line) {
	return line.trim().split(/\s+/);
}

/** Each corruption class as an independent predicate, scoped to the fields it
 * can actually read: a truncated line has no field 10 to test and may have
 * lost its timestamp too, so an unscoped predicate would report every one of
 * them as multiply defective. */
function defectsOf(line) {
	const fields = fieldsOf(line);
	const defects = [];
	// `< 11`, not `!== 11`: a line carrying extra fields is the opposite of
	// truncated, and labelling it so would send the STATUS_PREFIX loop below
	// into telling the author to cut a complete record. The field-count check
	// in the classification loop is what reports an over-long line.
	if (fields.length < 11) defects.push("truncated");
	if (fields.length >= 5 && !TIMESTAMP.test(`${fields[3]} ${fields[4]}`)) defects.push("badTimestamp");
	if (fields.length === 11 && !/^\d+ms$/.test(fields[10])) defects.push("badLatency");
	return defects;
}

/** Mission 3 states one count per class, so a line carrying two defects makes
 * the split depend on which one a cell tests for first. Asserting at most one
 * per line covers all three pairs; the pair of orderings this replaced put the
 * latency test last in both, so it could only ever catch truncated/timestamp. */
const classCounts = { wellFormed: 0, truncated: 0, badTimestamp: 0, badLatency: 0 };
for (const [index, line] of logLines.entries()) {
	const fieldCount = fieldsOf(line).length;
	const defects = defectsOf(line);
	check(
		defects.length < 2,
		`access.log:${index + 1} carries ${defects.length} corruption classes at once (${defects.join(", ")}); the missions need them disjoint`,
	);
	// An over-long line has no class of its own, so say what is actually wrong
	// with it rather than letting the truncated bucket absorb it.
	check(
		fieldCount <= 11,
		`access.log:${index + 1} has ${fieldCount} whitespace fields; the documented format has 11 and the missions read it positionally`,
	);
	// The timestamp predicate is scoped to the fields it can read, so a line cut
	// before field 4 classifies as truncated here while a cell that tests the
	// timestamp first calls it garbled. The split stays disjoint across those
	// two cell shapes only while every line keeps a timestamp to test.
	check(
		fieldCount >= 5,
		`access.log:${index + 1} is cut before its timestamp; a cell classifying by timestamp would count it as garbled rather than truncated`,
	);
	classCounts[defects[0] ?? "wellFormed"]++;
}
/* A truncated line that still carries a complete `"METHOD path HTTP/1.1"
 * status` prefix is counted by a cell whose regex anchors through the status
 * — a shape mission 1's "count a line only if every field parses" steers away
 * from but does not forbid — and the over-count lands directly on the README's
 * pinned status totals. Only the truncated class can be closed this way: the
 * other ten lines are deliberately intact apart from their one defect, so they
 * carry a parseable status by construction and a status-anchored cell counts
 * 295 rather than 285. No assertion here can change that — the missions' "count
 * a line only if every field parses" is the only thing steering past it. */
const STATUS_PREFIX = /"[A-Z]+ \S+ HTTP\/1\.1" \d{3}/;
for (const [index, line] of logLines.entries()) {
	if (!defectsOf(line).includes("truncated")) continue;
	check(
		!STATUS_PREFIX.test(line),
		`access.log:${index + 1} is truncated but still exposes a parseable status; cut it before the status so an anchored regex cannot count it`,
	);
}
check(classCounts.truncated === 5, `access.log: expected 5 truncated lines, got ${classCounts.truncated}`);
check(classCounts.badTimestamp === 5, `access.log: expected 5 garbled-timestamp lines, got ${classCounts.badTimestamp}`);
check(classCounts.badLatency === 5, `access.log: expected 5 garbled-latency lines, got ${classCounts.badLatency}`);

const records = logLines.map((line) => RECORD.exec(line)).filter((match) => match !== null);
check(
	records.length === classCounts.wellFormed,
	`access.log: ${records.length} lines match the documented format but ${classCounts.wellFormed} classify as well-formed`,
);

/* notes.md is the fixture's only written schema and the one the model actually
 * parses from inside the sandbox, so it drifting from the log is a wrong answer
 * that compiles cleanly — the rustc feedback loop never corrects it. This
 * branch has already shipped that bug twice: a spec whose timestamp did not
 * span two whitespace fields made a positional reader take `status` out of
 * `"GET` (cb145556), and one that omitted the `ms` suffix made every latency
 * parse fail, reporting 0 well-formed lines (bfdd3fc2). Tie the spec to the
 * real fields rather than to literals, so either file moving alone fails. */
const documentedFormat = /The log format is `([^`]+)`/.exec(notes);
checkFatal(
	documentedFormat !== null,
	"notes.md: no ``The log format is `...` `` line; the missions have no schema to parse from",
);
const formatFields = documentedFormat[1].trim().split(/\s+/);
// Sampled from a line that matches RECORD, not merely one defectsOf() finds no
// defect in: those two agree only while the count check above passes, and when
// it does not, the sample this diagnostic quotes should still be a line the
// documented format actually describes.
const wellFormedFields = fieldsOf(records[0]?.[0] ?? "");
check(
	formatFields.length === wellFormedFields.length,
	`notes.md: the documented format splits into ${formatFields.length} whitespace fields but a well-formed log line has ${wellFormedFields.length}`,
);
for (const [name, shape] of [
	["status", /^\d{3}$/],
	["bytes", /^\d+$/],
	["latency", /^\d+ms$/],
]) {
	const at = formatFields.indexOf(name);
	check(
		at !== -1 && shape.test(wellFormedFields[at] ?? ""),
		`notes.md: a cell indexing positionally from the documented format reads ${name} out of "${wellFormedFields[at] ?? "(past the end of the line)"}"`,
	);
}
// Not derivable from field positions: the log carries the suffix either way,
// so only the prose tells a cell not to parse the latency as a bare integer.
check(
	notes.includes("`latency` carries an `ms` suffix"),
	"notes.md: must state that `latency` carries an `ms` suffix, or a cell parsing it as a bare integer finds no well-formed lines",
);

const statusCounts = countBy(records, (record) => record[5]);
const endpointCounts = countBy(records, (record) => record[4]);
const [worstEndpoint, worstCount] = leadingEndpoint(
	(record) => record[5] === "500",
	"the 500s",
	"access.log: no 500 responses, so mission 1 has no problem child to point at",
);
// Mission 4 asks for the 5xx pattern, not the 500s. Ranking it separately is
// what makes the pin below cover its own claim: a 503 shift that moves the
// 5xx leader has to fail the build even when the 500-only leader is unchanged.
const [worst5xxEndpoint] = leadingEndpoint(
	(record) => record[5].startsWith("5"),
	"the 5xx responses",
	"access.log: no 5xx responses, so mission 4 has no error pattern to summarize",
);

expectInReadme(`${records.length} well-formed requests across ${endpointCounts.size} endpoints`);
expectInReadme(
	`status totals ${[...statusCounts.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([status, count]) => `${status}×${count}`)
		.join(", ")}`,
);
expectInReadme(
	`\`${worstEndpoint}\` flagged as the problem child (${worstCount} of the ${statusCounts.get("500")} 500s)`,
);
// The README says the 5xx summary points at that endpoint *again*, which holds
// only while the 5xx leader is the 500 leader. Ranking them separately above is
// what makes a 503 shift fail the build on its own; this is what ties the two
// back together, so the walkthrough cannot end up saying "again" about an
// endpoint its own mission-1 paragraph never named.
check(
	worst5xxEndpoint === worstEndpoint,
	`access.log: the 5xx leader (${worst5xxEndpoint}) is not the 500 leader (${worstEndpoint}); the README says the 5xx summary points at it "again"`,
);
expectInReadme(`the 5xx summary again points at \`${worst5xxEndpoint}\``);
const corrupted = classCounts.truncated + classCounts.badTimestamp + classCounts.badLatency;
expectInReadme(
	`${corrupted} corrupted lines — ${classCounts.truncated} truncated, ${classCounts.badTimestamp} with a garbage timestamp, ${classCounts.badLatency} with a non-numeric latency field — and ${records.length} well-formed lines`,
);
// The next sentence restates the same total as a `split('\n')` cell sees it,
// one higher for the trailing newline's empty entry. Left unpinned, an author
// who fixes every line this gate reports still ships a paragraph that
// contradicts itself — in the one place the README explains the artifact.
expectInReadme(`reports ${corrupted + 1} corrupted lines with a blank example`);
expectInReadme(`the fresh cell reports ${records.length} requests via the new helper`);

// Median latency per endpoint. Even sample counts straddle two values, so the
// README documents the pair and the ordering rather than one exact figure.
const latencies = new Map();
for (const record of records) {
	if (!latencies.has(record[4])) latencies.set(record[4], []);
	latencies.get(record[4]).push(Number(record[7]));
}
const ranked = [...latencies.entries()]
	.map(([endpoint, values]) => {
		const sorted = values.sort((a, b) => a - b);
		const mid = sorted.length >> 1;
		const straddle = sorted.length % 2 === 0 ? [sorted[mid - 1], sorted[mid]] : null;
		return { endpoint, median: straddle ? (straddle[0] + straddle[1]) / 2 : sorted[mid], straddle };
	})
	.sort((a, b) => b.median - a.median);

// Fatal: the README documents a top 3, so there have to be three to rank.
checkFatal(ranked.length >= 3, `access.log: expected at least 3 endpoints to rank by median, got ${ranked.length}`);
const [first, second, third] = ranked;
// The README calls this ordering "the stable part", so it must not rest on
// insertion order the way a tie would. Guard the 4th place too: a tie there
// makes membership in the trio arbitrary even when the three are distinct.
check(
	first.median > second.median && second.median > third.median,
	`access.log: medians ${first.median}/${second.median}/${third.median} do not strictly descend across the top 3; the README pins that order`,
);
check(
	ranked.length < 4 || third.median > ranked[3].median,
	`access.log: median ${third.median} ties across the 3rd and 4th endpoint; the README names an exact top 3`,
);
check(first.straddle === null, `access.log: expected an odd sample count for ${first.endpoint} so its median is exact`);
expectInReadme(
	`top 3 by median, in this order: \`${first.endpoint}\` (${first.median} ms), \`${second.endpoint}\` (≈${Math.floor(second.median)} ms), \`${third.endpoint}\` (≈${Math.floor(third.median)} ms)`,
);
for (const entry of [second, third]) {
	check(
		entry.straddle !== null,
		`access.log: expected an even sample count for ${entry.endpoint} to match the README's straddle note`,
	);
}
// One assertion covering both pairs in rank order: asserted separately, the
// README could attribute either pair to the wrong endpoint and still pass.
if (second.straddle && third.straddle) {
	expectInReadme(
		`straddling two values (${second.straddle[0]}/${second.straddle[1]} and ${third.straddle[0]}/${third.straddle[1]})`,
	);
}

// Only trailing blanks are dropped, so a stray blank row in the middle still
// reaches the field-count check below — the subagent's `split('\n')` trips
// over that one too.
check(csvRaw.endsWith("\n") && !csvRaw.endsWith("\n\n"), "inventory.csv: must end with exactly one newline");
const csvLines = dropTrailingBlanks(csvRaw.split("\n"));
check(csvLines[0] === "sku,name,warehouse,qty,unit_price", "inventory.csv: unexpected header");
// A quoted comma inside `name` would shift every later column right; the
// fixture stays quote-free so a textbook `split(',')` cell is not trapped.
const rows = csvLines.slice(1).map((line) => line.split(","));
// Reported per row, then stopped once: the destructure below and every total
// built from it dereference these fields, so a short row would reach money()
// as NaN and get "$NaN.NaN" quoted back as the value to put in the README.
// Ending the run inside the loop instead would report one bad row per run —
// the fix-rerun-discover loop this report exists to remove.
for (const fields of rows) {
	check(
		fields.length === 5,
		`inventory.csv: expected 5 comma-separated fields, got ${fields.length} in "${fields.join(",")}"`,
	);
}
checkFatal(
	rows.every((fields) => fields.length === 5),
	"inventory.csv: the malformed rows above have to be fixed before the totals the README pins can be checked",
);
const items = rows.map(([sku, name, warehouse, qty, unitPrice]) => ({
	sku,
	name,
	warehouse,
	qty: Number(qty),
	qtyRaw: qty,
	unitPrice,
}));

const PRICE_SHAPE = /^\d+\.\d{2}$/;
const QTY_SHAPE = /^\d+$/;
for (const item of items) {
	// Mixed 1- and 2-decimal money makes the textbook positional cents parse
	// (`d * 100 + c`) silently wrong: "355.5" reads as 5 cents, not 50.
	check(
		PRICE_SHAPE.test(item.unitPrice),
		`inventory.csv: ${item.sku} price "${item.unitPrice}" is not 2-decimal; positional cents parsing would misread it`,
	);
	// `Number("")` is 0, not NaN, so an empty cell would quietly become the
	// lowest-stock SKU this check then tells the author to put in the README.
	check(QTY_SHAPE.test(item.qtyRaw), `inventory.csv: ${item.sku} qty "${item.qtyRaw}" is not a bare integer`);
}
// Same shape as the field-count gate above, and needed for the same reason: a
// price like "12.3O" makes toCents() NaN, which reaches money() as "$NaN.NaN"
// and leaves rankEntries' comparator returning NaN, so the pins below name
// whichever warehouse happens to come first in the file. Report every bad cell
// first, then stop before the totals are built on them.
checkFatal(
	items.every((item) => PRICE_SHAPE.test(item.unitPrice) && QTY_SHAPE.test(item.qtyRaw)),
	"inventory.csv: the malformed prices or quantities above have to be fixed before the totals the README pins can be checked",
);

const warehouseCents = new Map();
for (const item of items) {
	warehouseCents.set(item.warehouse, (warehouseCents.get(item.warehouse) ?? 0) + item.qty * toCents(item.unitPrice));
}
const byValue = rankEntries(warehouseCents);
// Fatal: the README names all three warehouses, and the assertion below
// dereferences each of them.
checkFatal(byValue.length === 3, `inventory.csv: expected 3 warehouses, got ${byValue.length}`);
// As with the endpoint rankings and the lowest-stock trio: the README names the
// leader and lists all three in order, so a tie anywhere in the ranking would
// make that order an artifact of the row each warehouse first appears on.
check(
	byValue[0][1] > byValue[1][1] && byValue[1][1] > byValue[2][1],
	`inventory.csv: warehouse totals ${byValue.map(([, cents]) => money(cents)).join("/")} do not strictly descend; the README lists all three in that order`,
);

const byStock = [...items].sort((a, b) => a.qty - b.qty);
// Fatal: the README lists three SKUs, and the ordering check below
// dereferences each of them.
checkFatal(byStock.length >= 3, `inventory.csv: expected at least 3 SKUs to rank by stock, got ${byStock.length}`);
const lowestStock = byStock.slice(0, 3);
// As with the 500s: a qty tie would make the README's exact trio an artifact
// of CSV row order. Guard inside the trio as well as at its boundary — the
// README lists the three in order, so a tie between any two is the same hazard.
check(
	lowestStock[0].qty < lowestStock[1].qty && lowestStock[1].qty < lowestStock[2].qty,
	`inventory.csv: qty ${lowestStock.map((item) => item.qty).join("/")} does not strictly ascend across the 3 lowest SKUs; the README lists them in that order`,
);
check(
	byStock.length < 4 || byStock[2].qty < byStock[3].qty,
	`inventory.csv: qty ${byStock[2]?.qty} ties across the 3rd and 4th lowest SKUs; the README names an exact trio`,
);
expectInReadme(`lowest stock: ${lowestStock.map((item) => `${item.sku} (qty ${item.qty})`).join(", ")}`);
// Every warehouse must be named, or an agent that drops one still "passes".
expectInReadme(
	`warehouse value leader ${byValue[0][0]} at ≈${money(byValue[0][1])} (${byValue[1][0]} ≈${money(byValue[1][1])}, ${byValue[2][0]} ≈${money(byValue[2][1])})`,
);

flushFailures();

console.log(`Showcase fixture check passed (${records.length} well-formed log lines, ${items.length} inventory rows).`);

function expectInReadme(expected) {
	check(includesWholeToken(readme, expected), `README.md does not state the fixture's actual value: "${expected}"`);
}

/** A pinned string that starts or ends at a digit is swallowed by a longer
 * number: plain `includes()` accepts "1285 well-formed" for "285 well-formed"
 * and "503×20" for "503×2", so the exact drift these pins exist to catch
 * passes. Require the match to sit on a word boundary at each such edge. */
function includesWholeToken(haystack, needle) {
	const startsMidToken = /\w/.test(needle[0]);
	const endsMidToken = /\w/.test(needle.at(-1));
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
		const before = haystack[at - 1];
		const after = haystack[at + needle.length];
		if (startsMidToken && before !== undefined && /\w/.test(before)) continue;
		if (endsMidToken && after !== undefined && /\w/.test(after)) continue;
		return true;
	}
	return false;
}

/** Splitting on '\n' leaves one empty entry per trailing newline. Dropping
 * them keeps the counts right whether or not the newline check passed, so
 * that check can batch its message instead of ending the whole run. */
function dropTrailingBlanks(lines) {
	const kept = [...lines];
	while (kept.at(-1) === "") kept.pop();
	return kept;
}

/** The README names a single endpoint for each ranking it quotes, so each one
 * needs an outright leader — a tie resolves by insertion order, which would
 * silently bless whichever endpoint happens to appear first in the file. */
function leadingEndpoint(matches, subject, missing) {
	const ranked = rankEntries(countBy(records.filter(matches), (record) => record[4]));
	checkFatal(ranked.length > 0, missing);
	check(
		ranked.length < 2 || ranked[1][1] < ranked[0][1],
		`access.log: ${ranked[0][0]} does not lead ${subject} outright (${ranked[0][1]} vs ${ranked[1]?.[1]}); the README names a single endpoint`,
	);
	return ranked[0];
}

/** Exact cents for any decimal string. The 2-decimal guard above reports a
 * malformed price on its own; parsing it positionally here as well would make
 * the warehouse totals below wrong, and those totals are quoted back to the
 * author as the value to put in the README. */
function toCents(price) {
	return Math.round(Number(price) * 100);
}

function money(cents) {
	const whole = Math.floor(cents / 100).toLocaleString("en-US");
	return `$${whole}.${String(cents % 100).padStart(2, "0")}`;
}

/** A Map, not a bare object: these keys are fixture data, and a request path
 * or warehouse named `__proto__` reads back as the inherited Object.prototype
 * — non-nullish, so `?? 0` keeps it and the count silently goes wrong, while
 * the array form throws and replaces the whole failure list with a stack
 * trace. Same reason the accumulators at their call sites are Maps. */
function countBy(rows, key) {
	const counts = new Map();
	for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
	return counts;
}

function rankEntries(counts) {
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

/** For preconditions the code below dereferences. A plain check() would only
 * queue the message and then die on the very data it rejected, replacing the
 * whole failure list with a TypeError; this reports everything gathered so far
 * and stops. */
function checkFatal(condition, message) {
	// Only this precondition failing may end the run: flushing whenever
	// anything is queued would cut the report short at the first fatal call
	// site and hide every later assertion.
	if (condition) return;
	failures.push(message);
	flushFailures();
}

function flushFailures() {
	if (failures.length > 0) {
		console.error(["Showcase fixture check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
		process.exit(1);
	}
}
