import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	createSourceRewrite,
	type Piece,
	type RewriteCode,
	type RewriteCutOptions,
	type RewritePart,
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

/** The view `start`..`end` of `rewrite`, by default of the whole text, as a slice. */
function view(
	rewrite: SourceRewrite<TestSource, string>,
	data = 'body',
	start = 0,
	end = sources.get(rewrite)!.content.length,
): RewriteSlice<TestSource, string> {
	return { render: sink => rewrite.render(start, end, data, sink) };
}

/** Cuts a range from the part of `rewrite` that holds it, of the parts that the cuts before left; outer cuts first. */
function createCutter(rewrite: SourceRewrite<TestSource, string>) {
	const parts: RewritePart<TestSource, string>[] = [rewrite.root];
	return (start: number, end: number, options: RewriteCutOptions<TestSource, string>) => {
		const index = parts.findIndex(part => part.start <= start && start < part.end && end <= part.end);
		const { before, slice, after } = parts[index]!.cut(start, end, options);
		parts.splice(index, 1, before, slice, after);
		return slice;
	};
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
	const body = view(rewrite);
	const typeArg = { start: text.indexOf('{'), end: text.lastIndexOf('}') + 1 };
	const { slice: alias } = rewrite.root.cut(typeArg.start, typeArg.end, { data: 'alias', placeholder: '__VLS_Props' });
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
			(writer: RewriteWriter<TestSource, string>) => writer.replace(call, call + 'useFoo()'.length, 'first()'),
			(writer: RewriteWriter<TestSource, string>) => writer.replace(name, name + 'Foo'.length, 'Second'),
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
		const { slice } = inner.root.cut(0, 3, { data: 'inner' });
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

	test('a slice is any code that renders, and renders through its own render', () => {
		const rewrite = createRewrite(s, 'ab');
		const body = view(rewrite);
		rewrite.insertAfter(1, [{ render: sink => sink('x') }, { render() {} }]);
		expect(render(body)).toBe('axb');
	});

	test('removals of two writers that overlap the edges of a moved cut remove the chars of both cuts', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const body = view(rewrite);
		rewrite.insertAfter(8, rewrite.root.cut(2, 6, { data: 'inner', placeholder: 'P' }).slice);
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
		const { slice: last } = rewrite.root.cut(5, 8, { data: 'last' });
		rewrite.insertAfter(0, last);
		rewrite.insertBefore(8, 'X');
		rewrite.insertAfter(8, 'Y');
		expect(render(body)).toBe('fghYabcdeX');
	});

	test('code at the start of the text stays before all text when a cut that starts there moves', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const body = view(rewrite);
		const { slice: first } = rewrite.root.cut(0, 3, { data: 'first' });
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
		const { slice: placed, after } = rewrite.root.cut(0, 1, { data: 'placed' });
		const { slice: unplaced } = after.cut(2, 4, { data: 'unplaced' });
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
		const { slice: outer } = rewrite.root.cut(1, 5, { data: 'outer', placeholder: 'O' });
		const { slice: inner } = outer.cut(2, 3, { data: 'inner', placeholder: 'I' });
		rewrite.insertAfter(3, ['[', outer, ']']);
		rewrite.insertBefore(6, ['{', inner, '}']);
		expect(render(body)).toBe('aOf{c[bIde]}');
	});
});

