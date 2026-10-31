import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	createSourceRewrite,
	type Piece,
	type RewriteCode,
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

type TestPiece = Piece<{ source: TestSource; data: string }>;

/** A piece whose kept range names its source. */
type NamedPiece = Piece<{ source: TestSource | string; data: string }>;

/** A source of pieces of generated code, which no rewrite edits. */
const otherSource: TestSource = { name: other, content: 'wxyz' };

/** The source of each rewrite, which its kept pieces carry. */
const sources = new Map<SourceRewrite<TestSource, string>, TestSource>();

function createRewrite(name: string, content: string) {
	const source = { name, content };
	const rewrite = createSourceRewrite<TestSource, string>(source);
	sources.set(rewrite, source);
	return rewrite;
}

/** The pieces of `slice`, as the render passes them. */
function renderPieces(slice: RewriteSlice<TestSource, string>) {
	const pieces: TestPiece[] = [];
	slice.render(piece => pieces.push(piece));
	return pieces;
}

/** The pieces of `slice`: text, and kept source ranges, by the name of their source, with the data of their cut. */
function collect(slice: RewriteSlice<TestSource, string>): NamedPiece[] {
	return renderPieces(slice).map(piece =>
		typeof piece === 'string' || piece.text !== undefined ? piece : { ...piece, source: piece.source.name }
	);
}

function toText(pieces: TestPiece[]) {
	return pieces.map(rewritePieceText).join('');
}

