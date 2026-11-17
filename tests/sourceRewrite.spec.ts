import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	createSourceRewrite,
	type Piece,
	type RewriteCode,
	type RewriteOrigin,
	type RewriteSlice,
	type RewriteWriter,
	rewritePieceText,
	type SourceRewrite,
} from '../src';

const s = 's';
const setup = 'setup';
const other = 'other';

interface TestSource {
	name: string;
	content: string;
}

/** The fields of the kept pieces of a test rewrite. */
type TestData = { data: string };

type TestPiece = Piece<RewriteOrigin<TestSource, TestData>>;

/** A piece whose kept range names its source. */
type NamedPiece = Piece<{ source: TestSource | string; data: string }>;

/** Code that renders its pieces: a slice, or a view of a rewrite. */
interface Renders {
	render(sink: (piece: TestPiece) => void): void;
}

/** A source of pieces of generated code, which no rewrite edits. */
const otherSource: TestSource = { name: other, content: 'wxyz' };

function createRewrite(name: string, content: string) {
	return createSourceRewrite<TestSource, TestData>({ name, content });
}

/** The pieces of `slice`, as the render passes them. */
function renderPieces(slice: Renders) {
	const pieces: TestPiece[] = [];
	slice.render(piece => pieces.push(piece));
	return pieces;
}

/** The pieces of `slice`: text, and kept source ranges, by the name of their source, with the data of their cut. */
function collect(slice: Renders): NamedPiece[] {
	return renderPieces(slice).map(piece =>
		typeof piece === 'string' || piece.text !== undefined ? piece : { ...piece, source: piece.source.name }
	);
}

function toText(pieces: TestPiece[]) {
	return pieces.map(rewritePieceText).join('');
}

function render(slice: Renders) {
	return toText(renderPieces(slice));
}

/** The view `start`..`end` of `rewrite`, by default of the whole text. */
function view(
	rewrite: SourceRewrite<TestSource, TestData>,
	data = 'body',
	start = 0,
	end = rewrite.source.content.length,
): Renders {
	return { render: sink => rewrite.render(start, end, sink, { data }) };
}

function alphabet(length: number) {
	return Array.from({ length }, (_, index) => String.fromCharCode(97 + index)).join('');
}

/** A deterministic random integer below its argument. */
function createRandom(seed: number) {
	return (below: number) => {
		seed = (seed + 0x6d2b79f5) >>> 0;
		let t = seed;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
	};
}

/** The chars of `text` that the `removals` do not remove. */
function keptOffsets(length: number, removals: readonly [number, number][]) {
	return Array.from({ length }, (_, index) => index)
		.filter(index => !removals.some(([start, end]) => start <= index && index < end));
}

/** Every kept piece is a copy, not empty; returns the source offsets of the rendered chars, in output order. */
function renderedOffsets(rewrite: SourceRewrite<TestSource, TestData>, pieces: TestPiece[]) {
	return pieces.flatMap(piece => {
		if (typeof piece === 'string') {
			return [];
		}
		expect(piece).not.toHaveProperty('text');
		expect(piece.source).toBe(rewrite.source);
		expect(piece.end).toBeGreaterThan(piece.start);
		return Array.from({ length: piece.end - piece.start }, (_, index) => piece.start + index);
	});
}

/** No kept piece continues the one right before it with the same data: a run is split only where something is. */
function expectMinimalRuns(pieces: TestPiece[]) {
	for (let index = 1; index < pieces.length; index++) {
		const previous = pieces[index - 1]!;
		const piece = pieces[index]!;
		if (typeof previous !== 'string' && typeof piece !== 'string' && previous.text === undefined) {
			expect(piece.text !== undefined || piece.data !== previous.data || piece.start !== previous.end).toBe(true);
		}
	}
}

function defineProps(text: string, statement = 'const') {
	const rewrite = createRewrite(setup, text);
	const body = view(rewrite);
	const typeArg = { start: text.indexOf('{'), end: text.lastIndexOf('}') + 1 };
	const alias = rewrite.cut(typeArg.start, typeArg.end, { data: 'alias', placeholder: '__VLS_Props' });
	rewrite.insertBefore(text.indexOf(statement), ['type __VLS_Props = ', alias, ';\n']);
	return { rewrite, body, typeArg };
}