describe('construction errors', () => {
	test('a cut splits its part into the part before, the slice and the part after, which further cuts cut', () => {
		const rewrite = createRewrite(s, 'abcdefg');
		const { before, slice, after } = rewrite.root.cut(2, 5, { data: 'b', placeholder: '<b>' });
		expect([before, slice, after].map(({ start, end }) => [start, end])).toEqual([[0, 2], [2, 5], [5, 7]]);
		const { slice: a } = before.cut(0, 1, { data: 'a', placeholder: '<a>' });
		const { slice: c } = slice.cut(3, 4, { data: 'c', placeholder: '<c>' });
		rewrite.insertBefore(7, [a, slice, c]);
		expect(render(view(rewrite))).toBe('<a>b<b>fgac<c>ed');
	});

	test('a cut of the whole range of a slice is inside it', () => {
		const rewrite = createRewrite(s, 'abc');
		const { slice: outer } = rewrite.root.cut(0, 3, { data: 'outer' });
		const { slice: inner } = outer.cut(0, 3, { data: 'inner', placeholder: 'P' });
		expect(collect(outer)).toEqual(['P']);
		expect(collect(inner)).toEqual([{ source: s, start: 0, end: 3, data: 'inner' }]);
	});

	test('a cut of a used part, out of its part or of no char is an error', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const { after } = rewrite.root.cut(1, 3, { data: 'a' });
		expect(() => rewrite.root.cut(4, 5, { data: 'b' })).toThrow('The part 0..6 is already cut; cut its parts.');
		expect(() => after.cut(2, 4, { data: 'b' })).toThrow('The range 2..4 is out of the part 3..6.');
		expect(() => after.cut(4, 4, { data: 'b' })).toThrow('The cut at 4 moves no char.');
		after.cut(4, 5, { data: 'b' });
	});

	test('a cut placed in code that only its own render renders is an error at the first render', () => {
		const inOwnRange = createRewrite(s, 'abcdef');
		const body = view(inOwnRange);
		const { slice: cut } = inOwnRange.root.cut(1, 4, { data: 'cut' });
		inOwnRange.insertBefore(2, cut);
		const message = 'The cut 1..4 is placed inside itself, so it never renders.';
		expect(() => collect(body)).toThrow(message);
		expect(() => collect(cut)).toThrow(message);

		const inOwnPlaceholder = createRewrite(s, 'abcdef');
		const { slice: outer } = inOwnPlaceholder.root.cut(1, 5, { data: 'outer' });
		const placeholder: RewriteCode<TestSource, string>[] = [];
		outer.cut(2, 3, { data: 'inner', placeholder });
		placeholder.push(outer);
		expect(() => collect(outer)).toThrow('The cut 1..5 is placed inside itself');

		const inEachOther = createRewrite(s, 'abcdef');
		const { slice: whole } = inEachOther.root.cut(0, 6, { data: 'whole' });
		const { slice: first, after } = whole.cut(1, 2, { data: 'first' });
		const { slice: second } = after.cut(3, 4, { data: 'second' });
		inEachOther.insertBefore(1, second);
		inEachOther.insertBefore(3, first);
		expect(() => collect(whole)).toThrow('is placed inside itself');
	});

	test('a cut that its own render places is an error, also across rewrites', () => {
		const a = createRewrite(s, 'abc');
		const b = createRewrite(other, 'xyz');
		const { slice: aCut } = a.root.cut(0, 3, { data: 'a' });
		const { slice: bCut } = b.root.cut(0, 3, { data: 'b' });
		a.insertBefore(1, bCut);
		b.insertBefore(1, aCut);
		expect(() => collect(aCut)).toThrow('The cut 0..3 is placed inside itself, so it never renders.');
	});

	test('rendering a cut again is an error that tells how', () => {
		const rewrite = createRewrite(s, 'abc');
		const { slice: body } = rewrite.root.cut(0, 3, { data: 'body' });
		collect(body);
		expect(() => collect(body)).toThrow('The cut 0..3 is already rendered; a slice renders once.');

		const twice = createRewrite(s, 'abc');
		const whole = view(twice);
		const { slice: moved } = twice.root.cut(1, 2, { data: 'moved' });
		twice.insertBefore(0, moved);
		twice.insertBefore(3, moved);
		expect(() => collect(whole)).toThrow('The cut 1..2 is placed twice.');

		const placedAfter = createRewrite(s, 'abc');
		const after = view(placedAfter);
		const { slice: early } = placedAfter.root.cut(1, 2, { data: 'early' });
		placedAfter.insertBefore(3, early);
		collect(early);
		expect(() => collect(after)).toThrow('The cut 1..2 is already rendered; a slice renders once.');
	});

	test('a view renders again, and a slice placed in it is then placed twice', () => {
		const rewrite = createRewrite(s, 'abc');
		rewrite.insertBefore(1, 'x');
		expect([render(view(rewrite)), render(view(rewrite))]).toEqual(['axbc', 'axbc']);
		const placing = createRewrite(s, 'abc');
		placing.insertBefore(0, placing.root.cut(1, 2, { data: 'moved' }).slice);
		expect(render(view(placing))).toBe('bac');
		expect(() => render(view(placing))).toThrow('The cut 1..2 is placed twice.');
	});

	test('an edit after the first render is an error', () => {
		const rewrite = createRewrite(s, 'abc');
		const body = view(rewrite);
		collect(body);
		expect(() => rewrite.writer(0).insertBefore(1, 'x')).toThrow('The rewrite is already rendered.');
		expect(() => rewrite.root.cut(1, 2, { data: 'late' })).toThrow('The rewrite is already rendered.');
	});

	test('offsets out of the text, an empty replace and an invalid rank are errors', () => {
		const rewrite = createRewrite(s, 'abc');
		expect(() => rewrite.insertBefore(4, 'x')).toThrow('The offset 4 is out of 0..3.');
		expect(() => rewrite.writer(0).replace(2, 1, 'x')).toThrow('The range 2..1 is out of 0..3.');
		expect(() => rewrite.writer(0).replace(1, 1, 'x')).toThrow('The replace at 1 removes no char.');
		expect(() => rewrite.writer(-1)).toThrow('is not a non-negative integer');
		expect(() => rewrite.render(2, 4, 'v', () => {})).toThrow('The range 2..4 is out of 0..3.');
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
				const { slice: cut } = rewrite.root.cut(start, end, { data: 'moved', placeholder: '<P>' });
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
			const segments = renderPieces(view(buildNestedCase(rewrite, testCase), 'root'));
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
			const whole = buildNestedCase(createRewrite(s, alphabet(length)), testCase);
			const split = buildNestedCase(createRewrite(s, alphabet(length)), testCase);
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
function buildNestedCase(rewrite: SourceRewrite<TestSource, string>, { cuts, edits }: ReturnType<typeof createNestedCase>) {
	const cutRange = createCutter(rewrite);
	const slices: RewriteSlice<TestSource, string>[] = [];
	// outer first: of two cuts of one range, the earlier
	for (const cut of [...cuts].sort((a, b) => a.start - b.start || b.end - a.end || a.id - b.id)) {
		// a cut not placed elsewhere renders in its own placeholder, which code reads when it renders
		const inPlace: RewriteCode<TestSource, string>[] = [];
		const placeholder = cut.place ? `<P${cut.id}>` : inPlace;
		slices[cut.id] = cutRange(cut.start, cut.end, { data: `cut${cut.id}`, placeholder });
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
			expect(specifier).toMatch(/^\.\//);
		}
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
	expect(pkg.dependencies).toBeUndefined();
	expect(pkg.peerDependencies).toBeUndefined();
});
