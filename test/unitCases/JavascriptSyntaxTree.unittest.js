"use strict";

const { toEstreeObject } = require("../../lib/javascript/syntax");
const {
	Field,
	Flag,
	NodeType,
	Part,
	SyntaxTree,
	WebpackParser
} = require("../../lib/javascript/syntax-parser");
const { firstDifference } = require("../../tooling/compare-js-tools");

/** @typedef {import("../../lib/javascript/syntax-parser").Node} EstreeNode */

/**
 * A parsed node whose children may already stand as the ids they were written as.
 * @typedef {{ type: string, [key: string]: unknown }} WrittenNode
 */

/**
 * @param {WrittenNode} node a parsed node, some children written already
 * @returns {EstreeNode} the node as `addEstree` takes it
 */
const asEstree = (node) => /** @type {EstreeNode} */ (/** @type {unknown} */ (node));

// The options a build parses with, and the ones the minifier does.
const OPTION_SETS = [
	{
		ecmaVersion: /** @type {const} */ ("latest"),
		ranges: true,
		allowReturnOutsideFunction: true,
		allowAwaitOutsideFunction: true,
		importPhases: true
	},
	{
		ecmaVersion: /** @type {const} */ ("latest"),
		preserveParens: true,
		allowSuperOutsideMethod: true,
		importPhases: true
	}
];

const SCRIPT = `
var a = 1, b; let c; const d = 2;
function* generate(x = 1, { y, z: [w, , ...v] }, ...rest) { yield* x; yield; }
function strict() { "use strict"; }
async function run() { await a; for await (const x of y) {} }
const arrow = async (p) => (p ? 1 : 2);
const K = class Named extends Base {
	#hidden = 1; static s; static { this.t = 1; }
	method() { return #hidden in this && super.x; }
	get g() { return 1; } set g(value) {}
};
function F() { new.target; }
outer: for (let i = 0; i < 1; i++) { if (i) continue outer; else break outer; }
for (const k in o); for (x of y) {}
while (a) a--; do ++a; while (false);
with (o) { p; }
switch (a) { case 1: break; default: }
try { throw new Error("e"); } catch ({ message }) {} finally { debugger; }
try {} catch {}
o?.p?.[q]?.(r);
tag\`a\${b}c\`; \`x\${y}\`;
a = b += c ?? d; e || (f && g);
[a, , b] = [1, , ...c]; ({ a, b: e = 1, ...f } = { a, [b]: 1, get c() {}, d() {} });
x = /re/gi; y = 10n; z = null; t = true; u = 1.5e3; s = "s";
(a, b); void 0; typeof a; delete o.p; -a; !a; ~a;
(function () { return; })();
`;

const MODULE = `
import a, { b as c, "d" as e } from "x" with { type: "json" };
import * as ns from "y";
import defer * as lazy from "z";
export const f = 1;
export default class extends a {}
export { f as g, c };
export * as h from "x";
export * from "x" with { type: "json" };
await import("x", { with: { type: "json" } });
import.meta.url;
import.defer("x");
`;

const SKIPPED = new Set(["type", "start", "end", "range", "regex", "bigint"]);

/**
 * Writes a parsed tree into a `SyntaxTree` as a parser writing columns would.
 * @param {SyntaxTree} tree the tree
 * @param {Record<string, EXPECTED_ANY>} node the parsed node
 * @param {Set<string>} seen the types written so far
 * @returns {number} the node's id
 */
const write = (tree, node, seen) => {
	seen.add(node.type);
	const id = tree.add(
		/** @type {Record<string, number>} */ (NodeType)[node.type],
		node.start,
		node.end
	);
	for (const key of Object.keys(node)) {
		if (SKIPPED.has(key)) continue;
		const value = node[key];
		if (Array.isArray(value)) {
			tree.set(
				id,
				key,
				value.map((item) => (item === null ? null : write(tree, item, seen)))
			);
		} else if (value && typeof value === "object" && "type" in value) {
			tree.set(id, key, write(tree, value, seen));
		} else {
			tree.set(id, key, value);
		}
	}
	return id;
};

/**
 * @param {string} code the source
 * @returns {{ tree: SyntaxTree, node: number }} the tree and its first expression
 */
const writeExpression = (code) => {
	const tree = new SyntaxTree();
	const statement = /** @type {EXPECTED_ANY} */ (
		WebpackParser.parse(code, { ecmaVersion: "latest" })
	).body[0];
	return { tree, node: write(tree, statement.expression, new Set()) };
};

