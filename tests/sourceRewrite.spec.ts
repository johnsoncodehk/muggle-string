import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	createSourceRewrite,
	type Piece,
	type RewriteCode,
	type RewriteOrigin,
	type RewriteSlice,
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

/** A source of pieces of generated code, which no rewrite edits. */
const otherSource: TestSource = { name: other, content: 'wxyz' };

function createRewrite(name: string, content: string) {
	return createSourceRewrite<TestSource, TestData>({ name, content });
}

/** The pieces of `slice`, as the render passes them, kept text by default with the data `self`. */
function renderPieces(slice: RewriteSlice<TestSource, TestData>) {
	const pieces: TestPiece[] = [];
	slice.render(piece => pieces.push(piece), { data: 'self' });
	return pieces;
}

/** The pieces of `slice`: text, and kept source ranges, by the name of their source, with the data of their cut. */
function collect(slice: RewriteSlice<TestSource, TestData>): NamedPiece[] {
	return renderPieces(slice).map(piece =>
		typeof piece === 'string' || piece.text !== undefined ? piece : { ...piece, source: piece.source.name }
	);
}

function toText(pieces: TestPiece[]) {
	return pieces.map(rewritePieceText).join('');
}

function render(slice: RewriteSlice<TestSource, TestData>) {
	return toText(renderPieces(slice));
}

/** The view `start`..`end` of `rewrite`, by default of the whole text, as a slice. */
function view(
	rewrite: SourceRewrite<TestSource, TestData>,
	data = 'body',
	start = 0,
	end = rewrite.source.content.length,
): RewriteSlice<TestSource, TestData> {
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
	rewrite.wrap(text.indexOf(statement), text.length, ['type __VLS_Props = ', alias, ';\n'], '');
	return { rewrite, body, typeArg };
}