describe('scenarios', () => {
	test('the rewrite moves a type argument into an alias', () => {
		const { body } = defineProps('const props = defineProps<{ a: string }>();');
		expect(render(body)).toBe('type __VLS_Props = { a: string };\nconst props = defineProps<__VLS_Props>();');
	});

	test('an insert after the start of a moved range stays at its origin', () => {
		const { rewrite, body, typeArg } = defineProps('const props = defineProps<{ a: string }>();');
		const plugin = rewrite.writer(1);
		plugin.insertAfter(typeArg.start, '/* a */');
		plugin.insertAfter(typeArg.start, '/* b */');
		expect(render(body)).toBe(
			'type __VLS_Props = { a: string };\nconst props = defineProps</* a *//* b */__VLS_Props>();',
		);
	});

	test('inserts on the inner sides of a moved range travel with it', () => {
		const { rewrite, body, typeArg } = defineProps('const props = defineProps<{ a: string }>();');
		rewrite.writer(1).insertBefore(typeArg.start, 'Wrap<');
		rewrite.writer(1).insertAfter(typeArg.end, '>');
		expect(render(body)).toBe('type __VLS_Props = Wrap<{ a: string }>;\nconst props = defineProps<__VLS_Props>();');
	});

	test('a replace inside a moved range applies to the moved text, which stays verbatim', () => {
		const text = 'const props = defineProps<{ a: string }>();';
		const { rewrite, body } = defineProps(text);
		const start = text.indexOf('string');
		rewrite.writer(1).replace(start, start + 'string'.length, 'number');
		const segments = renderPieces(body);
		expect(toText(segments)).toBe('type __VLS_Props = { a: number };\nconst props = defineProps<__VLS_Props>();');
		renderedOffsets(rewrite, segments);
	});

	test('nested replaces of two writers keep both codes at their own starts, whatever the ranks', () => {
		const text = 'const a = useFoo();';
		const call = text.indexOf('useFoo()');
		const name = text.indexOf('Foo');
		const edits = [
			(writer: RewriteWriter<TestSource, TestData>) => writer.replace(call, call + 'useFoo()'.length, 'first()'),
			(writer: RewriteWriter<TestSource, TestData>) => writer.replace(name, name + 'Foo'.length, 'Second'),
		];
		for (const order of [[0, 1], [1, 0]]) {
			const rewrite = createRewrite(s, text);
			const body = view(rewrite);
			order.forEach((edit, rank) => edits[edit]!(rewrite.writer(rank + 1)));
			expect(render(body)).toBe('const a = first()Second;');
		}
	});

	test('replaces of one range by two writers keep both codes, inner rank first', () => {
		const text = 'const a = useFoo();';
		const rewrite = createRewrite(s, text);
		const body = view(rewrite);
		const call = text.indexOf('useFoo()');
		rewrite.writer(1).replace(call, call + 8, 'A()');
		rewrite.writer(2).replace(call, call + 8, 'B()');
		expect(render(body)).toBe('const a = A()B();');
	});

	test('wraps of two writers nest, the lower rank inside', () => {
		const rewrite = createRewrite(s, 'x = f();');
		const body = view(rewrite);
		rewrite.writer(1).insertBefore(4, 'A(');
		rewrite.writer(1).insertAfter(7, ')');
		rewrite.writer(2).insertBefore(4, 'B(');
		rewrite.writer(2).insertAfter(7, ')');
		expect(render(body)).toBe('x = B(A(f()));');
	});

	test('an insert at a boundary of two views goes by its side, and a removal across them splits', () => {
		const text = `import { a } from 'a';\nconst b = a;`;
		const rewrite = createRewrite(s, text);
		const importEnd = text.indexOf('\n') + 1;
		const imports = view(rewrite, 'imports', 0, importEnd);
		const body = view(rewrite, 'body', importEnd);
		const plugin = rewrite.writer(1);
		plugin.insertAfter(importEnd, '/*end of imports*/');
		plugin.insertBefore(importEnd, '/*start of body*/');
		plugin.replace(text.indexOf(`'a';`), text.indexOf('const') + 'const'.length, `'b'; let`);
		expect([render(imports), render(body)]).toEqual([
			`import { a } from 'b'; let/*end of imports*/`,
			'/*start of body*/ b = a;',
		]);
	});

	test('a replace of the first token of a statement keeps the insert of the rewrite before it', () => {
		const { rewrite, body } = defineProps('const props = defineProps<{ a: string }>();');
		rewrite.writer(1).replace(0, 5, 'let');
		expect(render(body)).toBe('type __VLS_Props = { a: string };\nlet props = defineProps<__VLS_Props>();');
	});

	test('inserts of the rewrite sit outside the inserts of other writers', () => {
		const rewrite = createRewrite(s, 'useAttrs();');
		const body = view(rewrite);
		rewrite.insertBefore(0, '(');
		rewrite.insertAfter(10, ' as A)');
		rewrite.writer(0).insertBefore(0, 'P(');
		rewrite.writer(0).insertAfter(10, ')');
		expect(render(body)).toBe('(P(useAttrs()) as A);');
	});

	test('a run maps with the data of the innermost cut that owns it', () => {
		const { body } = defineProps('const props = defineProps<{ a: string }>();');
		expect(collect(body)).toEqual([
			'type __VLS_Props = ',
			{ source: setup, start: 26, end: 39, data: 'alias' },
			';\n',
			{ source: setup, start: 0, end: 26, data: 'body' },
			'__VLS_Props',
			{ source: setup, start: 39, end: 43, data: 'body' },
		]);
	});

	test('pieces of generated code pass through as they are', () => {
		const rewrite = createRewrite(s, 'ab');
		const body = view(rewrite);
		const mapped = { source: otherSource, start: 3, end: 4, data: 'mapped', text: 'x' };
		rewrite.insertAfter(1, [mapped, [[''], 'y']]);
		const pieces = collect(body);
		expect(pieces).toEqual([
			{ source: s, start: 0, end: 1, data: 'body' },
			mapped,
			'y',
			{ source: s, start: 1, end: 2, data: 'body' },
		]);
		expect(pieces[1]).toBe(mapped);
	});

	test('a render passes every piece to the sink, a kept one without text', () => {
		const rewrite = createRewrite(s, 'ab');
		rewrite.insertBefore(1, ['x', { source: otherSource, start: 0, end: 0, data: 'mapped', text: 'y' }]);
		expect(collect(view(rewrite))).toStrictEqual([
			{ source: s, start: 0, end: 1, data: 'body' },
			'x',
			{ source: otherSource, start: 0, end: 0, data: 'mapped', text: 'y' },
			{ source: s, start: 1, end: 2, data: 'body' },
		]);
	});

	test('a slice of another rewrite renders the text and edits of its own rewrite', () => {
		const inner = createRewrite(other, 'xyz');
		inner.writer(0).replace(1, 2, 'Y');
		const slice = inner.cut(0, 3, { data: 'inner' });
		const rewrite = createRewrite(s, 'abc');
		rewrite.writer(0).replace(0, 1, 'A');
		const body = view(rewrite);
		rewrite.insertAfter(2, slice);
		expect(collect(body)).toEqual([
			'A',
			{ source: s, start: 1, end: 2, data: 'body' },
			{ source: other, start: 0, end: 1, data: 'inner' },
			'Y',
			{ source: other, start: 2, end: 3, data: 'inner' },
			{ source: s, start: 2, end: 3, data: 'body' },
		]);
	});

	test('a cut of another copy of the package, such as its CommonJS build, is a slice', () => {
		const cjs: typeof import('../src') = createRequire(__filename)('../out/cjs/index.js');
		const inner = cjs.createSourceRewrite<TestSource, TestData>({ name: other, content: 'xyz' });
		const rewrite = createRewrite(s, 'ab');
		rewrite.insertAfter(1, inner.cut(0, 3, { data: 'inner' }));
		expect(render(view(rewrite))).toBe('axyzb');
	});

	test('only cut makes a slice: any other object in code is a piece, which the edit refuses unless it is a range', () => {
		const rewrite = createRewrite(s, 'ab');
		const renders = {
			render() {
				throw new Error('Only a cut renders.');
			},
		};
		// @ts-expect-error only cut makes a slice
		expect(() => rewrite.insertAfter(1, renders)).toThrow(
			new TypeError(
				'insertAfter(1, code): code is an object without a start and an end, which is not code: a string, a range, a slice or an array of them.',
			),
		);
		expect(collect(view(rewrite))).toEqual([{ source: s, start: 0, end: 2, data: 'body' }]);
	});

	test('a range is a piece whatever fields it carries', () => {
		const rewrite = createRewrite(s, 'abc');
		const range = {
			source: rewrite.source,
			start: 1,
			end: 2,
			text: 'X',
			data: 'range',
			render() {
				throw new Error('A range does not render.');
			},
		};
		rewrite.replace(1, 2, range);
		const pieces = renderPieces(view(rewrite));
		expect(pieces).toEqual([
			{ source: rewrite.source, start: 0, end: 1, data: 'body' },
			range,
			{ source: rewrite.source, start: 2, end: 3, data: 'body' },
		]);
		expect(pieces[1]).toBe(range);

		const source = { content: 'abc' };
		const flagged = createSourceRewrite<typeof source, { render: boolean }>(source);
		flagged.replace(1, 2, { source, start: 1, end: 2, text: 'X', render: false });
		const texts: string[] = [];
		flagged.render(0, 3, piece => texts.push(rewritePieceText(piece)), { render: true });
		expect(texts).toEqual(['a', 'X', 'c']);
	});

	test('removals of two writers that overlap the edges of a moved cut remove the chars of both cuts', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const body = view(rewrite);
		rewrite.insertAfter(8, rewrite.cut(2, 6, { data: 'inner', placeholder: 'P' }));
		rewrite.writer(0).replace(1, 4, 'X');
		rewrite.writer(1).replace(3, 7, 'Y');
		expect(render(body)).toBe('aXPhY');
	});
});