describe("SyntaxTree", () => {
	it("rebuilds every node type the parser makes", () => {
		/** @type {Set<string>} */
		const seen = new Set();
		const tree = new SyntaxTree();
		for (const options of OPTION_SETS) {
			for (const [code, sourceType] of [
				[SCRIPT, "script"],
				[MODULE, "module"]
			]) {
				const program = WebpackParser.parse(code, {
					...options,
					sourceType: /** @type {"script" | "module"} */ (sourceType)
				});
				tree.reset();
				const rebuilt = toEstreeObject(tree, write(tree, program, seen));
				expect(firstDifference(rebuilt, program, "Program")).toBeNull();
			}
		}
		// Every type the tree knows, so a new one fails until a fixture has it.
		expect(seen.size).toBe(73);
	});

	it("writes a parsed tree whose parts were written first", () => {
		for (const options of OPTION_SETS) {
			const tree = new SyntaxTree();
			const program = /** @type {WrittenNode} */ (
				/** @type {unknown} */ (WebpackParser.parse(SCRIPT, options))
			);
			/**
			 * Writes each function body under a node first, innermost first, the
			 * body standing as its id, as a parser writing as it goes leaves it.
			 * @param {WrittenNode} node a parsed node
			 * @returns {void}
			 */
			const writeBodies = (node) => {
				for (const key of Object.keys(node)) {
					const value = node[key];
					const children = Array.isArray(value) ? value : [value];
					for (const child of children) {
						if (child && typeof child === "object" && "type" in child) {
							writeBodies(/** @type {WrittenNode} */ (child));
						}
					}
				}
				const body = /** @type {WrittenNode} */ (node.body);
				if (/Function/.test(node.type) && body.type === "BlockStatement") {
					node.body = tree.addEstree(asEstree(body));
				}
			};
			writeBodies(program);
			// A statement of a list written first stands as its id too.
			program.body = /** @type {WrittenNode[]} */ (program.body).map(
				(statement, index) =>
					index % 2 === 0 ? tree.addEstree(asEstree(statement)) : statement
			);
			const rebuilt = toEstreeObject(tree, tree.addEstree(asEstree(program)));
			expect(
				firstDifference(
					rebuilt,
					WebpackParser.parse(SCRIPT, options),
					"Program"
				)
			).toBeNull();
		}
	});

	it("writes an import or export an edition before attributes parsed", () => {
		const source = 'import a from "x"; export * from "y"; export { a };';
		const program = WebpackParser.parse(source, {
			ecmaVersion: 2020,
			sourceType: "module"
		});
		const tree = new SyntaxTree();
		const root = tree.addEstree(program);
		for (let i = 0; i < 3; i++) {
			const statement = tree.field(i, Field.body, root);
			expect(tree.fieldCount(Field.attributes, statement)).toBe(0);
			expect(
				/** @type {EXPECTED_ANY} */ (toEstreeObject(tree, statement)).attributes
			).toEqual([]);
		}
	});

	it("builds only the fields asked for, then the rest on the same object", () => {
		const { tree, node } = writeExpression("f(a, b);");
		const call = /** @type {EXPECTED_ANY} */ (
			toEstreeObject(tree, node, ["callee"])
		);
		expect(call.callee.name).toBe("f");
		expect("arguments" in call).toBe(false);
		expect(toEstreeObject(tree, node)).toBe(call);
		expect(
			call.arguments.map((/** @type {EXPECTED_ANY} */ arg) => arg.name)
		).toEqual(["a", "b"]);
		expect(call.optional).toBe(false);
		expect(toEstreeObject(tree, node, ["callee"])).toBe(call);
		expect(call.range).toEqual([0, 7]);
		call.range = [1, 6];
		expect(call.range).toEqual([1, 6]);
	});

	it("reads a literal's regex and bigint forms when asked for alone", () => {
		const regex = writeExpression("/a/g;");
		const literal = /** @type {EXPECTED_ANY} */ (
			toEstreeObject(regex.tree, regex.node, ["regex"])
		);
		expect(literal.regex).toEqual({ pattern: "a", flags: "g" });
		expect("value" in literal).toBe(false);
		const bigint = writeExpression("10n;");
		expect(
			/** @type {EXPECTED_ANY} */ (toEstreeObject(bigint.tree, bigint.node))
				.bigint
		).toBe("10");
	});

	it("clears a flag and starts over after reset", () => {
		const tree = new SyntaxTree();
		const member = tree.add(NodeType.MemberExpression, 0, 4);
		tree.set(member, "computed", true);
		tree.set(member, "computed", false);
		const before = /** @type {EXPECTED_ANY} */ (
			toEstreeObject(tree, member, ["computed"])
		);
		expect(before.computed).toBe(false);
		tree.reset();
		expect(tree.add(NodeType.ThisExpression, 0, 4)).toBe(member);
		expect(tree.type(member)).toBe(NodeType.ThisExpression);
		expect(toEstreeObject(tree, member)).not.toBe(before);
		expect(toEstreeObject(tree, 0)).toBeNull();
	});

	it("reads a field never set, or set to none, as empty", () => {
		const tree = new SyntaxTree();
		const block = tree.add(NodeType.BlockStatement, 0, 2);
		const name = tree.add(NodeType.Identifier, 0, 1);
		tree.set(name, "name", null);
		const statement = tree.add(NodeType.ExpressionStatement, 0, 2);
		tree.set(statement, "directive", undefined);
		expect(
			/** @type {EXPECTED_ANY} */ (toEstreeObject(tree, block)).body
		).toEqual([]);
		expect(
			/** @type {EXPECTED_ANY} */ (toEstreeObject(tree, name)).name
		).toBeNull();
		expect(
			"directive" in /** @type {EXPECTED_OBJECT} */ (toEstreeObject(tree, statement))
		).toBe(false);
		const literal = tree.add(NodeType.Literal, 0, 1);
		expect(tree.name(name)).toBe("");
		expect(tree.value(literal)).toBe("");
		expect(tree.textOf(Part.directive, statement)).toBeNull();
		expect(tree.fieldCount(Field.expression, statement)).toBe(0);
	});

	it("builds a tree nested deeper than the call stack", () => {
		const tree = new SyntaxTree();
		let node = tree.add(NodeType.Identifier, 0, 1);
		tree.set(node, "name", "a");
		for (let i = 0; i < 100000; i++) {
			const unary = tree.add(NodeType.UnaryExpression, 0, 1);
			tree.set(unary, "operator", "!");
			tree.set(unary, "prefix", true);
			tree.set(unary, "argument", node);
			node = unary;
		}
		let object = /** @type {EXPECTED_ANY} */ (toEstreeObject(tree, node));
		while (object.type === "UnaryExpression") object = object.argument;
		expect(object.name).toBe("a");
	});

	it("reads a node as the CSS and HTML paths read theirs", () => {
		const { tree, node } = writeExpression("a[b](1, /x/g, ...c);");
		expect(tree.type(node)).toBe(NodeType.CallExpression);
		expect(tree.range(node)).toEqual([0, 19]);
		expect(tree.flag(Flag.optional, node)).toBe(false);
		const callee = tree.field(0, Field.callee, node);
		expect(tree.fieldCount(Field.callee, node)).toBe(1);
		expect(tree.field(1, Field.callee, node)).toBe(0);
		expect(tree.type(callee)).toBe(NodeType.MemberExpression);
		expect(tree.flag(Flag.computed, callee)).toBe(true);
		expect(tree.flag(Flag.optional, callee)).toBe(false);
		expect(tree.name(tree.field(0, Field.object, callee))).toBe("a");
		expect(tree.fieldCount(Field.arguments, node)).toBe(3);
		const regex = tree.field(1, Field.arguments, node);
		expect(tree.value(regex)).toEqual(/x/g);
		expect(tree.textOf(Part.raw, regex)).toBe("/x/g");
		expect(tree.start(regex)).toBe(8);
		expect(tree.end(regex)).toBe(12);
		expect(tree.field(3, Field.arguments, node)).toBe(0);
		expect(tree.fieldCount(Field.body, node)).toBe(0);
		expect(tree.field(0, Field.body, node)).toBe(0);
		expect(tree.name(node)).toBe("");
		expect(tree.value(node)).toBe("");
		expect(tree.textOf(Part.operator, node)).toBeNull();
		const spread = tree.field(2, Field.arguments, node);
		expect(tree.name(tree.field(0, Field.argument, spread))).toBe("c");
	});

	/**
	 * @param {SyntaxTree} tree the tree to write
	 * @param {string} source the source
	 * @returns {number} its program
	 */
	const parseInto = (tree, source) =>
		/** @type {number} */ (
			/** @type {unknown} */ (
				new WebpackParser(
					{ ecmaVersion: "latest", lazyNodes: true, syntaxTree: tree },
					source
				).parse()
			)
		);

	it("hands a small tree's columns to the next tree, cleared", () => {
		const tree = new SyntaxTree();
		parseInto(tree, "x = { a: [b, c], [d]: `e${f}` };");
		const types = tree._types;
		const values = tree._values;
		tree.release();
		expect([tree._types.length, tree._values.length, tree._listCount]).toEqual([
			0, 0, 0
		]);
		expect(values.every((value) => value === undefined)).toBe(true);
		const next = new SyntaxTree();
		expect(next._types).toBe(types);
		expect(next._values).toBe(values);
		const source = "a(b, [c]);";
		const program = parseInto(next, source);
		const fresh = new SyntaxTree();
		expect(toEstreeObject(next, program)).toEqual(
			toEstreeObject(fresh, parseInto(fresh, source))
		);
		next.release();
	});

	it("keeps a list's items while an item written into it grows the column", () => {
		/**
		 * @param {string} source a module
		 * @returns {[SyntaxTree, number]} its tree and program
		 */
		const parseModule = (source) => {
			const tree = new SyntaxTree();
			const program = /** @type {number} */ (
				/** @type {unknown} */ (
					new WebpackParser(
						{
							ecmaVersion: "latest",
							sourceType: "module",
							lazyNodes: true,
							syntaxTree: tree
						},
						source
					).parse()
				)
			);
			return [tree, program];
		};
		const body = `var a, b;${"a;".repeat(40000)}`;
		// Large enough to be let go, it leaves the next tree its list room exactly:
		// the body's list fits, and the export's one more name does not.
		parseModule(`${body}export { a };`)[0].release();
		const [tree, program] = parseModule(`${body}export { a, b };`);
		const last = tree.field(
			tree.fieldCount(Field.body, program) - 1,
			Field.body,
			program
		);
		expect(tree.type(last)).toBe(NodeType.ExportNamedDeclaration);
		/** @type {string[]} */
		const names = [];
		for (let i = 0; i < tree.fieldCount(Field.specifiers, last); i++) {
			const specifier = tree.field(i, Field.specifiers, last);
			names.push(tree.name(tree.field(0, Field.local, specifier)));
		}
		expect(names).toEqual(["a", "b"]);
		tree.release();
	});

	it("lets go of a large tree's columns, and the next grows to its size", () => {
		const tree = new SyntaxTree();
		parseInto(tree, "a;".repeat(40000));
		const types = tree._types;
		const nodes = tree._count;
		tree.release();
		// A runtime that transfers an ArrayBuffer frees the old one at once.
		const detached =
			typeof (
				/** @type {ArrayBuffer & { transfer?: unknown }} */ (
					new ArrayBuffer(0)
				).transfer
			) === "function";
		expect(types.byteLength === 0).toBe(detached);
		const next = new SyntaxTree();
		expect(next._types).not.toBe(types);
		next.add(NodeType.Identifier, 0, 1);
		expect(next._types.length).toBe(nodes + 1);
	});

	it("refuses an unknown type or field", () => {
		const tree = new SyntaxTree();
		expect(() => tree.add(0, 0, 1)).toThrow(/Unknown node type/);
		const node = tree.add(NodeType.Identifier, 0, 1);
		expect(() => tree.set(node, "value", 1)).toThrow(/has no field value/);
	});
});

