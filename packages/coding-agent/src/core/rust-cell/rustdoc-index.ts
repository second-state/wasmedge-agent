/** The JSON schema is unstable. Accept only the format exercised by the pinned
 * rustdoc toolchain in CI rather than silently misreading a newer schema. */
export const RUSTDOC_FORMAT_VERSION = 61;
export const RUSTDOC_TEST_TOOLCHAIN = "nightly-2026-09-25";

const KEYWORDS = new Set(
	"abstract as async await become box break const continue crate do dyn else enum extern false final fn for gen if impl in let loop macro match mod move mut override priv pub ref return self Self static struct super trait true try type typeof unsafe unsized use virtual where while yield".split(
		" ",
	),
);

type ObjectValue = Record<string, unknown>;
interface Item extends ObjectValue {
	id: number;
	name: string | null;
	visibility: unknown;
	docs: string | null;
	inner: ObjectValue;
}
interface Document {
	root: number;
	index: Record<string, Item>;
	paths: Record<string, { path: string[]; kind: string }>;
}

export interface RustdocApiItem {
	path: string;
	kind: string;
	docs: string | null;
	/** Rustdoc's structured signature, generics, fields, and associated items.
	 * Child IDs are replaced with queryable paths; no source span or host path. */
	declaration: ObjectValue;
	context?: ObjectValue;
}

export function objectValue(value: unknown): ObjectValue {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid rustdoc JSON object");
	return value as ObjectValue;
}