describe('order', () => {
	test('the entries of one writer at one side of a char keep call order', () => {
		const rewrite = createRewrite(s, 'abc');
		const body = view(rewrite);
		rewrite.insertAfter(1, 'A');
		rewrite.insertBefore(2, 'B');
		rewrite.insertAfter(1, 'C');
		rewrite.insertBefore(2, 'D');
		expect(render(body)).toBe('aACbBDc');
	});

	test('edits and removals of one writer that arrive out of order render in order, equal keys in call order', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = view(rewrite);
		const writer = rewrite.writer(0);
		writer.insertAfter(4, 'A');
		writer.replace(4, 5, 'R');
		writer.insertBefore(1, 'B');
		writer.insertAfter(4, 'C');
		writer.replace(1, 2, 'S');
		writer.insertBefore(1, 'D');
		expect(render(body)).toBe('aBDScdACRf');
	});

	test('the order at a char: before by rank descending, replacement, the char, after by rank ascending', () => {
		const rewrite = createRewrite(s, 'abc');
		const body = view(rewrite);
		for (const rank of [0, 1]) {
			const writer = rewrite.writer(rank);
			writer.insertBefore(1, `<${rank}`);
			writer.insertAfter(2, `>${rank}`);
		}
		rewrite.writer(1).replace(1, 2, 'R1');
		rewrite.writer(0).replace(1, 2, 'R0');
		rewrite.insertBefore(1, '<c');
		rewrite.insertAfter(2, '>c');
		expect(render(body)).toBe('a<c<1<0R0R1>0>1>cc');
	});
});

describe('text edges', () => {
	test('code at the end of the text stays after all text when a cut that ends there moves', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const body = view(rewrite);
		const last = rewrite.cut(5, 8, { data: 'last' });
		rewrite.insertAfter(0, last);
		rewrite.insertBefore(8, 'X');
		rewrite.insertAfter(8, 'Y');
		expect(render(body)).toBe('fghYabcdeX');
	});

	test('code at the start of the text stays before all text when a cut that starts there moves', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const body = view(rewrite);
		const first = rewrite.cut(0, 3, { data: 'first' });
		rewrite.insertBefore(8, first);
		rewrite.insertAfter(0, 'X');
		rewrite.insertBefore(0, 'Y');
		expect(render(body)).toBe('XdefghYabc');
	});

	test('head code renders by rank descending and tail code by rank ascending', () => {
		const rewrite = createRewrite(s, 'ab');
		const body = view(rewrite);
		for (const [name, writer] of [['0', rewrite.writer(0)], ['c', rewrite], ['1', rewrite.writer(1)]] as const) {
			writer.insertAfter(0, `h${name}`);
			writer.insertBefore(2, `t${name}`);
		}
		expect(render(body)).toBe('hch1h0abt0t1tc');
	});

	test('code before all text renders in a view from 0, and code after all text in a view to the end', () => {
		const rewrite = createRewrite(s, 'abc');
		rewrite.insertAfter(0, 'H');
		rewrite.insertBefore(0, 'B');
		rewrite.insertAfter(3, 'A');
		rewrite.insertBefore(3, 'T');
		const views = [[0, 0], [0, 3], [1, 2], [3, 3]] as const;
		expect(views.map(([start, end]) => render(view(rewrite, 'v', start, end)))).toEqual(['H', 'HBabcAT', 'b', 'T']);
	});

	test('an empty text renders its inserts in a view, after code before code', () => {
		const rewrite = createRewrite(s, '');
		rewrite.insertBefore(0, 'B1');
		rewrite.writer(0).insertAfter(0, 'A0');
		rewrite.insertAfter(0, 'A1');
		rewrite.insertBefore(0, 'B2');
		expect(collect(view(rewrite))).toEqual(['A1', 'A0', 'B1', 'B2']);
	});
});

describe('runs', () => {
	test('a removal next to a run boundary or an insert renders no empty run', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = view(rewrite);
		const writer = rewrite.writer(0);
		writer.replace(0, 2, 'X');
		writer.insertBefore(2, 'Y');
		writer.replace(4, 6, '');
		expect(collect(body)).toEqual(['X', 'Y', { source: s, start: 2, end: 4, data: 'body' }]);
	});

	test('a text without edits renders as one run', () => {
		const rewrite = createRewrite(s, 'abc');
		expect(collect(view(rewrite))).toEqual([{ source: s, start: 0, end: 3, data: 'body' }]);
	});

	test('a slice that is not placed does not render, with the code in it, which unrendered tells whatever renders', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = view(rewrite);
		const placed = rewrite.cut(0, 1, { data: 'placed' });
		const unplaced = rewrite.cut(2, 4, { data: 'unplaced' });
		rewrite.insertBefore(0, 'x');
		rewrite.insertBefore(3, 'y');
		rewrite.insertAfter(6, ['z', placed]);
		expect(rewrite.unrendered()).toEqual([unplaced]);
		// the code before the char 0 is of the slice that holds it
		expect(render(body)).toBe('befzxa');
		expect(render(unplaced)).toBe('cyd');
		expect(rewrite.unrendered()).toEqual([unplaced]);
	});

	test('unrendered tells the slices that no view reaches from where they are placed', () => {
		const rewrite = createRewrite(s, 'abcdefghij');
		const lost = rewrite.cut(0, 2, { data: 'lost' });
		const inLost = rewrite.cut(2, 3, { data: 'inLost' });
		const inBoth = rewrite.cut(3, 4, { data: 'inBoth' });
		const inPlaceholder = rewrite.cut(6, 7, { data: 'inPlaceholder' });
		// in the code of a slice that is placed nowhere
		rewrite.insertBefore(1, [inLost, inBoth]);
		expect(rewrite.unrendered()).toEqual([lost, inLost, inBoth, inPlaceholder]);
		// in code that a view renders too
		rewrite.insertBefore(9, inBoth);
		expect(rewrite.unrendered()).toEqual([lost, inLost, inPlaceholder]);
		// in the placeholder of a cut out of all cuts, which a view renders
		const outer = rewrite.cut(7, 8, { data: 'outer', placeholder: inPlaceholder });
		expect(rewrite.unrendered()).toEqual([lost, inLost, outer]);
		// a later cut around a place makes its own render the renderer of the code there
		const around = rewrite.cut(5, 10, { data: 'around' });
		expect(rewrite.unrendered()).toEqual([lost, inLost, inBoth, inPlaceholder, outer, around]);
		// in another rewrite, whose view renders it
		const other = createRewrite('other', 'xy');
		other.insertBefore(1, around);
		expect(rewrite.unrendered()).toEqual([lost, inLost, outer]);
		rewrite.insertAfter(0, lost);
		expect(rewrite.unrendered()).toEqual([outer]);
		expect(render(view(other))).toBe('xfgidjy');
	});

	test('a cut that is placed in code in a cut placed elsewhere renders there', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = view(rewrite);
		const outer = rewrite.cut(1, 5, { data: 'outer', placeholder: 'O' });
		const inner = rewrite.cut(2, 3, { data: 'inner', placeholder: 'I' });
		rewrite.insertAfter(3, ['[', outer, ']']);
		rewrite.insertBefore(6, ['{', inner, '}']);
		expect(render(body)).toBe('aOf{c[bIde]}');
	});
});