describe('scenarios', () => {
	test('the rewrite moves a type argument into an alias', () => {
		const { body } = defineProps('const props = defineProps<{ a: string }>();');
		expect(render(body)).toBe('type __VLS_Props = { a: string };\nconst props = defineProps<__VLS_Props>();');
	});

	test('code of a range before a moved range stays at its origin', () => {
		const { rewrite, body, typeArg } = defineProps('const props = defineProps<{ a: string }>();');
		rewrite.wrap(typeArg.start - 1, typeArg.start, '', '/* a */');
		rewrite.wrap(typeArg.start - 1, typeArg.start, '', '/* b */');
		expect(render(body)).toBe(
			'type __VLS_Props = { a: string };\nconst props = defineProps</* a *//* b */__VLS_Props>();',
		);
	});

	test('a wrap of a moved range travels with it', () => {
		const { rewrite, body, typeArg } = defineProps('const props = defineProps<{ a: string }>();');
		rewrite.wrap(typeArg.start, typeArg.end, 'Wrap<', '>');
		expect(render(body)).toBe('type __VLS_Props = Wrap<{ a: string }>;\nconst props = defineProps<__VLS_Props>();');
	});

	test('a replace inside a moved range applies to the moved text, which stays verbatim', () => {
		const text = 'const props = defineProps<{ a: string }>();';
		const { rewrite, body } = defineProps(text);
		const start = text.indexOf('string');
		rewrite.replace(start, start + 'string'.length, 'number');
		const segments = renderPieces(body);
		expect(toText(segments)).toBe('type __VLS_Props = { a: number };\nconst props = defineProps<__VLS_Props>();');
		renderedOffsets(rewrite, segments);
	});

	test('nested replaces keep both codes at their own starts, whatever the order of the calls', () => {
		const text = 'const a = useFoo();';
		const call = text.indexOf('useFoo()');
		const name = text.indexOf('Foo');
		const edits = [
			(rewrite: SourceRewrite<TestSource, TestData>) => rewrite.replace(call, call + 'useFoo()'.length, 'first()'),
			(rewrite: SourceRewrite<TestSource, TestData>) => rewrite.replace(name, name + 'Foo'.length, 'Second'),
		];
		for (const order of [[0, 1], [1, 0]]) {
			const rewrite = createRewrite(s, text);
			const body = view(rewrite);
			for (const edit of order) {
				edits[edit]!(rewrite);
			}
			expect(render(body)).toBe('const a = first()Second;');
		}
	});

	test('replaces of one range keep both codes, in call order', () => {
		const text = 'const a = useFoo();';
		const rewrite = createRewrite(s, text);
		const body = view(rewrite);
		const call = text.indexOf('useFoo()');
		rewrite.replace(call, call + 8, 'A()');
		rewrite.replace(call, call + 8, 'B()');
		expect(render(body)).toBe('const a = A()B();');
	});

	test('code at a boundary of two views renders with the range it belongs to, and a removal across them splits', () => {
		const text = `import { a } from 'a';\nconst b = a;`;
		const rewrite = createRewrite(s, text);
		const importEnd = text.indexOf('\n') + 1;
		const imports = view(rewrite, 'imports', 0, importEnd);
		const body = view(rewrite, 'body', importEnd);
		rewrite.wrap(0, importEnd, '', '/*end of imports*/');
		rewrite.wrap(importEnd, text.length, '/*start of body*/', '');
		rewrite.replace(text.indexOf(`'a';`), text.indexOf('const') + 'const'.length, `'b'; let`);
		expect([render(imports), render(body)]).toEqual([
			`import { a } from 'b'; let/*end of imports*/`,
			'/*start of body*/ b = a;',
		]);
	});

	test('a replace of the first token of a statement goes inside the code before the statement', () => {
		const { rewrite, body } = defineProps('const props = defineProps<{ a: string }>();');
		rewrite.replace(0, 5, 'let');
		expect(render(body)).toBe('type __VLS_Props = { a: string };\nlet props = defineProps<__VLS_Props>();');
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
		rewrite.wrap(0, 1, '', [mapped, [[''], 'y']]);
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
		rewrite.wrap(1, 2, ['x', { source: otherSource, start: 0, end: 0, data: 'mapped', text: 'y' }], '');
		expect(collect(view(rewrite))).toStrictEqual([
			{ source: s, start: 0, end: 1, data: 'body' },
			'x',
			{ source: otherSource, start: 0, end: 0, data: 'mapped', text: 'y' },
			{ source: s, start: 1, end: 2, data: 'body' },
		]);
	});

	test('a slice of another rewrite renders the text and edits of its own rewrite', () => {
		const inner = createRewrite(other, 'xyz');
		inner.replace(1, 2, 'Y');
		const slice = inner.cut(0, 3, { data: 'inner' });
		const rewrite = createRewrite(s, 'abc');
		rewrite.replace(0, 1, 'A');
		const body = view(rewrite);
		rewrite.wrap(1, 2, '', slice);
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
		rewrite.wrap(0, 1, '', [{ render: sink => sink('x') }, { render() {} }]);
		expect(render(body)).toBe('axb');
	});

	test('overlapping removals at the edges of a moved cut remove the chars of both cuts', () => {
		const rewrite = createRewrite(s, 'abcdefgh');
		const body = view(rewrite);
		rewrite.wrap(0, 8, '', rewrite.cut(2, 6, { data: 'inner', placeholder: 'P' }));
		rewrite.replace(1, 4, 'X');
		rewrite.replace(3, 7, 'Y');
		expect(render(body)).toBe('aXPhY');
	});
});