describe("JavaScript SourceProcessor", () => {
	const { SourceProcessor } = require("../../lib/javascript/syntax");

	/** @typedef {import("../../lib/javascript/syntax-parser").JavascriptPath} JavascriptPath */

	it("fires enter and exit in source order, a template's parts taking turns", () => {
		/** @type {string[]} */
		const events = [];
		/**
		 * @param {string} name what the event is named
		 * @returns {{ enter: (path: JavascriptPath) => void, exit: (path: JavascriptPath) => void }} visitors recording it
		 */
		const record = (name) => ({
			enter: (path) => {
				events.push(`${name}>${path.source()}@${path.index}`);
			},
			exit: () => {
				events.push(`${name}<`);
			}
		});
		new SourceProcessor()
			.use({
				[NodeType.CallExpression]: record("call"),
				[NodeType.TemplateLiteral]: record("template")
			})
			.use([NodeType.Identifier, NodeType.TemplateElement], (path) => {
				events.push(path.source());
			})
			.process("f(`a${b}c`, d);");
		expect(events).toEqual([
			"call>f(`a${b}c`, d)@0",
			"f",
			"template>`a${b}c`@1",
			"a",
			"b",
			"c",
			"template<",
			"d",
			"call<"
		]);
	});

	it("reads a node as the CSS and HTML paths read theirs", () => {
		const source =
			'import x from "y";\nlabel: for (const k of o) a?.[k];\u2028function f(z, y = 1) { return `t${z}`; }';
		/** @type {Record<string, unknown>} */
		const read = {};
		new SourceProcessor()
			.use({
				[NodeType.Program]: (path) => {
					read.programParent = path.parent;
					read.childTypes = path.children().map((child) => path.type(child));
					read.childCount = path.childCount();
					read.secondChild = path.type(path.child(1));
					read.pastLastChild = path.child(9);
					read.sourceType = path.textOf(Part.sourceType);
				},
				[NodeType.ImportDeclaration]: (path) => {
					read.importSource = path.value(path.field(0, Field.source));
					read.specifiers = path.fieldCount(Field.specifiers);
					read.withoutPart = [
						path.rangeOf(Part.raw),
						path.startOf(Part.raw),
						path.endOf(Part.raw)
					];
				},
				[NodeType.MemberExpression]: (path) => {
					read.member = [
						path.flag(Flag.computed),
						path.flag(Flag.optional),
						path.within(NodeType.ForOfStatement),
						path.within(NodeType.FunctionDeclaration),
						path.type(path.parent === null ? 0 : path.parent)
					];
				},
				[NodeType.FunctionDeclaration]: (path) => {
					read.functionRange = path.range();
					read.functionStart = path.start();
					read.functionEnd = path.end();
					read.functionLoc = path.loc();
					read.functionName = path.name(path.field(0, Field.id));
					read.functionNoName = path.name();
					read.functionNoValue = path.value();
					read.param = path.type(path.fieldNamed(Field.params, "z"));
					read.noParam = path.fieldNamed(Field.params, "w");
					read.between = path.source(path.start(), path.start() + 8);
				},
				[NodeType.Identifier]: (path) => {
					if (path.name() === "z") read.state = path.state;
				}
			})
			.process(source, { state: "run" });
		expect(read).toEqual({
			programParent: null,
			childTypes: [
				NodeType.ImportDeclaration,
				NodeType.LabeledStatement,
				NodeType.FunctionDeclaration
			],
			childCount: 3,
			secondChild: NodeType.LabeledStatement,
			pastLastChild: 0,
			sourceType: "module",
			importSource: "y",
			specifiers: 1,
			withoutPart: [null, -1, -1],
			member: [true, true, true, false, NodeType.ChainExpression],
			functionRange: [53, 93],
			functionStart: 53,
			functionEnd: 93,
			functionLoc: [3, 0, 3, 40],
			functionName: "f",
			functionNoName: "",
			functionNoValue: "",
			param: NodeType.Identifier,
			noParam: 0,
			between: "function",
			state: "run"
		});
	});

	it("skips a node's children, stops, and fires every visitor on the next run", () => {
		/** @type {string[]} */
		const names = [];
		const processor = new SourceProcessor().use({
			[NodeType.FunctionDeclaration]: (path) => path.skipChildren(),
			[NodeType.Identifier]: (path) => {
				names.push(path.name());
				if (path.name() === "stop") path.stop();
			}
		});
		processor.process("function f(a) { b; } c; stop; d;");
		processor.process("e;");
		expect(names).toEqual(["c", "stop", "e"]);
	});

	it("reads a script as a script, and refuses a walk inside a walk", () => {
		/** @type {number[]} */
		const types = [];
		const processor = new SourceProcessor().use({
			[NodeType.WithStatement]: (path) => {
				types.push(path.type());
				expect(() => processor.process("x;")).toThrow(/already running/);
			}
		});
		processor.process("with (o) x;", { sourceType: "script" });
		expect(types).toEqual([NodeType.WithStatement]);
		expect(() => processor.process("with (o) x;")).toThrow(SyntaxError);
		expect(() => processor.process("x;")).not.toThrow();
	});
});