describe('construction errors', () => {
	test('cuts in any order nest by range: a later cut around earlier ones holds them', () => {
		const rewrite = createRewrite(s, 'abcdefg');
		const a = rewrite.cut(0, 1, { data: 'a', placeholder: '<a>' });
		const c = rewrite.cut(3, 4, { data: 'c', placeholder: '<c>' });
		const b = rewrite.cut(2, 5, { data: 'b', placeholder: '<b>' });
		rewrite.insertBefore(7, [a, b, c]);
		expect(render(view(rewrite))).toBe('<a>b<b>fgac<c>ed');
	});

	test('of two cuts of one range, the later is inside the earlier', () => {
		const rewrite = createRewrite(s, 'abc');
		const outer = rewrite.cut(0, 3, { data: 'outer' });
		const inner = rewrite.cut(0, 3, { data: 'inner', placeholder: 'P' });
		expect(collect(outer)).toEqual(['P']);
		expect(collect(inner)).toEqual([{ source: s, start: 0, end: 3, data: 'inner' }]);
	});

	test('a cut that crosses another, out of the text or of no char is an error', () => {
		const rewrite = createRewrite(s, 'abcdef');
		rewrite.cut(1, 3, { data: 'a' });
		rewrite.cut(1, 2, { data: 'inner' });
		expect(() => rewrite.cut(2, 4, { data: 'b' })).toThrow('The cut 2..4 crosses the cut 1..3.');
		expect(() => rewrite.cut(0, 2, { data: 'b' })).toThrow('The cut 0..2 crosses the cut 1..3.');
		expect(() => rewrite.cut(2, 7, { data: 'b' })).toThrow('The range 2..7 is out of 0..6.');
		expect(() => rewrite.cut(4, 4, { data: 'b' })).toThrow('The cut at 4 moves no char.');
		rewrite.cut(0, 3, { data: 'b' });
		rewrite.cut(3, 5, { data: 'b' });
	});

	test('a rewrite whose pieces carry no fields beyond their source takes none in its cuts and views', () => {
		const source = { content: 'abc' };
		const rewrite = createSourceRewrite(source);
		expect(rewrite.source).toBe(source);
		const moved = rewrite.cut(1, 2);
		rewrite.replace(0, 1, { source, start: 0, end: 1, text: 'A' });
		rewrite.insertBefore(3, moved);
		const pieces: Piece<RewriteOrigin<typeof source, {}>>[] = [];
		rewrite.render(0, 3, piece => pieces.push(piece));
		expect(pieces.map(rewritePieceText).join('')).toBe('Acb');
	});

	test('an edit or a cut that places a cut in code that only its own render renders is an error, which changes nothing', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const cut = rewrite.cut(1, 4, { data: 'cut' });
		const never = 'would be placed inside itself, so it would never render.';
		expect(() => rewrite.insertBefore(2, ['x', cut])).toThrow(new Error(`insertBefore(2, code): the cut 1..4 ${never}`));
		expect(() => rewrite.writer(0).replace(2, 3, cut)).toThrow(`replace(2, 3, code): the cut 1..4 ${never}`);
		expect(() => rewrite.insertBefore(1, cut)).toThrow(
			`insertBefore(1, code): the cut 1..4 ${never} To place it before its cut, use insertAfter(1, code).`,
		);
		expect(() => rewrite.insertAfter(4, cut)).toThrow(
			`insertAfter(4, code): the cut 1..4 ${never} To place it after its cut, use insertBefore(4, code).`,
		);
		expect(rewrite.unrendered()).toEqual([cut]);
		rewrite.insertAfter(1, cut);
		expect(render(view(rewrite))).toBe('abcdef');
		rewrite.insertBefore(4, '!');
		expect(render(view(rewrite))).toBe('abcd!ef');

		const inOwnPlaceholder = createRewrite(s, 'abcdef');
		const outer = inOwnPlaceholder.cut(1, 5, { data: 'outer' });
		expect(() => inOwnPlaceholder.cut(2, 3, { data: 'inner', placeholder: ['(', outer, ')'] })).toThrow(
			`cut(2, 3, options): the cut 1..5 would be placed inside itself by the placeholder, so it would never render.`,
		);
		expect(inOwnPlaceholder.unrendered()).toEqual([outer]);
		inOwnPlaceholder.insertBefore(6, outer);
		expect(render(view(inOwnPlaceholder))).toBe('afbcde');

		const inEachOther = createRewrite(s, 'abcdef');
		const whole = inEachOther.cut(0, 6, { data: 'whole' });
		const first = inEachOther.cut(1, 2, { data: 'first' });
		const second = inEachOther.cut(3, 4, { data: 'second' });
		inEachOther.insertBefore(1, second);
		expect(() => inEachOther.insertBefore(3, first)).toThrow(`insertBefore(3, code): the cut 1..2 ${never}`);
		expect(render(whole)).toBe('acef');
	});

	test('a cut that its own render would place is an error of the edit, also across rewrites and copies of the package', () => {
		const never = 'would be placed inside itself, so it would never render.';
		const a = createRewrite(s, 'abc');
		const b = createRewrite(other, 'xyz');
		const aCut = a.cut(0, 3, { data: 'a' });
		const bCut = b.cut(0, 3, { data: 'b' });
		a.insertBefore(1, bCut);
		expect(() => b.insertBefore(1, aCut)).toThrow(`insertBefore(1, code): the cut 0..3 ${never}`);
		expect(render(aCut)).toBe('axyzbc');

		const cjs: typeof import('../src') = createRequire(__filename)('../out/cjs/index.js');
		const c = cjs.createSourceRewrite<TestSource, TestData>({ name: other, content: 'xyz' });
		const cCut = c.cut(0, 3, { data: 'c' });
		c.insertBefore(1, aCut);
		expect(() => a.insertBefore(2, cCut)).toThrow(`insertBefore(2, code): the cut 0..3 ${never}`);
		expect(c.unrendered()).toEqual([cCut]);
		const later = createRewrite(other, 'uv');
		later.cut(0, 2, { data: 'd', placeholder: cCut });
		expect(c.unrendered()).toEqual([]);
	});

	test('a slice of a copy of the package that records no places, as of 1.0.4, is a slice, and a cut is one for it', () => {
		const rewrite = createRewrite(s, 'abc');
		const brand = Symbol.for('muggle-string.slice');
		const old = {
			[brand]: true,
			render(sink: (piece: TestPiece) => void) {
				sink('old');
			},
		} as unknown as RewriteSlice<TestSource, TestData>;
		rewrite.insertBefore(1, old);
		rewrite.cut(2, 3, { data: 'cut', placeholder: ['<', old, '>'] });
		expect(render(view(rewrite))).toBe('aoldb<old>');
		expect((rewrite.cut(0, 1, { data: 'cut' }) as unknown as Record<symbol, unknown>)[brand]).toBe(true);
	});

	test('a slice and a view render as often as they are rendered or placed', () => {
		const rewrite = createRewrite(s, 'abc');
		const body = rewrite.cut(0, 3, { data: 'body' });
		expect([render(body), render(body)]).toEqual(['abc', 'abc']);

		const twice = createRewrite(s, 'abc');
		const moved = twice.cut(1, 2, { data: 'moved' });
		twice.insertBefore(0, moved);
		twice.insertBefore(3, moved);
		expect([render(view(twice)), render(view(twice))]).toEqual(['bacb', 'bacb']);
		expect(twice.unrendered()).toEqual([]);
	});

	test('an edit after a render renders in the next render', () => {
		const rewrite = createRewrite(s, 'abc');
		const slice = rewrite.cut(1, 2, { data: 'moved' });
		rewrite.insertBefore(0, slice);
		expect(render(view(rewrite))).toBe('bac');
		rewrite.insertBefore(1, '(');
		rewrite.insertAfter(2, ')');
		rewrite.replace(2, 3, 'C');
		expect(render(view(rewrite))).toBe('(b)aC');
		expect(render(slice)).toBe('(b)');
		const inner = rewrite.cut(0, 1, { data: 'inner' });
		rewrite.insertBefore(3, inner);
		expect(render(view(rewrite))).toBe('C(b)a');
	});

	test('an edit while the rewrite renders is an error', () => {
		const rewrite = createRewrite(s, 'abc');
		const slice = rewrite.cut(1, 2, { data: 'moved' });
		const message = 'The rewrite is rendering.';
		expect(() => rewrite.render(0, 3, () => rewrite.insertBefore(0, 'x'), { data: 'v' })).toThrow(message);
		expect(() => slice.render(() => rewrite.writer(0).replace(0, 1, 'x'))).toThrow(message);
		expect(() => rewrite.render(0, 3, () => rewrite.cut(0, 1, { data: 'late' }), { data: 'v' })).toThrow(message);
		expect(render(view(rewrite))).toBe('ac');
	});

	test('a render after the content of the source changed is an error', () => {
		const source = { name: s, content: 'abc' };
		const rewrite = createSourceRewrite<TestSource, TestData>(source);
		const slice = rewrite.cut(0, 1, { data: 'cut' });
		source.content = 'abd';
		const message = 'The content of the source changed after the rewrite was made.';
		expect(() => render(view(rewrite))).toThrow(message);
		expect(() => render(slice)).toThrow(message);
		source.content = 'abc';
		expect(render(view(rewrite))).toBe('bc');
	});

	test('a replace of an empty range removes nothing and puts its code at the char, inside the inserts there', () => {
		const rewrite = createRewrite(s, 'ab');
		rewrite.replace(1, 1, 'R');
		rewrite.insertBefore(1, 'B');
		rewrite.writer(0).insertBefore(1, 'b');
		rewrite.insertAfter(1, 'A');
		rewrite.replace(2, 2, 'E');
		rewrite.insertBefore(2, 'T');
		rewrite.replace(0, 0, '');
		expect(render(view(rewrite))).toBe('aABbRbET');
		expect(render(view(rewrite, 'v', 1, 2))).toBe('BbRbET');
	});

	test('the text of a kept range that is not an integer range of the content of its source, or has no source, is an error', () => {
		const source = { content: 'abc' };
		for (const [start, end] of [[-1, 2], [1.5, 2], [3, 2], [0, 4], [Number.NaN, 2]]) {
			expect(() => rewritePieceText({ source, start: start!, end: end! })).toThrow(
				`The range ${start}..${end} is out of 0..3.`,
			);
		}
		expect(() => rewritePieceText({ start: 0, end: 1 } as Parameters<typeof rewritePieceText>[0])).toThrow(
			'The range 0..1 has no source.',
		);
		expect(() => rewritePieceText({ source: {}, start: 0, end: 1 } as Parameters<typeof rewritePieceText>[0])).toThrow(
			'The range 0..1 has no source.',
		);
		expect(rewritePieceText({ source, start: 0, end: 3, text: 'x' })).toBe('x');
		expect(rewritePieceText({ source, start: 3, end: 3 })).toBe('');
	});

	test('code that no render takes is an error of the edit that writes it, which then changes nothing', () => {
		const rewrite = createRewrite(s, 'abc');
		const source = rewrite.source;
		const notCode = 'which is not code: a string, a range, a slice or an array of them.';
		const writes: [() => void, Error][] = [
			// @ts-expect-error undefined is no code
			[() => rewrite.insertBefore(1, undefined), new TypeError(`insertBefore(1, code): code is undefined, ${notCode}`)],
			// @ts-expect-error null is no code
			[() => rewrite.insertAfter(1, ['x', null]), new TypeError(`insertAfter(1, code): code[1] is null, ${notCode}`)],
			// @ts-expect-error a number is no code
			[() => rewrite.replace(1, 2, [[false, 'x'], 5]), new TypeError(`replace(1, 2, code): code[0][0] is false, ${notCode}`)],
			// @ts-expect-error a function is no code
			[() => rewrite.insertBefore(0, () => 'x'), new TypeError(`insertBefore(0, code): code is a function, ${notCode}`)],
			[
				() => rewrite.replace(0, 3, ['C', { source, start: 2, end: 4, data: 'range' }]),
				new RangeError('replace(0, 3, code): code[1], the range 2..4, is out of 0..3.'),
			],
			[
				() => rewrite.replace(1, 1, [[{ start: 0, end: 1, data: 'range' } as unknown as TestPiece]]),
				new TypeError('replace(1, 1, code): code[0][0], the range 0..1, has no source.'),
			],
			[
				// @ts-expect-error a number is no code
				() => rewrite.cut(1, 2, { data: 'cut', placeholder: ['<', 0] }),
				new TypeError(`cut(1, 2, options): the placeholder[1] is 0, ${notCode}`),
			],
		];
		for (const [write, error] of writes) {
			expect(write).toThrow(error);
		}
		const holdsItself: RewriteCode<TestSource, TestData>[] = ['x'];
		holdsItself.push(holdsItself);
		expect(() => rewrite.insertBefore(1, holdsItself)).toThrow(RangeError);
		expect(collect(view(rewrite))).toEqual([{ source: s, start: 0, end: 3, data: 'body' }]);
		expect(rewrite.unrendered()).toEqual([]);
	});

	test('an edit takes and refuses the ranges that rewritePieceText takes and refuses, with text or without', () => {
		const rewrite = createRewrite(s, 'abc');
		const source = rewrite.source;
		const named = createSourceRewrite<TestSource, TestData & { name?: string }>(source);
		named.insertBefore(1, { source, start: 0, end: 3, data: 'range', text: 'X', name: 'x' });
		named.insertBefore(2, { source: otherSource, start: 4, end: 4, data: 'range', text: 'Y' });
		named.insertBefore(3, { source, start: 3, end: 3, data: 'range', text: undefined, name: undefined });
		const texts: string[] = [];
		named.render(0, 3, piece => texts.push(rewritePieceText(piece)), { data: 'v' });
		expect(texts.join('')).toBe('aXbYc');
		const bad = [
			{ source, start: 0, end: 50, text: 'x' },
			{ source, start: -1, end: 1, text: '' },
			{ start: 0, end: 1, text: 'x' },
			{ source: null, start: 0, end: 1, text: 'x' },
			{ source, start: 0, end: 1, text: null },
			{ source, start: 0, end: 1, text: 5 },
			{ source, start: 0, end: 1, text: 'x', name: null },
			{ source, start: 0, end: 1, name: 5 },
		] as unknown as TestPiece[];
		rewrite.insertBefore(1, 'X');
		for (const range of bad) {
			const problem = (() => {
				try {
					rewritePieceText(range);
				}
				catch (error) {
					return (error as Error).message.replace(/^The range (\S+) /, 'the range $1, ');
				}
			})();
			expect(problem).toBeDefined();
			expect(() => rewrite.replace(1, 2, ['x', { ...range as object, data: 'range' } as TestPiece])).toThrow(
				`replace(1, 2, code): code[1], ${problem}`,
			);
		}
		expect(render(view(rewrite))).toBe('aXbc');
	});

	test('code is read when it is written: a later change of its array or of a placeholder array changes no render', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const code: RewriteCode<TestSource, TestData>[] = ['<', ['', '>']];
		rewrite.insertBefore(0, code);
		code.push('!');
		(code[1] as RewriteCode<TestSource, TestData>[]).length = 0;
		const placeholder: RewriteCode<TestSource, TestData>[] = ['(', ')'];
		const slice = rewrite.cut(2, 4, { data: 'cut', placeholder });
		placeholder.splice(1, 0, slice);
		expect(render(view(rewrite))).toBe('<>ab()ef');
		expect(render(slice)).toBe('cd');
	});

	test('empty code is code: an edit of it checks its offsets, removes its range and splits the text as an edit does', () => {
		for (const empty of ['', [], ['', ['']]] as RewriteCode<TestSource, TestData>[]) {
			const rewrite = createRewrite(s, 'abcdef');
			rewrite.replace(1, 3, empty);
			rewrite.insertBefore(4, empty);
			rewrite.writer(0).insertAfter(5, empty);
			expect(() => rewrite.insertBefore(7, empty)).toThrow('The offset 7 is out of 0..6.');
			expect(() => rewrite.render(0, 6, () => rewrite.replace(0, 1, empty), { data: 'v' })).toThrow(
				'The rewrite is rendering.',
			);
			expect(collect(view(rewrite))).toEqual([
				{ source: s, start: 0, end: 1, data: 'body' },
				{ source: s, start: 3, end: 4, data: 'body' },
				{ source: s, start: 4, end: 5, data: 'body' },
				{ source: s, start: 5, end: 6, data: 'body' },
			]);
		}
	});

	test('offsets out of the text and an invalid rank are errors', () => {
		const rewrite = createRewrite(s, 'abc');
		expect(() => rewrite.insertBefore(4, 'x')).toThrow('The offset 4 is out of 0..3.');
		expect(() => rewrite.writer(0).replace(2, 1, 'x')).toThrow('The range 2..1 is out of 0..3.');
		expect(() => rewrite.writer(-1)).toThrow('is not a non-negative integer');
		expect(() => rewrite.render(2, 4, () => {}, { data: 'v' })).toThrow('The range 2..4 is out of 0..3.');
	});
});