describe('wraps', () => {
	test('wraps nest by their ranges, whatever the order of the calls', () => {
		for (const outerFirst of [true, false]) {
			const rewrite = createRewrite(s, 'xyz');
			const wraps = [
				() => rewrite.wrap(0, 3, '(', ')'),
				() => rewrite.wrap(1, 3, '[', ']'),
				() => rewrite.wrap(0, 1, '{', '}'),
			];
			for (const wrap of outerFirst ? wraps : wraps.reverse()) {
				wrap();
			}
			expect(render(view(rewrite))).toBe('({x}[yz])');
		}
	});

	test('of one range, a later wrap goes outside, so befores render in reverse call order and afters in call order', () => {
		const rewrite = createRewrite(s, 'x');
		rewrite.wrap(0, 1, '(', ')');
		rewrite.wrap(0, 1, '[', ']');
		rewrite.wrap(0, 1, 'A', '');
		rewrite.wrap(0, 1, '', 'B');
		expect(render(view(rewrite))).toBe('A[(x)]B');
	});

	test('the order at a char: befores of wraps by end, the replacement, the char, afters of wraps by start', () => {
		const rewrite = createRewrite(s, 'abc');
		rewrite.wrap(1, 2, '<1', '>1');
		rewrite.wrap(0, 2, '<0', '>0');
		rewrite.wrap(1, 3, '<3', '>3');
		rewrite.replace(1, 2, 'R');
		expect(render(view(rewrite))).toBe('<0a<3<1R>1>0c>3');
	});

	test('edits that arrive out of order render in order', () => {
		const rewrite = createRewrite(s, 'abcdef');
		rewrite.wrap(3, 5, '', 'A');
		rewrite.replace(4, 5, 'R');
		rewrite.wrap(1, 2, 'B', '');
		rewrite.wrap(3, 5, '', 'C');
		rewrite.replace(1, 2, 'S');
		rewrite.wrap(1, 2, 'D', '');
		expect(render(view(rewrite))).toBe('aDBScdRACf');
	});

	test('a wrap renders its before with the first char of its range, and its after with the last', () => {
		const rewrite = createRewrite(s, 'abcd');
		rewrite.wrap(1, 3, '(', ')');
		const views = [[0, 4], [1, 3], [0, 2], [2, 4], [1, 1], [3, 3]] as const;
		expect(views.map(([start, end]) => render(view(rewrite, 'v', start, end)))).toEqual([
			'a(bc)d',
			'(bc)',
			'a(b',
			'c)d',
			'',
			'',
		]);
	});

	test('an empty range is at the char at its offset, and at the end of the text after it', () => {
		const rewrite = createRewrite(s, 'ab');
		rewrite.replace(1, 1, 'R');
		rewrite.wrap(1, 1, '[', ']');
		rewrite.wrap(1, 1, '{', '}');
		rewrite.wrap(1, 2, '(', ')');
		rewrite.wrap(0, 1, '<', '>');
		rewrite.replace(2, 2, 'E');
		const views = [[0, 2], [0, 1], [1, 2], [1, 1], [2, 2]] as const;
		expect(views.map(([start, end]) => render(view(rewrite, 'v', start, end)))).toEqual([
			'<a>({[R]}b)E',
			'<a>',
			'({[R]}b)E',
			'',
			'E',
		]);
	});

	test('an empty text has its code at its end', () => {
		const rewrite = createRewrite(s, '');
		rewrite.wrap(0, 0, 'A', 'B');
		rewrite.replace(0, 0, 'x');
		rewrite.wrap(0, 0, '(', ')');
		expect(render(view(rewrite))).toBe('(AxB)');
	});

	test('a wrap moves with a cut of a range that holds it, and stays around a cut that it holds', () => {
		const rewrite = createRewrite(s, 'abcdef');
		rewrite.wrap(0, 6, '<', '>');
		rewrite.wrap(1, 4, '[', ']');
		rewrite.wrap(2, 4, '(', ')');
		rewrite.wrap(3, 4, '{', '}');
		rewrite.wrap(0, 6, '', rewrite.cut(2, 4));
		expect(render(view(rewrite))).toBe('<a[b]ef>(c{d})');
	});

	test('random wraps nest, each around the text of its range', () => {
		const random = createRandom(5);
		for (let iteration = 0; iteration < 5000; iteration++) {
			const length = 1 + random(10);
			const rewrite = createRewrite(s, alphabet(length));
			const wraps: { start: number; end: number; id: number }[] = [];
			for (let count = random(8); count > 0; count--) {
				const start = random(length + 1);
				const end = start + random(length - start + 1);
				const id = wraps.length;
				wraps.push({ start, end, id });
				rewrite.wrap(start, end, `(${id}`, `)${id}`);
			}
			const text = render(view(rewrite));
			const stack: number[] = [];
			const crossing = (a: typeof wraps[number], b: typeof wraps[number]) =>
				a.start < b.start && b.start < a.end && a.end < b.end;
			if (!wraps.some(a => wraps.some(b => crossing(a, b)))) {
				for (const [, kind, id] of text.matchAll(/([()])(\d+)/g)) {
					if (kind === '(') {
						stack.push(Number(id));
					}
					else {
						expect(stack.pop()).toBe(Number(id));
					}
				}
				expect(stack).toEqual([]);
			}
			for (const { start, end, id } of wraps) {
				const inside = text.slice(text.indexOf(`(${id}`), text.indexOf(`)${id}`));
				expect(inside.replace(/[()]\d+/g, '')).toBe(alphabet(length).slice(start, end));
			}
		}
	});

	test('random wraps and replaces render the same whatever the order of the calls of different ranges', () => {
		const random = createRandom(2);
		for (let iteration = 0; iteration < 5000; iteration++) {
			const length = 1 + random(10);
			const edits = Array.from({ length: random(7) }, (_, index) => {
				const start = random(length + 1);
				const end = start + random(length - start + 1);
				const replace = random(3) === 0 && start < end;
				return {
					range: replace ? `r${start}` : `${start}..${end}`,
					apply: (rewrite: SourceRewrite<TestSource, TestData>) =>
						replace
							? rewrite.replace(start, end, `#${index}`)
							: rewrite.wrap(start, end, `(${index}`, `)${index}`),
				};
			});
			const renderEdits = (list: typeof edits) => {
				const rewrite = createRewrite(s, alphabet(length));
				for (const edit of list) {
					edit.apply(rewrite);
				}
				return render(view(rewrite));
			};
			// a random order that keeps the order of the edits of one range
			const shuffled = edits.map(edit => ({ edit, key: random(100) })).sort((a, b) => a.key - b.key).map(({ edit }) => edit);
			const queues = new Map<string, typeof edits>();
			for (const edit of edits) {
				queues.set(edit.range, [...queues.get(edit.range) ?? [], edit]);
			}
			const reordered = shuffled.map(edit => queues.get(edit.range)!.shift()!);
			expect(renderEdits(reordered)).toBe(renderEdits(edits));
		}
	});
});

