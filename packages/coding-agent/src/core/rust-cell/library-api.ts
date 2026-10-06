import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

interface Group {
	open: string;
	tokens: Token[];
}
type Token = string | Group;

const IDENTIFIER = /^(?:r#)?[_\p{XID_Start}][\p{XID_Continue}]*$/u;
const QUALIFIERS = new Set(["async", "const", "unsafe"]);
const TYPE_ITEMS = new Set(["struct", "enum", "union", "type", "trait"]);
const UNRESOLVED_ATTRIBUTES = new Set(["cfg", "cfg_attr", "path"]);
const OPEN_FOR_CLOSE: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Group delimiters while keeping comments and literals out of the item scan.
 * Lifetimes remain separate tokens; a character literal must have a closing '. */
function tokenize(source: string): Token[] {
	const pattern =
		/\/\/[^\r\n]*|\/\*|(?:br|cr|r)(#{0,255})"|(?:b|c)?"|b?'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|[^\r\n])|[^'\\\r\n])'|(?:r#)?[_\p{XID_Start}][\p{XID_Continue}]*|[^\s]/gu;
	const root: Group = { open: "", tokens: [] };
	const stack = [root];
	while (true) {
		const match = pattern.exec(source);
		if (!match) break;
		let token = match[0];
		if (token.startsWith("//")) continue;
		if (token === "/*") {
			const comments = /\/\*|\*\//g;
			comments.lastIndex = pattern.lastIndex;
			let depth = 1;
			while (depth > 0) {
				const delimiter = comments.exec(source);
				if (!delimiter) return [];
				depth += delimiter[0] === "/*" ? 1 : -1;
			}
			pattern.lastIndex = comments.lastIndex;
			continue;
		}
		if (match[1] !== undefined) {
			const closing = `"${match[1]}`;
			const end = source.indexOf(closing, pattern.lastIndex);
			if (end === -1) return [];
			pattern.lastIndex = end + closing.length;
			token = '"literal"';
		} else if (token.endsWith('"')) {
			const quotes = /\\[\s\S]|"/g;
			quotes.lastIndex = pattern.lastIndex;
			let closing: RegExpExecArray | null;
			do {
				closing = quotes.exec(source);
				if (!closing) return [];
			} while (closing[0] !== '"');
			pattern.lastIndex = quotes.lastIndex;
			token = '"literal"';
		} else if (token.length > 1 && token.endsWith("'")) {
			token = '"literal"';
		}

		const current = stack[stack.length - 1];
		if (["(", "[", "{"].includes(token)) {
			const group = { open: token, tokens: [] };
			current.tokens.push(group);
			stack.push(group);
		} else if ([")", "]", "}"].includes(token)) {
			if (stack.length === 1 || OPEN_FOR_CLOSE[token] !== current.open) return [];
			stack.pop();
		} else {
			current.tokens.push(token);
		}
	}
	return stack.length === 1 ? root.tokens : [];
}

function isGroup(token: Token | undefined, open: string): token is Group {
	return typeof token === "object" && token.open === open;
}

function isIdentifier(token: Token | undefined): token is string {
	return typeof token === "string" && IDENTIFIER.test(token);
}

/** A source-only inventory of public free functions and types reachable through ordinary
 * public modules. No compiler, macro expansion, cfg evaluation, re-export or
 * associated-item resolution: those require the optional rustdoc backend. */
export function listLibraryApi(sourceDir: string): { functions: string[]; types: string[] } {
	const functions = new Set<string>();
	const types = new Set<string>();
	const ancestors = new Set<string>();

	function scanFile(file: string, moduleDir: string, path: string[]): void {
		let real: string;
		let source: string;
		try {
			real = realpathSync(file);
			source = readFileSync(real, "utf-8");
		} catch {
			// A missing/unreadable module must not break a state restoration notice.
			return;
		}
		if (ancestors.has(real)) return;
		ancestors.add(real);
		scanModule(tokenize(source), moduleDir, path);
		ancestors.delete(real);
	}

	function scanModule(tokens: Token[], moduleDir: string, path: string[]): void {
		for (let i = 0; i < tokens.length; ) {
			let omit = false;
			while (tokens[i] === "#") {
				const inner = tokens[i + 1] === "!";
				const attribute = tokens[i + (inner ? 2 : 1)];
				if (!isGroup(attribute, "[")) return;
				const name = attribute.tokens[0];
				const unresolved = typeof name === "string" && UNRESOLVED_ATTRIBUTES.has(name);
				if (inner && unresolved) return;
				omit ||= unresolved;
				i += inner ? 3 : 2;
			}
			const start = i;
			while (i < tokens.length && tokens[i] !== ";" && !isGroup(tokens[i], "{")) i++;
			const header = tokens.slice(start, i);
			const body = tokens[i++];
			if (omit || header[0] !== "pub") continue;

			if (header[1] === "mod" && header.length === 3 && isIdentifier(header[2])) {
				const name = header[2];
				const childDir = join(moduleDir, name.replace(/^r#/, ""));
				if (isGroup(body, "{")) {
					scanModule(body.tokens, childDir, [...path, name]);
				} else if (body === ";") {
					const candidates = [`${childDir}.rs`, join(childDir, "mod.rs")].filter(existsSync);
					if (candidates.length === 1) scanFile(candidates[0], childDir, [...path, name]);
				}
				continue;
			}

			const t = header[1] === "unsafe" && header[2] === "trait" ? 2 : 1;
			if (typeof header[t] === "string" && TYPE_ITEMS.has(header[t] as string) && isIdentifier(header[t + 1])) {
				types.add([...path, header[t + 1]].join("::"));
				continue;
			}

			let f = 1;
			while (typeof header[f] === "string" && QUALIFIERS.has(header[f] as string)) f++;
			if (header[f] === "extern") {
				f++;
				if (header[f] === '"literal"') f++;
			}
			if (header[f] === "fn" && isIdentifier(header[f + 1]) && header.some((token) => isGroup(token, "("))) {
				functions.add([...path, header[f + 1]].join("::"));
			}
		}
	}

	scanFile(join(sourceDir, "lib.rs"), sourceDir, []);
	return { functions: [...functions].sort(), types: [...types].sort() };
}