describe('properties', () => {
	test('random edits render every kept char once, in order and verbatim, in the fewest runs, and every code once', () => {
		const random = createRandom(1);
		for (let iteration = 0; iteration < 20000; iteration++) {
			const length = 1 + random(12);
			const rewrite = createRewrite(s, alphabet(length));
			const root = view(rewrite, 'root');
			let moved: { start: number; end: number } | undefined;
			if (length > 2 && random(2)) {
				const start = 1 + random(length - 2);
				const end = start + 1 + random(length - start - 1);
				const cut = rewrite.cut(start, end, { data: 'moved', placeholder: '<P>' });
				moved = { start, end };
				rewrite.insertBefore(random(start + 1) === start ? 0 : random(start), ['{', cut, '}']);
			}
			const removals: [number, number][] = [];
			const tags: string[] = [];
			for (let edit = random(6); edit > 0; edit--) {
				const writer = rewrite.writer(1 + random(3));
				const tag = `#${tags.length}`;
				const kind = random(3);
				if (kind === 0) {
					writer.insertBefore(random(length + 1), tag);
				}
				else if (kind === 1) {
					writer.insertAfter(random(length + 1), tag);
				}
				else {
					const start = random(length);
					const end = start + 1 + random(length - start);
					writer.replace(start, end, tag);
					removals.push([start, end]);
				}
				tags.push(tag);
			}
			const segments = renderPieces(root);
			expectMinimalRuns(segments);
			const offsets = renderedOffsets(rewrite, segments);
			expect([...offsets].sort((a, b) => a - b)).toEqual(keptOffsets(length, removals));
			const unmoved = offsets.filter(offset => !moved || offset < moved.start || moved.end <= offset);
			expect(unmoved).toEqual([...unmoved].sort((a, b) => a - b));
			const text = toText(segments);
			for (const tag of tags) {
				expect(text.split(tag).length).toBe(2);
			}
		}
	});

	test('random edits render the same whatever order the writers register in', () => {
		const random = createRandom(2);
		for (let iteration = 0; iteration < 5000; iteration++) {
			const length = 1 + random(10);
			const edits = Array.from({ length: random(7) }, (_, index) => {
				const rank = random(3);
				const kind = random(3);
				const start = random(length);
				const end = start + 1 + random(length - start);
				const offset = random(length + 1);
				const tag = `#${index}`;
				return {
					rank,
					apply: (writer: RewriteWriter<TestSource, TestData>) =>
						kind === 0
							? writer.insertBefore(offset, tag)
							: kind === 1
							? writer.insertAfter(offset, tag)
							: writer.replace(start, end, tag),
				};
			});
			const renderEdits = (list: typeof edits) => {
				const rewrite = createRewrite(s, alphabet(length));
				const root = view(rewrite, 'root');
				for (const edit of list) {
					edit.apply(rewrite.writer(edit.rank));
				}
				return render(root);
			};
			// interleave the writers, keeping the call order of each
			const queues = [0, 1, 2].map(rank => edits.filter(edit => edit.rank === rank));
			const interleaved = edits.map(() => random(3)).map(rank =>
				queues[rank]!.length ? queues[rank]!.shift()! : queues.find(queue => queue.length)!.shift()!
			);
			expect(renderEdits(interleaved)).toBe(renderEdits(edits));
		}
	});

	test('many random edits out of order render as the same edits made in order, equal places in call order', () => {
		const random = createRandom(5);
		for (let iteration = 0; iteration < 200; iteration++) {
			// a longer text has keys of more than a byte
			const length = 1 + random(iteration % 2 ? 60 : 600);
			const edits = Array.from({ length: random(400) }, (_, index) => {
				const rank = random(2);
				const kind = random(3);
				const start = kind === 2 ? random(length) : random(length + 1);
				const end = kind === 2 ? start + 1 + random(Math.min(4, length - start)) : start;
				// the side of a char that the edit goes to, in render order
				const key = kind === 0
					? start * 4 + (start === length ? 2 : 0)
					: kind === 1
					? (start ? (start - 1) * 4 + 2 : -4)
					: start * 4 + 1;
				const tag = `#${index}`;
				return {
					key,
					apply: (writer: RewriteWriter<TestSource, TestData>) =>
						kind === 0
							? writer.insertBefore(start, tag)
							: kind === 1
							? writer.insertAfter(start, tag)
							: writer.replace(start, end, tag),
					rank,
				};
			});
			const renderEdits = (list: typeof edits) => {
				const rewrite = createRewrite(s, alphabet(length));
				for (const edit of list) {
					edit.apply(rewrite.writer(edit.rank));
				}
				return collect(view(rewrite));
			};
			const ordered = edits.map((edit, index) => ({ edit, index }))
				.sort((a, b) => a.edit.key - b.edit.key || a.index - b.index)
				.map(({ edit }) => edit);
			expect(renderEdits(edits)).toEqual(renderEdits(ordered));
		}
	});

	test('random nested cuts render every kept char once and verbatim in the fewest runs, every code once, edge code at the edges', () => {
		const random = createRandom(3);
		let nested = 0;
		for (let iteration = 0; iteration < 20000; iteration++) {
			const length = 1 + random(14);
			const testCase = createNestedCase(random, length);
			if (
				testCase.cuts.some(cut =>
					testCase.cuts.some(other => other !== cut && other.start <= cut.start && cut.end <= other.end)
				)
			) {
				nested++;
			}
			const rewrite = createRewrite(s, alphabet(length));
			const segments = renderPieces(view(buildNestedCase(rewrite, testCase, random), 'root'));
			expectMinimalRuns(segments);
			const offsets = renderedOffsets(rewrite, segments);
			const removals = testCase.edits.flatMap(edit =>
				edit.kind === 'replace' ? [[edit.start, edit.end] as [number, number]] : []
			);
			expect(offsets.sort((a, b) => a - b)).toEqual(keptOffsets(length, removals));
			const text = toText(segments);
			for (const edit of testCase.edits) {
				expect(text.split(edit.tag).length).toBe(2);
			}
			const head = testCase.edits.filter(edit => edit.kind === 'insertAfter' && edit.start === 0);
			const tail = testCase.edits.filter(edit => edit.kind === 'insertBefore' && edit.start === length);
			if (head.length) {
				expect(head.some(edit => text.startsWith(edit.tag))).toBe(true);
			}
			if (tail.length) {
				expect(tail.some(edit => text.endsWith(edit.tag))).toBe(true);
			}
		}
		expect(nested).toBeGreaterThan(1000);
	});

	test('random placements of slices in two rewrites throw exactly where a slice would render inside itself, and unrendered tells what no view renders', () => {
		const random = createRandom(6);
		let refused = 0;
		let lost = 0;
		interface ModelCut {
			id: number;
			rewrite: number;
			start: number;
			end: number;
			slice: RewriteSlice<TestSource, TestData>;
		}
		type Place = { kind: 'view' } | { kind: 'char'; rewrite: number; at: number } | { kind: 'placeholder'; of: ModelCut };
		for (let iteration = 0; iteration < 3000; iteration++) {
			const lengths = [1 + random(8), 1 + random(8)];
			const rewrites = lengths.map((length, index) => createRewrite(`r${index}`, alphabet(length)));
			const cuts: ModelCut[] = [];
			const places = new Map<ModelCut, Place[]>();
			// the innermost cut that holds the char, of two cuts of one range the later
			const ownerAt = (rewrite: number, at: number) => {
				let owner: ModelCut | undefined;
				for (const cut of cuts) {
					if (cut.rewrite === rewrite && cut.start <= at && at < cut.end && (!owner || cut.end - cut.start <= owner.end - owner.start)) {
						owner = cut;
					}
				}
				return owner;
			};
			// the innermost cut that holds the cut, of two cuts of one range the earlier
			const parentOf = (inner: ModelCut) => {
				let parent: ModelCut | undefined;
				for (const cut of cuts) {
					if (
						cut !== inner && cut.rewrite === inner.rewrite && cut.start <= inner.start && inner.end <= cut.end
						&& (cut.end - cut.start > inner.end - inner.start || cut.id < inner.id)
						&& (!parent || cut.end - cut.start <= parent.end - parent.start)
					) {
						parent = cut;
					}
				}
				return parent;
			};
			const rendererOf = (place: Place) =>
				place.kind === 'view' ? undefined : place.kind === 'char' ? ownerAt(place.rewrite, place.at) : parentOf(place.of);
			const rendersInside = (slice: ModelCut, owner: ModelCut): boolean => {
				const seen = new Set<ModelCut>();
				const walk = [owner];
				while (walk.length) {
					const cut = walk.pop()!;
					if (cut === slice) {
						return true;
					}
					if (!seen.has(cut)) {
						seen.add(cut);
						for (const place of places.get(cut) ?? []) {
							const by = rendererOf(place);
							if (by) {
								walk.push(by);
							}
						}
					}
				}
				return false;
			};
			const pick = () => cuts.length ? [cuts[random(cuts.length)]!] : [];
			for (let op = 1 + random(10); op > 0; op--) {
				const rewrite = random(2);
				const length = lengths[rewrite]!;
				const slices = random(2) ? [...pick(), ...pick()] : pick();
				const code = slices.flatMap(slice => ['(', slice.slice, ')']);
				let place: Place;
				let write: () => RewriteSlice<TestSource, TestData> | void;
				let cut: ModelCut | undefined;
				if (random(3) === 0) {
					const start = random(length);
					const end = start + 1 + random(length - start);
					if (cuts.some(other => other.rewrite === rewrite && other.start < end && start < other.end && (other.start < start ? other.end < end : start < other.start && end < other.end))) {
						continue;
					}
					cut = { id: cuts.length, rewrite, start, end, slice: undefined! };
					place = { kind: 'placeholder', of: cut };
					write = () => rewrites[rewrite]!.cut(start, end, { data: `c${cut!.id}`, placeholder: code });
				}
				else {
					const kind = random(3);
					const offset = random(length + 1);
					const at = kind === 0 ? offset : kind === 1 ? offset - 1 : offset;
					place = at < 0 || at >= length ? { kind: 'view' } : { kind: 'char', rewrite, at };
					const writer = random(2) ? rewrites[rewrite]! : rewrites[rewrite]!.writer(random(2));
					write = () =>
						kind === 0 ? writer.insertBefore(offset, code) : kind === 1 ? writer.insertAfter(offset, code) : writer.replace(offset, offset, code);
				}
				if (cut) {
					cuts.push(cut);
				}
				const by = rendererOf(place);
				const inside = by && slices.some(slice => rendersInside(slice, by));
				if (inside) {
					expect(write).toThrow('would be placed inside itself');
					refused++;
					if (cut) {
						cuts.pop();
					}
					continue;
				}
				const made = write();
				if (cut) {
					cut.slice = made!;
				}
				for (const slice of slices) {
					places.set(slice, [...places.get(slice) ?? [], place]);
				}
			}
			const reached = (cut: ModelCut, seen = new Set<ModelCut>()): boolean => {
				if (seen.has(cut)) {
					return false;
				}
				seen.add(cut);
				return (places.get(cut) ?? []).some(place => {
					const by = rendererOf(place);
					return !by || reached(by, seen);
				});
			};
			const rendered = new Set<string>();
			rewrites.forEach((rewrite, index) => {
				expect(rewrite.unrendered()).toEqual(cuts.filter(cut => cut.rewrite === index && !reached(cut)).map(cut => cut.slice));
				rewrite.render(0, lengths[index]!, piece => {
					if (typeof piece !== 'string') {
						rendered.add(piece.data);
					}
				}, { data: 'root' });
			});
			// a cut renders text of its own unless the cuts in it hold all of it
			const ownsChar = (cut: ModelCut) =>
				Array.from({ length: cut.end - cut.start }, (_, index) => cut.start + index).some(at => ownerAt(cut.rewrite, at) === cut);
			const expected = cuts.filter(cut => reached(cut) && ownsChar(cut)).map(cut => `c${cut.id}`);
			expect([...rendered].filter(data => data !== 'root').sort()).toEqual(expected.sort());
			lost += cuts.filter(cut => !reached(cut)).length;
		}
		expect(refused).toBeGreaterThan(500);
		expect(lost).toBeGreaterThan(500);
	});

	test('random views that split the text render what one view of the text renders', () => {
		const random = createRandom(4);
		for (let iteration = 0; iteration < 5000; iteration++) {
			const length = 1 + random(14);
			const testCase = createNestedCase(random, length);
			// views of no char from 0 or to the end would render the code before or after all text again
			const bounds = [...new Set([0, ...Array.from({ length: random(4) }, () => random(length + 1)), length])]
				.sort((a, b) => a - b);
			const whole = buildNestedCase(createRewrite(s, alphabet(length)), testCase, random);
			const split = buildNestedCase(createRewrite(s, alphabet(length)), testCase, random);
			const views = bounds.slice(1).map((end, index) => render(view(split, 'root', bounds[index], end)));
			expect(views.join('')).toBe(render(view(whole, 'root')));
		}
	});
});