describe('data', () => {
	test('a slice without data renders its kept text with the data of the code it renders in', () => {
		const rewrite = createRewrite(s, 'abcd');
		rewrite.wrap(0, 2, rewrite.cut(2, 4), '');
		expect(collect(view(rewrite, 'view'))).toEqual([
			{ source: s, start: 2, end: 4, data: 'view' },
			{ source: s, start: 0, end: 2, data: 'view' },
		]);
	});

	test('the data of a cut goes over the data of the code it renders in', () => {
		type Fields = { data: string; extra?: string };
		const source = { name: s, content: 'abcd' };
		const rewrite = createSourceRewrite<TestSource, Fields>(source);
		const inner = rewrite.cut(3, 4);
		const outer = rewrite.cut(1, 3, { extra: 'outer' });
		rewrite.wrap(0, 1, [outer, inner], '');
		const pieces: Piece<RewriteOrigin<TestSource, Fields>>[] = [];
		rewrite.render(0, 4, piece => pieces.push(piece), { data: 'view' });
		expect(pieces).toEqual([
			{ source, start: 1, end: 3, data: 'view', extra: 'outer' },
			{ source, start: 3, end: 4, data: 'view' },
			{ source, start: 0, end: 1, data: 'view' },
		]);
	});

	test('a slice placed in a moved slice renders with its data, and by itself with the data it is given', () => {
		const rewrite = createRewrite(s, 'abcd');
		const moved = rewrite.cut(0, 2, { data: 'moved' });
		rewrite.wrap(0, 1, '', rewrite.cut(3, 4));
		rewrite.wrap(2, 4, '', moved);
		expect(collect(view(rewrite, 'view'))).toEqual([
			{ source: s, start: 2, end: 3, data: 'view' },
			{ source: s, start: 0, end: 1, data: 'moved' },
			{ source: s, start: 3, end: 4, data: 'moved' },
			{ source: s, start: 1, end: 2, data: 'moved' },
		]);
		const alone = createRewrite(s, 'ab').cut(0, 1);
		expect(collect(alone)).toEqual([{ source: s, start: 0, end: 1, data: 'self' }]);
	});
});

