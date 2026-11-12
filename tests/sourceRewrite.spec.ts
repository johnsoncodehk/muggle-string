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
	renderWithSourceMap,
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

/** The data of the kept pieces of a test rewrite, which a cut or a view can give none of. */
type TestData = string | undefined;

type TestPiece = Piece<RewriteOrigin<TestSource, TestData>>;

/** A piece whose kept range names its source. */
type NamedPiece = Piece<{ source: TestSource | string; data?: string }>;

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
	return { render: sink => rewrite.render(start, end, sink, data) };
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

	test('only cut makes a slice: any other object in code is a piece, passed on as it is', () => {
		const rewrite = createRewrite(s, 'ab');
		const renders = {
			render() {
				throw new Error('Only a cut renders.');
			},
		};
		// @ts-expect-error only cut makes a slice
		rewrite.insertAfter(1, renders);
		expect(renderPieces(view(rewrite))[1]).toBe(renders);
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
		flagged.replace(1, 2, { source, start: 1, end: 2, text: 'X', data: { render: false } });
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

	test('a slice that is not placed does not render, with the code in it, which unrendered tells until it renders', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = view(rewrite);
		const placed = rewrite.cut(0, 1, { data: 'placed' });
		const unplaced = rewrite.cut(2, 4, { data: 'unplaced' });
		rewrite.insertBefore(0, 'x');
		rewrite.insertBefore(3, 'y');
		rewrite.insertAfter(6, ['z', placed]);
		expect(rewrite.unrendered()).toEqual([placed, unplaced]);
		// the code before the char 0 is of the slice that holds it
		expect(render(body)).toBe('befzxa');
		expect(rewrite.unrendered()).toEqual([unplaced]);
		expect(render(unplaced)).toBe('cyd');
		expect(rewrite.unrendered()).toEqual([]);
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
		const pieces: Piece<RewriteOrigin<typeof source>>[] = [];
		rewrite.render(0, 3, piece => pieces.push(piece));
		expect(pieces.map(rewritePieceText).join('')).toBe('Acb');
	});

	test('a cut placed in code that only its own render renders is an error at the first render', () => {
		const inOwnRange = createRewrite(s, 'abcdef');
		const body = view(inOwnRange);
		const cut = inOwnRange.cut(1, 4, { data: 'cut' });
		inOwnRange.insertBefore(2, cut);
		const message = 'The cut 1..4 is placed inside itself, so it never renders.';
		expect(() => collect(body)).toThrow(message);
		expect(() => collect(cut)).toThrow(message);

		const inOwnPlaceholder = createRewrite(s, 'abcdef');
		const outer = inOwnPlaceholder.cut(1, 5, { data: 'outer' });
		const placeholder: RewriteCode<TestSource, TestData>[] = [];
		inOwnPlaceholder.cut(2, 3, { data: 'inner', placeholder });
		placeholder.push(outer);
		expect(() => collect(outer)).toThrow('The cut 1..5 is placed inside itself');

		const inEachOther = createRewrite(s, 'abcdef');
		const whole = inEachOther.cut(0, 6, { data: 'whole' });
		const first = inEachOther.cut(1, 2, { data: 'first' });
		const second = inEachOther.cut(3, 4, { data: 'second' });
		inEachOther.insertBefore(1, second);
		inEachOther.insertBefore(3, first);
		expect(() => collect(whole)).toThrow('is placed inside itself');
	});

	test('a cut that its own render places is an error, also across rewrites', () => {
		const a = createRewrite(s, 'abc');
		const b = createRewrite(other, 'xyz');
		const aCut = a.cut(0, 3, { data: 'a' });
		const bCut = b.cut(0, 3, { data: 'b' });
		a.insertBefore(1, bCut);
		b.insertBefore(1, aCut);
		expect(() => collect(aCut)).toThrow('The cut 0..3 is placed inside itself, so it never renders.');
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
		expect(() => rewrite.render(0, 3, () => rewrite.insertBefore(0, 'x'), 'v')).toThrow(message);
		expect(() => slice.render(() => rewrite.writer(0).replace(0, 1, 'x'))).toThrow(message);
		expect(() => rewrite.render(0, 3, () => rewrite.cut(0, 1, { data: 'late' }), 'v')).toThrow(message);
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

	test('offsets out of the text and an invalid rank are errors', () => {
		const rewrite = createRewrite(s, 'abc');
		expect(() => rewrite.insertBefore(4, 'x')).toThrow('The offset 4 is out of 0..3.');
		expect(() => rewrite.writer(0).replace(2, 1, 'x')).toThrow('The range 2..1 is out of 0..3.');
		expect(() => rewrite.writer(-1)).toThrow('is not a non-negative integer');
		expect(() => rewrite.render(2, 4, () => {}, 'v')).toThrow('The range 2..4 is out of 0..3.');
	});
});

describe('data', () => {
	test('data is one field of a kept range, passed on as the value it is, and no field at all when undefined', () => {
		const source = { content: 'abcdef' };
		const viewData = { feature: 'view' };
		const cutData = { feature: 'cut' };
		const rewrite = createSourceRewrite<typeof source, { feature: string }>(source);
		rewrite.insertBefore(6, rewrite.cut(0, 2, { data: cutData }));
		const pieces: Piece<RewriteOrigin<typeof source, { feature: string }>>[] = [];
		rewrite.render(0, 6, piece => pieces.push(piece), viewData);
		expect(pieces).toStrictEqual([
			{ source, start: 2, end: 6, data: viewData },
			{ source, start: 0, end: 2, data: cutData },
		]);
		expect(pieces.map(piece => typeof piece !== 'string' && piece.data)).toEqual([viewData, cutData]);
		expect((pieces[0] as { data: object }).data).toBe(viewData);
		expect((pieces[1] as { data: object }).data).toBe(cutData);

		const plain = createSourceRewrite(source);
		plain.insertBefore(6, plain.cut(0, 2, { data: undefined }));
		const kept: object[] = [];
		plain.render(0, 6, piece => typeof piece !== 'string' && kept.push(piece));
		expect(kept).toStrictEqual([{ source, start: 2, end: 6 }, { source, start: 0, end: 2 }]);
		expect(kept.map(piece => Object.keys(piece))).toEqual([['source', 'start', 'end'], ['source', 'start', 'end']]);
	});

	test('data with the names of the fields of the package is data: the rewrite and the renders never read it', () => {
		const source = { name: 'a.js', content: 'abc' };
		type Data = { text: string; placeholder: string; name: string; source: string; start: number; end: number; render: string };
		const data = (of: string): Data => ({ text: of, placeholder: of, name: of, source: of, start: 99, end: -1, render: of });
		const rewrite = createSourceRewrite<typeof source, Data>(source);
		const cut = rewrite.cut(0, 1, { data: data('cut'), placeholder: 'P' });
		rewrite.insertBefore(3, cut);
		rewrite.replace(1, 2, { source, start: 1, end: 2, text: 'B', name: 'b', data: data('range') });
		const pieces: Piece<RewriteOrigin<typeof source, Data>>[] = [];
		rewrite.render(0, 3, piece => pieces.push(piece), data('view'));
		expect(pieces).toStrictEqual([
			'P',
			{ source, start: 1, end: 2, text: 'B', name: 'b', data: data('range') },
			{ source, start: 2, end: 3, data: data('view') },
			{ source, start: 0, end: 1, data: data('cut') },
		]);
		expect(pieces.map(rewritePieceText).join('')).toBe('PBca');
		const { text, map } = renderWithSourceMap(
			sink => rewrite.render(0, 3, sink, data('view')),
			(from: typeof source) => from.name,
		);
		expect(text).toBe('PBca');
		expect(map.names).toEqual(['b']);
		expect(map.sources).toEqual(['a.js']);
	});

	test('data can be any value but undefined, which is no data', () => {
		const source = { content: 'ab' };
		for (const data of [0, '', false, null, 'x', 7, [1], () => 1]) {
			const rewrite = createSourceRewrite<typeof source, unknown>(source);
			rewrite.insertBefore(2, rewrite.cut(0, 1, { data }));
			const kept: unknown[] = [];
			rewrite.render(0, 2, piece => kept.push(piece), data);
			expect(kept).toStrictEqual([{ source, start: 1, end: 2, data }, { source, start: 0, end: 1, data }]);
		}
	});

	test('kept text has the data of its cut, wherever the slice renders, and a cut without data gives none', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const plain = rewrite.cut(0, 2);
		const own = rewrite.cut(2, 4, { data: 'own' });
		const inOwn = rewrite.cut(4, 5);
		const inPlain = rewrite.cut(5, 6, { data: 'deep' });
		rewrite.insertBefore(8, [plain, own]);
		rewrite.insertBefore(3, inOwn);
		rewrite.insertAfter(1, inPlain);
		expect(collect(view(rewrite, 'first'))).toStrictEqual([
			{ source: s, start: 6, end: 8, data: 'first' },
			{ source: s, start: 0, end: 1 },
			{ source: s, start: 5, end: 6, data: 'deep' },
			{ source: s, start: 1, end: 2 },
			{ source: s, start: 2, end: 3, data: 'own' },
			{ source: s, start: 4, end: 5 },
			{ source: s, start: 3, end: 4, data: 'own' },
		]);
		// the data of a view is the data of the text that the view keeps, not of the slices placed in it
		expect(collect(view(rewrite, 'second', 6, 8)).map(piece => typeof piece !== 'string' && piece.data))
			.toEqual(['second', undefined, 'deep', undefined, 'own', undefined, 'own']);
		expect(collect(plain)).toStrictEqual([
			{ source: s, start: 0, end: 1 },
			{ source: s, start: 5, end: 6, data: 'deep' },
			{ source: s, start: 1, end: 2 },
		]);
		expect(collect(own).map(piece => typeof piece !== 'string' && piece.data)).toEqual(['own', undefined, 'own']);
	});

	test('a slice in the placeholder of a cut renders with the data of its own cut', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const outer = rewrite.cut(0, 6, { data: 'outer' });
		const plain = rewrite.cut(1, 3);
		const withData = rewrite.cut(4, 5, { data: 'inner' });
		rewrite.cut(3, 4, { data: 'held', placeholder: ['<', plain, withData, '>'] });
		expect(collect(outer)).toStrictEqual([
			{ source: s, start: 0, end: 1, data: 'outer' },
			'<',
			{ source: s, start: 1, end: 3 },
			{ source: s, start: 4, end: 5, data: 'inner' },
			'>',
			{ source: s, start: 5, end: 6, data: 'outer' },
		]);
	});

	test('a slice of another rewrite or another copy of the package renders with the data of its own cut', () => {
		const cjs: typeof import('../src') = createRequire(__filename)('../out/cjs/index.js');
		const rewrite = createRewrite(s, 'ab');
		const inner = createRewrite(other, 'xy');
		const copy = cjs.createSourceRewrite<TestSource, TestData>({ name: 'copy', content: 'z' });
		rewrite.insertAfter(1, [inner.cut(0, 2, { data: 'inner' }), copy.cut(0, 1)]);
		expect(collect(view(rewrite, 'view'))).toStrictEqual([
			{ source: s, start: 0, end: 1, data: 'view' },
			{ source: other, start: 0, end: 2, data: 'inner' },
			{ source: 'copy', start: 0, end: 1 },
			{ source: s, start: 1, end: 2, data: 'view' },
		]);
	});

	test('the options of a cut are data and placeholder: any other field, or options that are no object, is an error', () => {
		const rewrite = createSourceRewrite<TestSource, { feature: string }>({ name: s, content: 'abc' });
		// @ts-expect-error the data of a cut goes in its option `data`
		expect(() => rewrite.cut(0, 1, { feature: 'x' })).toThrow(
			new TypeError('cut(0, 1, options): "feature" is not an option of a cut, which are "data" and "placeholder".'),
		);
		// @ts-expect-error the data of a cut goes in its option `data`
		expect(() => rewrite.cut(0, 1, { placeholder: 'P', feature: 'x' })).toThrow('"feature" is not an option of a cut');
		// @ts-expect-error options are an object
		expect(() => rewrite.cut(0, 1, 'P')).toThrow(new TypeError('cut(0, 1, options): the options are "P", not an object.'));
		// @ts-expect-error options are an object
		expect(() => rewrite.cut(0, 1, null)).toThrow('cut(0, 1, options): the options are null, not an object.');
		// @ts-expect-error options are an object
		expect(() => rewrite.cut(0, 1, ['P'])).toThrow('cut(0, 1, options): the options are an array, not an object.');
		expect(rewrite.unrendered()).toEqual([]);
		const optional = createRewrite(s, 'abc');
		const slice = optional.cut(0, 1, {});
		expect(optional.cut(1, 2, undefined)).not.toBe(slice);
		expect(optional.cut(2, 3, { data: undefined, placeholder: undefined })).not.toBe(slice);
		expect(optional.unrendered()).toHaveLength(3);
		expect(render(view(optional))).toBe('');
	});

	test('the types take data where it is required, and only as the type of the rewrite', () => {
		const source = { content: 'abc' };
		const required = createSourceRewrite<typeof source, { feature: string }>(source);
		// @ts-expect-error a cut gives the data that its kept text needs
		required.cut(2, 3);
		// @ts-expect-error also beside a placeholder
		required.cut(2, 3, { placeholder: 'P' });
		const slice = required.cut(0, 1, { data: { feature: 'cut' } });
		// @ts-expect-error a view gives the data that its kept text needs
		required.render(0, 3, () => {});
		slice.render(() => {});
		// @ts-expect-error a slice renders with the data of its cut, and takes no other
		slice.render(() => {}, { feature: 'x' });
		// @ts-expect-error data is of the type of the rewrite
		required.render(0, 3, () => {}, { feature: 1 });
		// @ts-expect-error a range that is written gives its data too
		required.insertBefore(0, { source, start: 0, end: 1, text: 'x' });
		// @ts-expect-error data is not spread into the range
		required.insertBefore(0, { source, start: 0, end: 1, text: 'x', feature: 'x' });
		required.insertBefore(0, { source, start: 0, end: 1, text: 'x', data: { feature: 'x' } });
		required.render(0, 3, piece => {
			if (typeof piece !== 'string') {
				const feature: string = piece.data.feature;
				// @ts-expect-error data is not spread into the range
				expect(piece.feature).toBeUndefined();
				expect(feature).toBeTypeOf('string');
			}
		}, { feature: 'view' });

		const optional = createSourceRewrite<typeof source, { feature: string } | undefined>(source);
		optional.render(0, 3, piece => {
			if (typeof piece !== 'string') {
				// @ts-expect-error the data may be undefined
				const read = () => piece.data.feature;
				expect(read).toThrow(TypeError);
				expect(piece.data?.feature).toBeUndefined();
			}
		});
		optional.cut(0, 1).render(() => {});

		const none = createSourceRewrite(source);
		// @ts-expect-error a rewrite without data takes none
		none.render(0, 3, () => {}, { feature: 'x' });
		// @ts-expect-error a rewrite without data takes none
		none.cut(0, 1, { data: 'x' });
		// @ts-expect-error a slice of other data is no code of the rewrite
		expect(() => none.insertBefore(3, slice)).not.toThrow();
		none.replace(1, 2, { source, start: 1, end: 2, text: 'B', name: 'b' });
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
	inPlace: boolean;
	place?: { at: number; after: boolean };
}

interface NestedEdit {
	kind: 'insertBefore' | 'insertAfter' | 'replace';
	rank: number | undefined;
	start: number;
	end: number;
	tag: string;
}

/** Random edits and a random family of nested or disjoint cuts, each placed in place or at a char of its parent. */
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
			cuts.push({ start: a, end: b, id: cuts.length, inPlace: random(3) === 0 });
			if (random(4) === 0) {
				cuts.push({ start: a, end: b, id: cuts.length, inPlace: random(2) === 0 });
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
		if (!cut.inPlace && free.length) {
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
		// a cut not placed elsewhere renders in its own placeholder, which code reads when it renders
		const inPlace: RewriteCode<TestSource, TestData>[] = [];
		const placeholder = cut.place ? `<P${cut.id}>` : inPlace;
		slices[cut.id] = rewrite.cut(cut.start, cut.end, { data: `cut${cut.id}`, placeholder });
		inPlace.push('<', slices[cut.id]!, '>');
	}
	for (const cut of cuts) {
		if (cut.place) {
			const code = ['{', slices[cut.id]!, '}'];
			if (cut.place.after) {
				rewrite.insertAfter(cut.place.at + 1, code);
			}
			else {
				rewrite.insertBefore(cut.place.at, code);
			}
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