interface NestedCut {
	start: number;
	end: number;
	id: number;
	/** Whether it is placed after all text, as a cut whose parent owns no char is; else at `place`. */
	atEnd: boolean;
	place?: { at: number; after: boolean };
}

interface NestedEdit {
	kind: 'insertBefore' | 'insertAfter' | 'replace';
	rank: number | undefined;
	start: number;
	end: number;
	tag: string;
}

/** Random edits and a random family of nested or disjoint cuts, each placed after all text or at a char of its parent. */
function createNestedCase(random: (below: number) => number, length: number) {
	const cuts: NestedCut[] = [];
	const grow = (start: number, end: number, depth: number) => {
		if (depth > 3 || end - start < 1) {
			return;
		}
		for (let count = random(3); count > 0; count--) {
			const a = start + random(end - start);
			const b = a + 1 + random(end - a);
			if (
				cuts.some(cut =>
					(cut.start < a && a < cut.end && cut.end < b) || (a < cut.start && cut.start < b && b < cut.end)
				)
			) {
				continue;
			}
			cuts.push({ start: a, end: b, id: cuts.length, atEnd: random(3) === 0 });
			if (random(4) === 0) {
				cuts.push({ start: a, end: b, id: cuts.length, atEnd: random(2) === 0 });
			}
			grow(a, b, depth + 1);
		}
	};
	if (random(4)) {
		grow(0, length, 0);
	}
	// the innermost cut that contains a cut; of two cuts of one range, the earlier
	const parentOf = (cut: NestedCut) => {
		let parent: NestedCut | undefined;
		for (const other of cuts) {
			const contains = other !== cut && other.start <= cut.start && cut.end <= other.end
				&& (other.end - other.start > cut.end - cut.start || other.id < cut.id);
			if (
				contains
				&& (!parent || other.end - other.start < parent.end - parent.start
					|| (other.end - other.start === parent.end - parent.start && other.id > parent.id))
			) {
				parent = other;
			}
		}
		return parent;
	};
	for (const cut of cuts) {
		const parent = parentOf(cut);
		const [start, end] = parent ? [parent.start, parent.end] : [0, length];
		// a char that the parent owns: placing the cut there cannot place it inside itself
		const free: number[] = [];
		for (let index = start; index < end; index++) {
			if (
				!cuts.some(other => other !== parent && parentOf(other) === parent && other.start <= index && index < other.end)
			) {
				free.push(index);
			}
		}
		if (!cut.atEnd && free.length) {
			cut.place = { at: free[random(free.length)]!, after: !!random(2) };
		}
	}
	const edits: NestedEdit[] = [];
	const kinds = ['insertBefore', 'insertAfter', 'replace'] as const;
	for (let count = random(8); count > 0; count--) {
		const kind = kinds[random(3)]!;
		const rank = random(3);
		const start = kind === 'replace' ? random(length) : random(length + 1);
		const end = kind === 'replace' ? start + 1 + random(length - start) : start;
		edits.push({ kind, rank, start, end, tag: `#${edits.length}` });
	}
	if (random(2)) {
		const offset = random(length + 1);
		edits.push({ kind: kinds[random(2)]!, rank: undefined, start: offset, end: offset, tag: `#${edits.length}` });
	}
	return { length, cuts, edits };
}