function render(slice: RewriteSlice<TestSource, string>) {
	return toText(renderPieces(slice));
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
function renderedOffsets(rewrite: SourceRewrite<TestSource, string>, pieces: TestPiece[]) {
	return pieces.flatMap(piece => {
		if (typeof piece === 'string') {
			return [];
		}
		expect(piece).not.toHaveProperty('text');
		expect(piece.source).toBe(sources.get(rewrite));
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
	const body = rewrite.cut(0, text.length, { data: 'body' });
	const typeArg = { start: text.indexOf('{'), end: text.lastIndexOf('}') + 1 };
	const alias = rewrite.cut(typeArg.start, typeArg.end, { data: 'alias', placeholder: '__VLS_Props' });
	rewrite.insertBefore(text.indexOf(statement), ['type __VLS_Props = ', alias, ';\n']);
	return { rewrite, body, typeArg };
}

describe('scenarios', () => {
	test('the example of the readme', () => {
		const source = { name: 'main.js', content: 'log(name);\nconst name = "Ada";\n' };
		const rewrite = createSourceRewrite<typeof source, string>(source);

		for (const { index } of source.content.matchAll(/\bname\b/g)) {
			rewrite.replace(index, index + 'name'.length, 'user');
		}

		const file = rewrite.cut(0, source.content.length, { data: 'file' });
		const declaration = rewrite.cut(source.content.indexOf('const'), source.content.length, { data: 'declaration' });
		rewrite.insertBefore(0, declaration);

		let output = '';
		file.render(piece => output += rewritePieceText(piece));
		expect(output).toBe('const user = "Ada";\nlog(user);\n');
	});

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
			(writer: RewriteWriter<TestSource, string>) => writer.replace(call, call + 'useFoo()'.length, 'first()'),
			(writer: RewriteWriter<TestSource, string>) => writer.replace(name, name + 'Foo'.length, 'Second'),
		];
		for (const order of [[0, 1], [1, 0]]) {
			const rewrite = createRewrite(s, text);
			const body = rewrite.cut(0, text.length, { data: 'body' });
			order.forEach((edit, rank) => edits[edit]!(rewrite.writer(rank + 1)));
			expect(render(body)).toBe('const a = first()Second;');
		}
	});

	test('replaces of one range by two writers keep both codes, inner rank first', () => {
		const text = 'const a = useFoo();';
		const rewrite = createRewrite(s, text);
		const body = rewrite.cut(0, text.length, { data: 'body' });
		const call = text.indexOf('useFoo()');
		rewrite.writer(1).replace(call, call + 8, 'A()');
		rewrite.writer(2).replace(call, call + 8, 'B()');
		expect(render(body)).toBe('const a = A()B();');
	});

	test('wraps of two writers nest, the lower rank inside', () => {
		const rewrite = createRewrite(s, 'x = f();');
		const body = rewrite.cut(0, 8, { data: 'body' });
		rewrite.writer(1).insertBefore(4, 'A(');
		rewrite.writer(1).insertAfter(7, ')');
		rewrite.writer(2).insertBefore(4, 'B(');
		rewrite.writer(2).insertAfter(7, ')');
		expect(render(body)).toBe('x = B(A(f()));');
	});

	test('an insert at a boundary of two cuts goes by its side, and a removal across them splits', () => {
		const text = `import { a } from 'a';\nconst b = a;`;
		const rewrite = createRewrite(s, text);
		const importEnd = text.indexOf('\n') + 1;
		const imports = rewrite.cut(0, importEnd, { data: 'imports' });
		const body = rewrite.cut(importEnd, text.length, { data: 'body' });
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
		const body = rewrite.cut(0, 11, { data: 'body' });
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
		const body = rewrite.cut(0, 2, { data: 'body' });
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
		expect(collect(rewrite.cut(0, 2, { data: 'body' }))).toStrictEqual([
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
		const body = rewrite.cut(0, 3, { data: 'body' });
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

	test('a slice is any code that renders, and renders through its own render', () => {
		const rewrite = createRewrite(s, 'ab');
		const body = rewrite.cut(0, 2, { data: 'body' });
		rewrite.insertAfter(1, [{ render: sink => sink('x') }, { render() {} }]);
		expect(render(body)).toBe('axb');
	});

	test('removals of two writers that overlap the edges of a moved cut remove the chars of both cuts', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const body = rewrite.cut(0, 8, { data: 'body' });
		rewrite.insertAfter(8, rewrite.cut(2, 6, { data: 'inner', placeholder: 'P' }));
		rewrite.writer(0).replace(1, 4, 'X');
		rewrite.writer(1).replace(3, 7, 'Y');
		expect(render(body)).toBe('aXPhY');
	});
});

describe('order', () => {
	test('the entries of one writer at one side of a char keep call order', () => {
		const rewrite = createRewrite(s, 'abc');
		const body = rewrite.cut(0, 3, { data: 'body' });
		rewrite.insertAfter(1, 'A');
		rewrite.insertBefore(2, 'B');
		rewrite.insertAfter(1, 'C');
		rewrite.insertBefore(2, 'D');
		expect(render(body)).toBe('aACbBDc');
	});

	test('edits and removals of one writer that arrive out of order render in order, equal keys in call order', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = rewrite.cut(0, 6, { data: 'body' });
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
		const body = rewrite.cut(0, 3, { data: 'body' });
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

describe('block edges', () => {
	test('code at the end of the text stays after all text when a cut that ends there moves', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const body = rewrite.cut(0, 8, { data: 'body' });
		const last = rewrite.cut(5, 8, { data: 'last' });
		rewrite.insertAfter(0, last);
		rewrite.insertBefore(8, 'X');
		rewrite.insertAfter(8, 'Y');
		expect(render(body)).toBe('fghYabcdeX');
	});

	test('code at the start of the text stays before all text when a cut that starts there moves', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const body = rewrite.cut(0, 8, { data: 'body' });
		const first = rewrite.cut(0, 3, { data: 'first' });
		rewrite.insertBefore(8, first);
		rewrite.insertAfter(0, 'X');
		rewrite.insertBefore(0, 'Y');
		expect(render(body)).toBe('XdefghYabc');
	});

	test('head code renders by rank descending and tail code by rank ascending', () => {
		const rewrite = createRewrite(s, 'ab');
		const body = rewrite.cut(0, 2, { data: 'body' });
		for (const [name, writer] of [['0', rewrite.writer(0)], ['c', rewrite], ['1', rewrite.writer(1)]] as const) {
			writer.insertAfter(0, `h${name}`);
			writer.insertBefore(2, `t${name}`);
		}
		expect(render(body)).toBe('hch1h0abt0t1tc');
	});

	test('an empty text renders its inserts in the first zero-width cut, after code before code', () => {
		const rewrite = createRewrite(s, '');
		const imports = rewrite.cut(0, 0, { data: 'imports' });
		const body = rewrite.cut(0, 0, { data: 'body' });
		rewrite.insertBefore(0, 'B1');
		rewrite.writer(0).insertAfter(0, 'A0');
		rewrite.insertAfter(0, 'A1');
		rewrite.insertBefore(0, 'B2');
		expect([collect(imports), collect(body)]).toEqual([['A1', 'A0', 'B1', 'B2'], []]);
	});
});

describe('runs', () => {
	test('a removal next to a run boundary or an insert renders no empty run', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = rewrite.cut(0, 6, { data: 'body' });
		const writer = rewrite.writer(0);
		writer.replace(0, 2, 'X');
		writer.insertBefore(2, 'Y');
		writer.replace(4, 6, '');
		expect(collect(body)).toEqual(['X', 'Y', { source: s, start: 2, end: 4, data: 'body' }]);
	});

	test('a text without edits renders as one run', () => {
		const rewrite = createRewrite(s, 'abc');
		expect(collect(rewrite.cut(0, 3, { data: 'body' }))).toEqual([{ source: s, start: 0, end: 3, data: 'body' }]);
	});

	test('a cut that is never placed does not render, with the code in it, as a later render could place it', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = rewrite.cut(0, 6, { data: 'body' });
		const unplaced = rewrite.cut(2, 4, { data: 'unplaced' });
		rewrite.insertBefore(0, 'x');
		rewrite.insertBefore(3, 'y');
		rewrite.insertAfter(6, 'z');
		expect(render(body)).toBe('xabefz');
		expect(render(unplaced)).toBe('cyd');
	});

	test('a cut that is placed in code in a cut placed elsewhere renders there', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = rewrite.cut(0, 6, { data: 'body' });
		const outer = rewrite.cut(1, 5, { data: 'outer', placeholder: 'O' });
		const inner = rewrite.cut(2, 3, { data: 'inner', placeholder: 'I' });
		rewrite.insertAfter(3, ['[', outer, ']']);
		rewrite.insertBefore(6, ['{', inner, '}']);
		expect(render(body)).toBe('aOf{c[bIde]}');
	});
});

describe('construction errors', () => {
	test('a cut that crosses a cut is an error at the first render, and at every render after it', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = rewrite.cut(0, 6, { data: 'body' });
		rewrite.cut(0, 3, { data: 'a' });
		rewrite.cut(2, 5, { data: 'b' });
		const message = 'The cuts 0..3 and 2..5 cross; cuts are nested or disjoint.';
		expect(() => collect(body)).toThrow(message);
		expect(() => collect(body)).toThrow(message);
	});

	test('a cut that crosses a sibling other than its neighbours is an error', () => {
		const rewrite = createRewrite(s, 'abcdefg');
		const body = rewrite.cut(0, 7, { data: 'body' });
		rewrite.cut(1, 2, { data: 'a' });
		rewrite.cut(3, 6, { data: 'b' });
		rewrite.cut(0, 4, { data: 'c' });
		expect(() => collect(body)).toThrow('The cuts 0..4 and 3..6 cross');
	});

	test('cuts in any call order nest by their ranges', () => {
		const rewrite = createRewrite(s, 'abcdefg');
		const placeholder = (name: string) => ({ data: name, placeholder: `<${name}>` });
		const e = rewrite.cut(2, 6, placeholder('e'));
		const b = rewrite.cut(3, 6, placeholder('b'));
		const d = rewrite.cut(0, 6, placeholder('d'));
		const a = rewrite.cut(1, 2, placeholder('a'));
		const body = rewrite.cut(0, 7, { data: 'body' });
		rewrite.insertBefore(7, [a, d, e, b]);
		expect(render(body)).toBe('<d>gba<a><e>c<b>def');
	});

	test('of two cuts of one range, the later is inside the earlier', () => {
		const rewrite = createRewrite(s, 'abc');
		const outer = rewrite.cut(0, 3, { data: 'outer' });
		const inner = rewrite.cut(0, 3, { data: 'inner', placeholder: 'P' });
		expect(collect(outer)).toEqual(['P']);
		expect(collect(inner)).toEqual([{ source: s, start: 0, end: 3, data: 'inner' }]);
	});

	test('a zero-width cut with a placeholder is an error', () => {
		const rewrite = createRewrite(s, 'abc');
		expect(() => rewrite.cut(1, 1, { data: 'a', placeholder: 'P' })).toThrow('cannot have a placeholder');
	});

	test('a cut placed in code that only its own render renders is an error at the first render', () => {
		const inOwnRange = createRewrite(s, 'abcdef');
		const body = inOwnRange.cut(0, 6, { data: 'body' });
		const cut = inOwnRange.cut(1, 4, { data: 'cut' });
		inOwnRange.insertBefore(2, cut);
		const message = 'The cut 1..4 is placed inside itself, so it never renders.';
		expect(() => collect(body)).toThrow(message);
		expect(() => collect(cut)).toThrow(message);

		const inOwnPlaceholder = createRewrite(s, 'abcdef');
		const outer = inOwnPlaceholder.cut(1, 5, { data: 'outer' });
		const placeholder: RewriteCode<TestSource, string>[] = [];
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

	test('placing a cut twice is an error', () => {
		const rewrite = createRewrite(s, 'abc');
		const body = rewrite.cut(0, 3, { data: 'body' });
		collect(body);
		expect(() => collect(body)).toThrow('The cut 0..3 is placed twice.');
	});

	test('an edit after the first render is an error', () => {
		const rewrite = createRewrite(s, 'abc');
		const body = rewrite.cut(0, 3, { data: 'body' });
		collect(body);
		expect(() => rewrite.writer(0).insertBefore(1, 'x')).toThrow('The rewrite is already rendered.');
		expect(() => rewrite.cut(1, 2, { data: 'late' })).toThrow('The rewrite is already rendered.');
	});

	test('offsets out of the text, an empty replace and an invalid rank are errors', () => {
		const rewrite = createRewrite(s, 'abc');
		expect(() => rewrite.insertBefore(4, 'x')).toThrow('4..4 is out of 0..3.');
		expect(() => rewrite.writer(0).replace(2, 1, 'x')).toThrow('2..1 is out of 0..3.');
		expect(() => rewrite.writer(0).replace(1, 1, 'x')).toThrow('removes no char');
		expect(() => rewrite.writer(-1)).toThrow('is not a non-negative integer');
	});

	test('every writer cuts, and the cuts of all writers are nested or disjoint', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = rewrite.cut(0, 6, { data: 'body' });
		const moved = rewrite.writer(0).cut(1, 3, { data: 'moved', placeholder: 'P' });
		rewrite.writer(1).insertBefore(6, moved);
		expect(render(body)).toBe('aPdefbc');
		const crossed = createRewrite(s, 'abcdef');
		const crossedBody = crossed.cut(0, 6, { data: 'body' });
		crossed.writer(0).cut(1, 3, { data: 'moved' });
		crossed.writer(1).cut(2, 4, { data: 'crossing' });
		expect(() => collect(crossedBody)).toThrow('The cuts 1..3 and 2..4 cross');
	});
});

describe('properties', () => {
	test('random edits render every kept char once, in order and verbatim, in the fewest runs, and every code once', () => {
		const random = createRandom(1);
		for (let iteration = 0; iteration < 20000; iteration++) {
			const length = 1 + random(12);
			const rewrite = createRewrite(s, alphabet(length));
			const root = rewrite.cut(0, length, { data: 'root' });
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
					apply: (writer: RewriteWriter<TestSource, string>) =>
						kind === 0
							? writer.insertBefore(offset, tag)
							: kind === 1
							? writer.insertAfter(offset, tag)
							: writer.replace(start, end, tag),
				};
			});
			const renderEdits = (list: typeof edits) => {
				const rewrite = createRewrite(s, alphabet(length));
				const root = rewrite.cut(0, length, { data: 'root' });
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
			const segments = buildNestedCase(rewrite, testCase);
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

function buildNestedCase(rewrite: SourceRewrite<TestSource, string>, { length, cuts, edits }: ReturnType<typeof createNestedCase>) {
	const root = rewrite.cut(0, length, { data: 'root' });
	const slices: RewriteSlice<TestSource, string>[] = [];
	for (const cut of cuts) {
		// a cut not placed elsewhere renders in its own placeholder, which code reads when it renders
		const inPlace: RewriteCode<TestSource, string>[] = [];
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
	return renderPieces(root);
}

test('the package imports only its own modules and depends on nothing', () => {
	const src = path.join(__dirname, '../src');
	for (const file of fs.readdirSync(src)) {
		const specifiers = [...fs.readFileSync(path.join(src, file), 'utf8').matchAll(/ from '([^']*)';$/gm)];
		for (const [, specifier] of specifiers) {
			expect(specifier).toMatch(/^\.\//);
		}
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
	expect(pkg.dependencies).toBeUndefined();
	expect(pkg.peerDependencies).toBeUndefined();
});