export function indexRustdoc(documents: Record<string, unknown>): RustdocApiItem[] {
	const docs = new Map<string, Document>();
	for (const [name, value] of Object.entries(documents)) {
		const data = objectValue(value);
		if (data.format_version !== RUSTDOC_FORMAT_VERSION) {
			throw new Error(`Unsupported rustdoc JSON format ${data.format_version}; expected ${RUSTDOC_FORMAT_VERSION}`);
		}
		const index = objectValue(data.index);
		objectValue(data.paths);
		if (typeof data.root !== "number" || !index[data.root]) throw new Error("Invalid rustdoc JSON root");
		for (const raw of Object.values(index)) {
			const item = objectValue(raw);
			const inner = objectValue(item.inner);
			if (
				Object.keys(inner).length !== 1 ||
				typeof item.id !== "number" ||
				(item.name !== null && typeof item.name !== "string") ||
				(item.docs !== null && typeof item.docs !== "string")
			) {
				throw new Error("Invalid rustdoc JSON item");
			}
		}
		docs.set(name, data as unknown as Document);
	}
	const entries = new Map<string, RustdocApiItem>();
	const visiting = new Set<string>();
	const referenceKeys = new Set(["fields", "variants", "items", "impls", "implementations"]);
	const namespace = (kind: string) =>
		["function", "constant", "static", "variant"].includes(kind)
			? "value"
			: kind.includes("macro")
				? "macro"
				: "type";

	function resolve(doc: Document, id: unknown): { doc: Document; item: Item } | undefined {
		if (typeof id !== "number") return undefined;
		if (doc.index[id]) return { doc, item: doc.index[id] };
		const path = doc.paths[id]?.path;
		const other = path && docs.get(path[0]);
		if (!other) return undefined;
		const found = Object.entries(other.paths).find(([, entry]) => entry.path.join("::") === path.join("::"));
		const item = path.length === 1 ? other.index[other.root] : found && other.index[found[0]];
		return item ? { doc: other, item } : undefined;
	}

	function visit(doc: Document, item: Item, path: string, context?: ObjectValue): void {
		const key = `${docsKey(doc)}:${item.id}`;
		const entryKey = `${path}:${key}`;
		if (visiting.has(key) || (!item.inner.use && entries.has(entryKey))) return;
		if (entries.size >= 20_000) throw new Error("Rustdoc API exceeds 20000 public items");
		visiting.add(key);
		try {
			const kind = Object.keys(item.inner)[0];
			const body = item.inner[kind];
			if (kind === "use") {
				const use = objectValue(body);
				const target = resolve(doc, use.id);
				if (target) {
					if (use.is_glob) {
						const module = target.item.inner.module;
						if (module) visitMembers(target.doc, objectValue(module).items, path, true, undefined, true);
						else if (target.item.inner.enum)
							visitMembers(
								target.doc,
								objectValue(target.item.inner.enum).variants,
								path,
								false,
								undefined,
								true,
							);
					} else visit(target.doc, target.item, path, context);
				} else {
					const unresolved = use.is_glob ? `${path}::*#${item.id}` : path;
					entries.set(entryKey, {
						path: unresolved,
						kind: "external_reexport",
						docs: item.docs,
						declaration: { use: body },
					});
				}
				return;
			}
			const entry: RustdocApiItem = { path, kind, docs: item.docs, declaration: {} };
			if (context) entry.context = context;
			entries.set(entryKey, entry);
			entry.declaration = {
				[kind]: expand(
					body,
					doc,
					path,
					kind === "module",
					kind === "trait" ? objectValue(body).generics : undefined,
				),
			};
		} finally {
			visiting.delete(key);
		}
	}

	function docsKey(doc: Document): string {
		return doc.index[doc.root].name ?? "";
	}

	function visitMembers(
		doc: Document,
		ids: unknown,
		parent: string,
		publicOnly = false,
		context?: ObjectValue,
		fromGlob = false,
	): unknown[] {
		if (!Array.isArray(ids)) throw new Error("Invalid rustdoc JSON item references");
		const isGlob = (id: unknown) =>
			Boolean(resolve(doc, id)?.item.inner.use && objectValue(resolve(doc, id)!.item.inner.use).is_glob);
		// Explicit exports shadow glob imports regardless of source order.
		return [...ids]
			.sort((a, b) => Number(isGlob(a)) - Number(isGlob(b)))
			.flatMap((id) => {
				if (id === null) return [{ stripped: true }];
				const target = resolve(doc, id);
				if (!target) return [{ unavailable: true }];
				const { item } = target;
				if (publicOnly && item.visibility !== "public") return [];
				const use = item.inner.use ? objectValue(item.inner.use) : undefined;
				const implementation = item.inner.impl ? objectValue(item.inner.impl) : undefined;
				if (implementation?.is_synthetic || implementation?.blanket_impl) return [];
				const name = use ? use.name : (item.name ?? `impl#${item.id}`);
				if (typeof name !== "string") throw new Error("Invalid rustdoc JSON item name");
				const path = use?.is_glob ? parent : `${parent}::${KEYWORDS.has(name) ? `r#${name}` : name}`;
				const resolved = use ? resolve(target.doc, use.id)?.item : item;
				if (
					fromGlob &&
					resolved &&
					[...entries.values()].some(
						(entry) => entry.path === path && namespace(entry.kind) === namespace(Object.keys(resolved.inner)[0]),
					)
				)
					return [];
				// Inherent methods have ordinary callable paths; trait implementations
				// keep a distinct entry so identically named methods are not conflated.
				if (implementation && !implementation.trait) {
					return visitMembers(target.doc, implementation.items, parent, true, {
						generics: implementation.generics,
						for: implementation.for,
					});
				}
				const before = use?.is_glob ? new Set(entries.keys()) : undefined;
				visit(target.doc, item, path, context);
				if (before)
					return [...entries]
						.filter(
							([key, entry]) =>
								!before.has(key) &&
								entry.path.startsWith(`${parent}::`) &&
								!entry.path.slice(parent.length + 2).includes("::"),
						)
						.map(([, entry]) => ({ path: entry.path, kind: entry.kind }));
				return [{ path, kind: Object.keys(item.inner)[0] }];
			});
	}

	function expand(value: unknown, doc: Document, parent: string, publicOnly: boolean, generics?: unknown): unknown {
		if (Array.isArray(value)) return value.map((child) => expand(child, doc, parent, publicOnly));
		if (value === null || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => {
				if (referenceKeys.has(key) && Array.isArray(child)) {
					return [
						key,
						visitMembers(doc, child, parent, key === "items" && publicOnly, generics ? { generics } : undefined),
					];
				}
				// Tuple struct/variant fields are represented directly as ID arrays.
				if (key === "tuple" && Array.isArray(child) && child.every((id) => id === null || typeof id === "number")) {
					return [key, visitMembers(doc, child, parent)];
				}
				return [key, expand(child, doc, parent, publicOnly, generics)];
			}),
		);
	}

	for (const name of ["agent_lib", "rlm"]) {
		const doc = docs.get(name);
		if (doc) visit(doc, doc.index[doc.root], name);
	}
	return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}