/** `rewrite` with the cuts and edits of the case. */
function buildNestedCase(
	rewrite: SourceRewrite<TestSource, TestData>,
	{ cuts, edits }: ReturnType<typeof createNestedCase>,
	random: (below: number) => number,
) {
	const slices: RewriteSlice<TestSource, TestData>[] = [];
	// in a random order, but of two cuts of one range the earlier first, as it holds the later
	const order = cuts.map(cut => ({ cut, key: random(cuts.length + 1) }))
		.sort((a, b) => a.key - b.key)
		.map(({ cut }) => cut);
	const ofRange = (cut: NestedCut) => order.filter(other => other.start === cut.start && other.end === cut.end);
	for (const cut of order.map(cut => ofRange(cut).sort((a, b) => a.id - b.id)[ofRange(cut).indexOf(cut)]!)) {
		slices[cut.id] = rewrite.cut(cut.start, cut.end, { data: `cut${cut.id}`, placeholder: `<P${cut.id}>` });
	}
	for (const cut of cuts) {
		const code = ['{', slices[cut.id]!, '}'];
		if (!cut.place) {
			// by the innermost writer, before its edits: inside the code that the edits put after all text
			rewrite.writer(0).insertBefore(rewrite.source.content.length, code);
		}
		else if (cut.place.after) {
			rewrite.insertAfter(cut.place.at + 1, code);
		}
		else {
			rewrite.insertBefore(cut.place.at, code);
		}
	}
	for (const edit of edits) {
		const writer = edit.rank === undefined ? rewrite : rewrite.writer(edit.rank);
		if (edit.kind === 'replace') {
			writer.replace(edit.start, edit.end, edit.tag);
		}
		else {
			writer[edit.kind](edit.start, edit.tag);
		}
	}
	return rewrite;
}