describe('runs', () => {
	test('a removal next to a run boundary or code renders no empty run', () => {
		const rewrite = createRewrite(s, 'abcdef');
		const body = view(rewrite);
		rewrite.replace(0, 2, 'X');
		rewrite.wrap(2, 3, 'Y', '');
		rewrite.replace(4, 6, '');
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
		rewrite.wrap(0, 1, 'x', '');
		rewrite.wrap(3, 4, 'y', '');
		rewrite.wrap(1, 6, '', ['z', placed]);
		expect(rewrite.unrendered()).toEqual([placed, unplaced]);
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
		rewrite.wrap(2, 3, '', ['[', outer, ']']);
		rewrite.wrap(0, 6, '', ['{', inner, '}']);
		expect(render(body)).toBe('aOf{c[bIde]}');
	});
});

describe('construction errors', () => {
	test('cuts in any order nest by range: a later cut around earlier ones holds them', () => {
		const rewrite = createRewrite(s, 'abcdefg');
		const a = rewrite.cut(0, 1, { data: 'a', placeholder: '<a>' });
		const c = rewrite.cut(3, 4, { data: 'c', placeholder: '<c>' });
		const b = rewrite.cut(2, 5, { data: 'b', placeholder: '<b>' });
		rewrite.wrap(0, 7, '', [a, b, c]);
		expect(render(view(rewrite))).toBe('<a>b<b>fgac<c>ed');
	});

	test('of two cuts of one range, the later is inside the earlier', () => {
		const rewrite = createRewrite(s, 'abc');
		const outer = rewrite.cut(0, 3, { data: 'outer' });
		const inner = rewrite.cut(0, 3, { data: 'inner', placeholder: 'P' });
		expect(render(outer)).toBe('P');
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

	test('a wrap that crosses a cut is an error at the first render', () => {
		const starting = createRewrite(s, 'abcdef');
		starting.wrap(3, 6, '(', ')');
		starting.cut(1, 4);
		expect(() => render(view(starting))).toThrow('The wrap 3..6 crosses the cut 1..4.');
		const ending = createRewrite(s, 'abcdef');
		ending.wrap(0, 3, '(', ')');
		ending.cut(2, 5);
		expect(() => render(view(ending))).toThrow('The wrap 0..3 crosses the cut 2..5.');
		const around = createRewrite(s, 'abcdef');
		around.wrap(1, 5, '(', ')');
		around.wrap(2, 4, '[', ']');
		around.wrap(0, 6, '', around.cut(2, 4));
		expect(render(view(around))).toBe('a(be)f[cd]');
	});

	test('a rewrite whose pieces carry no fields beyond their source takes none in its cuts and views', () => {
		const source = { content: 'abc' };
		const rewrite = createSourceRewrite(source);
		expect(rewrite.source).toBe(source);
		const moved = rewrite.cut(1, 2);
		rewrite.replace(0, 1, { source, start: 0, end: 1, text: 'A' });
		rewrite.wrap(0, 3, '', moved);
		const pieces: Piece<RewriteOrigin<typeof source, {}>>[] = [];
		rewrite.render(0, 3, piece => pieces.push(piece));
		expect(pieces.map(rewritePieceText).join('')).toBe('Acb');
	});

	test('a cut placed in code that only its own render renders is an error at the first render', () => {
		const inOwnRange = createRewrite(s, 'abcdef');
		const body = view(inOwnRange);
		const cut = inOwnRange.cut(1, 4, { data: 'cut' });
		inOwnRange.wrap(2, 3, cut, '');
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
		inEachOther.wrap(1, 2, second, '');
		inEachOther.wrap(3, 4, first, '');
		expect(() => collect(whole)).toThrow('is placed inside itself');
	});

	test('a cut that its own render places is an error, also across rewrites', () => {
		const a = createRewrite(s, 'abc');
		const b = createRewrite(other, 'xyz');
		const aCut = a.cut(0, 3, { data: 'a' });
		const bCut = b.cut(0, 3, { data: 'b' });
		a.wrap(1, 2, bCut, '');
		b.wrap(1, 2, aCut, '');
		expect(() => collect(aCut)).toThrow('The cut 0..3 is placed inside itself, so it never renders.');
	});

	test('rendering a cut again is an error that tells how', () => {
		const rewrite = createRewrite(s, 'abc');
		const body = rewrite.cut(0, 3, { data: 'body' });
		collect(body);
		expect(() => collect(body)).toThrow('The cut 0..3 is already rendered; a slice renders once.');

		const twice = createRewrite(s, 'abc');
		const whole = view(twice);
		const moved = twice.cut(1, 2, { data: 'moved' });
		twice.wrap(0, 1, moved, '');
		twice.wrap(2, 3, '', moved);
		expect(() => collect(whole)).toThrow('The cut 1..2 is placed twice.');

		const placedAfter = createRewrite(s, 'abc');
		const after = view(placedAfter);
		const early = placedAfter.cut(1, 2, { data: 'early' });
		placedAfter.wrap(2, 3, '', early);
		collect(early);
		expect(() => collect(after)).toThrow('The cut 1..2 is already rendered; a slice renders once.');
	});

	test('a view renders again, and a slice placed in it is then placed twice', () => {
		const rewrite = createRewrite(s, 'abc');
		rewrite.wrap(1, 2, 'x', '');
		expect([render(view(rewrite)), render(view(rewrite))]).toEqual(['axbc', 'axbc']);
		const placing = createRewrite(s, 'abc');
		placing.wrap(0, 1, placing.cut(1, 2, { data: 'moved' }), '');
		expect(render(view(placing))).toBe('bac');
		expect(() => render(view(placing))).toThrow('The cut 1..2 is placed twice.');
	});

	test('an edit after the first render is an error', () => {
		const rewrite = createRewrite(s, 'abc');
		const body = view(rewrite);
		collect(body);
		expect(() => rewrite.wrap(1, 2, 'x', '')).toThrow('The rewrite is already rendered.');
		expect(() => rewrite.replace(1, 2, 'x')).toThrow('The rewrite is already rendered.');
		expect(() => rewrite.cut(1, 2, { data: 'late' })).toThrow('The rewrite is already rendered.');
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
		expect(rewritePieceText({ source, start: 0, end: 50, text: 'x' })).toBe('x');
		expect(rewritePieceText({ source, start: 3, end: 3 })).toBe('');
	});

	test('ranges out of the text are errors', () => {
		const rewrite = createRewrite(s, 'abc');
		expect(() => rewrite.wrap(4, 4, 'x', '')).toThrow('The offset 4 is out of 0..3.');
		expect(() => rewrite.wrap(1, 4, '(', ')')).toThrow('The range 1..4 is out of 0..3.');
		expect(() => rewrite.replace(2, 1, 'x')).toThrow('The range 2..1 is out of 0..3.');
		expect(() => rewrite.replace(0.5, 1, 'x')).toThrow('The range 0.5..1 is out of 0..3.');
		expect(() => rewrite.render(2, 4, () => {}, { data: 'v' })).toThrow('The range 2..4 is out of 0..3.');
	});

	test('a render after the content of the source changed is an error', () => {
		const source = { name: s, content: 'abc' };
		const rewrite = createSourceRewrite<TestSource, TestData>(source);
		const slice = rewrite.cut(0, 1);
		source.content = 'abd';
		const message = 'The content of the source changed after the rewrite was made.';
		expect(() => render(view(rewrite))).toThrow(message);
		expect(() => render(slice)).toThrow(message);
		source.content = 'abc';
		expect(render(view(rewrite))).toBe('bc');
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
				const at = random(start);
				rewrite.wrap(at, at + 1, ['{', cut, '}'], '');
			}
			const removals: [number, number][] = [];
			const tags: string[] = [];
			for (let edit = random(6); edit > 0; edit--) {
				const tag = `#${tags.length}`;
				let start = random(length + 1);
				let end = start + random(length - start + 1);
				if (random(3) === 0) {
					rewrite.replace(start, end, tag);
					removals.push([start, end]);
				}
				else {
					// around the moved range or outside it
					if (moved && start < moved.end && moved.start < end && !(start <= moved.start && moved.end <= end)) {
						[start, end] = [moved.start, moved.end];
					}
					rewrite.wrap(start, end, tag, '');
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

	test('random nested cuts render every kept char once and verbatim in the fewest runs, every code once, the code around the text around it', () => {
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
				expect(text.split(edit.tag).length).toBe(edit.kind === 'wrap' ? 3 : 2);
			}
			const whole = testCase.edits.filter(edit => edit.kind === 'wrap' && edit.start === 0 && edit.end === length);
			// a cut of the whole text holds the wraps of it
			if (whole.length && !testCase.cuts.some(cut => cut.start === 0 && cut.end === length)) {
				expect(text.startsWith(`(${whole.at(-1)!.tag}`)).toBe(true);
				// an empty range at the end of the text renders after the last char and its code
				if (!testCase.edits.some(edit => edit.start === length && edit.end === length)) {
					expect(text.endsWith(`)${whole.at(-1)!.tag}`)).toBe(true);
				}
			}
		}
		expect(nested).toBeGreaterThan(1000);
	});

	test('random views that split the text render what one view of the text renders', () => {
		const random = createRandom(4);
		for (let iteration = 0; iteration < 5000; iteration++) {
			const length = 1 + random(14);
			const testCase = createNestedCase(random, length);
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
	kind: 'wrap' | 'replace';
	start: number;
	end: number;
	tag: string;
}

/** Random edits and a random family of nested or disjoint cuts, each placed in place or at a char of its parent. */
function createNestedCase(random: (below: number) => number, length: number) {
	const cuts: NestedCut[] = [];
	const crosses = (a: number, b: number) =>
		cuts.some(cut => (cut.start < a && a < cut.end && cut.end < b) || (a < cut.start && cut.start < b && b < cut.end));
	const grow = (start: number, end: number, depth: number) => {
		if (depth > 3 || end - start < 1) {
			return;
		}
		for (let count = random(3); count > 0; count--) {
			const a = start + random(end - start);
			const b = a + 1 + random(end - a);
			if (crosses(a, b)) {
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
	for (let count = random(8); count > 0; count--) {
		const start = random(length + 1);
		const end = start + random(length - start + 1);
		if (random(3) === 0) {
			if (start < end) {
				edits.push({ kind: 'replace', start, end, tag: `#${edits.length}` });
			}
		}
		else if (!crosses(start, end)) {
			edits.push({ kind: 'wrap', start, end, tag: `#${edits.length}` });
		}
	}
	if (random(2)) {
		edits.push({ kind: 'wrap', start: 0, end: length, tag: `#${edits.length}` });
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
			const { at, after } = cut.place;
			rewrite.wrap(at, at + 1, after ? '' : code, after ? code : '');
		}
	}
	for (const edit of edits) {
		if (edit.kind === 'replace') {
			rewrite.replace(edit.start, edit.end, edit.tag);
		}
		else {
			rewrite.wrap(edit.start, edit.end, `(${edit.tag}`, `)${edit.tag}`);
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
	expect(stdout.trim()).toBe('createSourceRewrite,renderWithSourceMap,rewritePieceText');
});