test('the package imports only its own modules and depends on nothing', () => {
	const src = path.join(__dirname, '../src');
	for (const file of fs.readdirSync(src)) {
		const specifiers = [...fs.readFileSync(path.join(src, file), 'utf8').matchAll(/ from '([^']*)';$/gm)];
		for (const [, specifier] of specifiers) {
			expect(specifier).toMatch(/^\.\/\w+\.js$/);
		}
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
	expect(pkg.dependencies).toBeUndefined();
	expect(pkg.peerDependencies).toBeUndefined();
});

test('the tests type check, so the errors they expect are errors', () => {
	const tsc = path.join(__dirname, '../node_modules/typescript/bin/tsc');
	const { stdout, stderr } = spawnSync(process.execPath, [tsc, '-p', __dirname], { encoding: 'utf8' });
	expect(stdout + stderr).toBe('');
});

test('the built package is ES modules that Node imports by the package name, with no side effects', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
	expect(pkg.type).toBe('module');
	expect(pkg.sideEffects).toBe(false);
	const { stdout, stderr } = spawnSync(
		process.execPath,
		['--input-type=module', '-e', `import * as m from 'muggle-string'; console.log(Object.keys(m).sort().join())`],
		{ cwd: path.join(__dirname, '..'), encoding: 'utf8' },
	);
	expect(stderr).toBe('');
	expect(stdout.trim()).toBe('createSourceRewrite,decodeMappings,encodeMappings,renderWithDecodedSourceMap,renderWithSourceMap,rewritePieceText');
});

test('the declarations of the built package declare decodeMappings and encodeMappings', () => {
	for (const dir of ['out', 'out/cjs']) {
		const declaration = fs.readFileSync(path.join(__dirname, '..', dir, 'sourceMap.d.ts'), 'utf8');
		expect(declaration).toContain('export declare function encodeMappings(');
		expect(declaration).toContain('export declare function decodeMappings(');
	}
});
