import { decodedMappings, originalPositionFor, TraceMap, traceSegment } from '@jridgewell/trace-mapping';
import { SourceMap as NodeSourceMap } from 'node:module';
import { describe, expect, test, vi } from 'vitest';
import {
	createSourceRewrite,
	type DecodedSourceMap,
	decodeMappings,
	encodeMappings,
	type Piece,
	renderWithDecodedSourceMap,
	renderWithSourceMap,
	rewritePieceText,
	type SourceMap,
} from '../src';

interface TestSource {
	name: string;
	content: string;
}

type TestPiece = Piece<{ source: TestSource; name?: string }>;
type Position = { source: string; offset: number; name: string | null };

function render(pieces: TestPiece[]) {
	return renderWithSourceMap<TestSource>(sink => pieces.forEach(sink), source => source.name);
}

function renderDecoded(pieces: TestPiece[]) {
	return renderWithDecodedSourceMap<TestSource>(sink => pieces.forEach(sink), source => source.name);
}

/** What `renderWithDecodedSourceMap` must give where `renderWithSourceMap` gives `rendered`: its mappings decoded. */
function decodedOf(rendered: { text: string; map: SourceMap }): { text: string; map: DecodedSourceMap } {
	return {
		text: rendered.text,
		map: { ...rendered.map, mappings: decodedMappings(new TraceMap(rendered.map as never)) as DecodedSourceMap['mappings'] },
	};
}

/** The message of what `run` throws, or `undefined`. */
function thrown(run: () => unknown) {
	try {
		run();
	}
	catch (error) {
		return `${(error as Error).name}: ${(error as Error).message}`;
	}
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

function classOf(char: string) {
	return /\s/.test(char) ? 'space' : /[\p{L}\p{M}\p{N}]/u.test(char) ? 'word' : 'other';
}

/** The class of the char that starts at `index` of `text`, or `undefined` in the second half of a surrogate pair. */
function classAt(text: string, index: number) {
	return /[\udc00-\udfff]/.test(text[index]!) && /[\ud800-\udbff]/.test(text[index - 1] ?? '')
		? undefined
		: classOf(String.fromCodePoint(text.codePointAt(index)!));
}

/**
 * Where each generated char of `pieces` must map, by line and column: a kept char at the start of its piece, its line,
 * a word, a run of whitespace or as another char to itself, the `text` of a range to the start of the range at the
 * start of each of its lines but an empty last one, anything else nowhere, and `undefined` where the char before it maps.
 * The first position of a range with `text` has its `name`.
 */
function expected(pieces: TestPiece[]) {
	const result: (Position | null)[][] = [[]];
	for (const piece of pieces) {
		const text = rewritePieceText(piece);
		let name = typeof piece === 'string' || piece.text === undefined ? null : piece.name ?? null;
		const at = (offset: number) => {
			const position = { source: (piece as Exclude<TestPiece, string>).source.name, offset, name };
			name = null;
			return position;
		};
		for (let i = 0; i < text.length; i++) {
			if (text[i] === '\n') {
				result.push([]);
				continue;
			}
			const line = result[result.length - 1]!;
			if (typeof piece === 'string') {
				line.push(null);
			}
			else if (piece.text === undefined) {
				const kind = classAt(text, i);
				const before = i === 0 || text[i - 1] === '\n' ? undefined : classAt(text, i - 1) ?? classAt(text, i - 2);
				const boundary = kind !== undefined && (kind !== before || kind === 'other');
				line.push(boundary ? at(piece.start + i) : undefined as never);
			}
			else {
				const lineStart = i === 0 || text[i - 1] === '\n';
				line.push(lineStart ? at(piece.start) : undefined as never);
			}
		}
	}
	return result;
}

const lineStartsOf = new Map<string, number[]>();

function offsetOf(map: SourceMap, source: string, line: number, column: number) {
	const content = map.sourcesContent[map.sources.indexOf(source)]!;
	let lineStarts = lineStartsOf.get(content);
	if (!lineStarts) {
		lineStarts = [0];
		for (const text of content.split('\n')) {
			lineStarts.push(lineStarts[lineStarts.length - 1]! + text.length + 1);
		}
		lineStartsOf.set(content, lineStarts);
	}
	return lineStarts[line]! + column;
}

/**
 * Checks the map of `pieces` at every generated char against `expected`, as the greatest lower bound on the line of
 * trace-mapping and the one across lines of Node, which reads a segment without a source as no original position,
 * and that the decoded map is the same map.
 */
function check(pieces: TestPiece[]) {
	const { text, map } = render(pieces);
	expect(text).toBe(pieces.map(rewritePieceText).join(''));
	const decoded = renderDecoded(pieces);
	expect(decoded).toEqual(decodedOf({ text, map }));
	expect(encodeMappings(decoded.map.mappings)).toBe(map.mappings);
	expect(decodeMappings(map.mappings)).toEqual(decoded.map.mappings);
	const trace = new TraceMap(map as never);
	const node = new NodeSourceMap(map);
	expected(pieces).forEach((chars, line) => {
		let before: Position | null = null;
		chars.forEach((want, column) => {
			const got = originalPositionFor(trace, { line: line + 1, column });
			const at = got.source === null
				? null
				: { source: got.source, offset: offsetOf(map, got.source, got.line - 1, got.column), name: got.name };
			const entry = node.findEntry(line, column) as {
				originalSource?: string;
				originalLine: number;
				originalColumn: number;
				name?: string;
			};
			const nodeAt = entry.originalSource === undefined
				? null
				: {
					source: entry.originalSource,
					offset: offsetOf(map, entry.originalSource, entry.originalLine, entry.originalColumn),
					name: entry.name ?? null,
				};
			if (want === undefined) {
				want = before!;
			}
			expect(at, `${line}:${column}`).toEqual(want);
			expect(nodeAt, `node ${line}:${column}`).toEqual(want);
			before = want;
		});
	});
	return { text, map };
}

const main: TestSource = { name: 'main.js', content: 'const a = 1;\nlog(a);\n' };
const other: TestSource = { name: 'other.js', content: 'x\ny\nz' };

describe('renderWithSourceMap', () => {
	test('kept text maps at the start of each word, run of whitespace and other char, across lines', () => {
		const { map } = check([{ source: main, start: 0, end: main.content.length }]);
		expect(map).toEqual({
			version: 3,
			sources: ['main.js'],
			sourcesContent: [main.content],
			names: [],
			mappings: 'AAAA,KAAK,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC;AACX,GAAG,CAAC,CAAC,CAAC;',
		});
	});

	test('words are runs of Unicode letters, marks and digits, so the joiners of each syntax map on their own', () => {
		const sfc: TestSource = {
			name: 'App.vue',
			content: '<div v-on:click="$emit_1">名前\u3000é</div>\n'
				+ '<script>const 𝒜b = "😀😀";</script>\n<style>.a-b { --main-color: 10px }</style>\n',
		};
		const { map } = check([{ source: sfc, start: 0, end: sfc.content.length }]);
		const node = new NodeSourceMap(map);
		const at = (column: number) => (node.findEntry(0, column) as { originalColumn: number }).originalColumn;
		expect([at(7), at(17), at(18), at(22), at(28)]).toEqual([7, 17, 18, 22, 28]);
	});

	test('new text maps nowhere, and ends the mapping of the text before it on its line', () => {
		const { map } = check([{ source: main, start: 0, end: 5 }, ' /* new */', { source: main, start: 5, end: 12 }]);
		const trace = new TraceMap(map as never);
		expect(traceSegment(trace, 0, 5)).toEqual([5]);
		expect(traceSegment(trace, 0, 14)).toEqual([5]);
		expect(traceSegment(trace, 0, 15)).toEqual([15, 0, 0, 5]);
	});

	test('new text that starts a line maps nowhere by a segment without a source, so that no line before reaches it', () => {
		const { map } = check([{ source: main, start: 0, end: 13 }, 'new\n', { source: main, start: 13, end: 21 }]);
		expect(map.mappings.split(';')[1]).toBe('A');
	});

	test('mappings that end with a segment without a source end with a line, which Node reads as no original position', () => {
		const { map } = check([{ source: main, start: 0, end: 12 }, ' new']);
		expect(map.mappings.endsWith(',C;')).toBe(true);
		const { map: newLine } = check([{ source: main, start: 0, end: 13 }, 'new']);
		expect(newLine.mappings.endsWith(';A;')).toBe(true);
	});

	test('the text of a range maps as a whole to its start, at each of its lines', () => {
		check([
			{ source: main, start: 0, end: 6 },
			{ source: main, start: 6, end: 7, text: 'first\nsecond\nthird' },
			{ source: main, start: 7, end: 21 },
		]);
	});

	test('the text of a range that ends a line does not map the empty line after it', () => {
		const { map } = check([{ source: main, start: 0, end: 12, text: 'replaced\n' }, 'new']);
		expect(map.mappings).toBe('AAAA;A;');
	});

	test('the name of a range with text goes in names, at its first segment only', () => {
		const { map } = check([
			{ source: main, start: 0, end: 6, text: '\nlet\n', name: 'const' },
			{ source: main, start: 6, end: 7, text: 'b', name: 'a' },
			{ source: main, start: 7, end: 17, name: 'kept' },
			{ source: main, start: 17, end: 18, text: 'b.c', name: 'a' },
			{ source: main, start: 18, end: 21 },
		]);
		expect(map.names).toEqual(['const', 'a']);
	});

	test('kept text gives no name, as it is its own name, even with the name field of a view', () => {
		const rewrite = createSourceRewrite<TestSource, { name: string }>(main);
		rewrite.replace(6, 7, { source: main, start: 6, end: 7, text: 'b', name: 'a' });
		const { map } = renderWithSourceMap(
			sink => rewrite.render(0, main.content.length, sink, { name: 'view' }),
			(from: TestSource) => from.name,
		);
		expect(map.names).toEqual(['a']);
		const { map: kept } = check([{ source: main, start: 0, end: 13, name: 'kept' }]);
		expect(kept.names).toEqual([]);
	});

	test('a name of a range that maps nothing goes nowhere', () => {
		const { map } = check([
			{ source: main, start: 0, end: 6, text: '', name: 'const' },
			{ source: main, start: 6, end: 13, text: 'b = 1;\n', name: 'a' },
			{ source: main, start: 13, end: 14, text: '\n', name: 'log' },
		]);
		expect(map.names).toEqual(['a']);
	});

	test('empty text of a range maps nothing', () => {
		const { map } = check([{ source: main, start: 0, end: 6, text: '' }, { source: main, start: 6, end: 12 }]);
		expect(map.mappings.startsWith('AAAM')).toBe(true);
	});

	test('sources are in the order that the pieces first reach them, with their content and names', () => {
		const { map } = check([
			{ source: other, start: 2, end: 5 },
			{ source: main, start: 13, end: 21 },
			{ source: other, start: 0, end: 2 },
			{ source: main, start: 0, end: 13 },
		]);
		expect(map.sources).toEqual(['other.js', 'main.js']);
		expect(map.sourcesContent).toEqual([other.content, main.content]);
	});

	test('the source map follows moved text back and forth over long lines', () => {
		const long: TestSource = { name: 'long.js', content: `${'a'.repeat(5000)}\n${'b'.repeat(70)}\n${'c'.repeat(3)}` };
		check([
			{ source: long, start: 5071, end: 5074 },
			' ',
			{ source: long, start: 5001, end: 5071 },
			{ source: long, start: 4990, end: 5001, text: 'Z\n' },
			{ source: long, start: 0, end: 4990 },
		]);
	});

	test('random ranges of two sources, forward, back and across lines, map to their lines', () => {
		const random = createRandom(2);
		const chars = ['a', 'b', ' ', '\n', '\n', '.'];
		const contentOf = () => Array.from({ length: 1 + random(40) }, () => chars[random(chars.length)]).join('');
		for (let iteration = 0; iteration < 300; iteration++) {
			const sources: TestSource[] = [{ name: 'a.js', content: contentOf() }, { name: 'b.js', content: contentOf() }];
			const pieces: TestPiece[] = [];
			for (let count = 1 + random(12); count > 0; count--) {
				const source = sources[random(2)]!;
				const start = random(source.content.length + 1);
				const end = start + random(source.content.length - start + 1);
				const kind = random(4);
				pieces.push(
					kind === 0 ? 'x\n' : kind === 1 ? { source, start, end, text: 'y\nz' } : { source, start, end },
				);
			}
			check([...pieces, '\n']);
		}
	});

	test('mappings longer than a chunk of the encoder are whole', () => {
		const long: TestSource = { name: 'long.js', content: 'ab c;\n'.repeat(4000) };
		// Each start ends a chunk at another point of a segment.
		for (let start = 0; start < 6; start++) {
			const { map } = check([
				{ source: long, start: 12000 + start, end: long.content.length },
				{ source: long, start: 6000, end: 6003, text: 'x\ny', name: 'ab' },
				'\n',
				{ source: long, start: 0, end: 12000 },
			]);
			expect(map.mappings.length).toBeGreaterThan(65536);
		}
	});

	test('where no TextDecoder is defined, the first call throws before it renders', async () => {
		vi.stubGlobal('TextDecoder', undefined);
		vi.resetModules();
		try {
			const { renderWithSourceMap: withoutDecoder } = await import('../src/sourceMap');
			const rendered = vi.fn();
			expect(() => withoutDecoder<TestSource>(rendered, source => source.name)).toThrow(
				'renderWithSourceMap needs the global TextDecoder of the WHATWG Encoding Standard, which is not defined here.',
			);
			expect(rendered).not.toHaveBeenCalled();
		}
		finally {
			vi.unstubAllGlobals();
		}
	});

	test('a range that is not an integer range of the content of its source, or that has no source, is an error', () => {
		for (const [start, end] of [[-1, 2], [1.5, 2], [3, 2], [0, 22], [Number.NaN, 2], [0, Infinity]]) {
			expect(() => render([{ source: main, start: start!, end: end! }])).toThrow(
				`The range ${start}..${end} of main.js is out of 0..21.`,
			);
			expect(() => render(['new', { source: main, start: start!, end: end!, text: 'x' }])).toThrow(
				`The range ${start}..${end} of main.js is out of 0..21.`,
			);
		}
		expect(() => render([{ start: 0, end: 1 } as TestPiece])).toThrow('The range 0..1 has no source.');
		expect(() => render([{ source: null, start: 0, end: 1, text: 'x' } as unknown as TestPiece])).toThrow(
			'The range 0..1 has no source.',
		);
		expect(() => render([{ source: { name: 'empty' }, start: 0, end: 0 } as TestPiece])).toThrow(
			'The range 0..0 has no source.',
		);
		expect(render([{ source: main, start: 21, end: 21 }, { source: main, start: 0, end: 21, text: '' }]).text).toBe('');
	});

	test('a range that a rewrite renders as written is checked by the map', () => {
		const rewrite = createSourceRewrite(main);
		rewrite.replace(0, 5, { source: main, start: 0, end: 50, text: 'let' });
		rewrite.render(0, 21, () => {});
		const again = createSourceRewrite(main);
		again.replace(0, 5, { source: main, start: 0, end: 50, text: 'let' });
		expect(() => renderWithSourceMap(sink => again.render(0, 21, sink), source => source.name)).toThrow(
			'The range 0..50 of main.js is out of 0..21.',
		);
	});

	test('the map of a rewrite render is the map of its pieces', () => {
		const source: TestSource = { name: 'App.js', content: 'log(name);\nconst name = "Ada";\n' };
		const rewrite = createSourceRewrite(source);
		for (const { index } of source.content.matchAll(/\bname\b/g)) {
			rewrite.replace(index, index + 'name'.length, 'user');
		}
		rewrite.insertBefore(0, rewrite.cut(11, source.content.length));
		rewrite.insertAfter(0, '// generated\n');
		const pieces: TestPiece[] = [];
		rewrite.render(0, source.content.length, piece => pieces.push(piece));
		const fresh = createSourceRewrite(source);
		for (const { index } of source.content.matchAll(/\bname\b/g)) {
			fresh.replace(index, index + 'name'.length, 'user');
		}
		fresh.insertBefore(0, fresh.cut(11, source.content.length));
		fresh.insertAfter(0, '// generated\n');
		const rendered = renderWithSourceMap(sink => fresh.render(0, source.content.length, sink), from => from.name);
		expect(rendered).toEqual(check(pieces));
	});

	test('random edits of a rewrite give the map of their pieces', () => {
		const random = createRandom(1);
		const chars = ['a', 'b', '1', ' ', '\t', '\n', '_', '$', '-', '.', 'é', '名', '😀'];
		for (let iteration = 0; iteration < 500; iteration++) {
			const content = Array.from({ length: 1 + random(16) }, () => chars[random(chars.length)]).join('');
			const source: TestSource = { name: 'random.js', content };
			const { length } = content;
			const rewrite = createSourceRewrite<TestSource, { name?: string }>(source);
			if (length > 2 && random(2)) {
				const start = 1 + random(length - 2);
				const end = start + 1 + random(length - start - 1);
				rewrite.insertBefore(random(start), rewrite.cut(start, end));
			}
			for (let edit = random(6); edit > 0; edit--) {
				const writer = rewrite.writer(1 + random(3));
				const code = ['x', '\n', 'y\nz', ''][random(4)]!;
				const kind = random(4);
				if (kind === 0) {
					writer.insertBefore(random(length + 1), code);
				}
				else if (kind === 1) {
					writer.insertAfter(random(length + 1), code);
				}
				else {
					const start = random(length);
					const end = start + 1 + random(length - start);
					writer.replace(
						start,
						end,
						kind === 2 ? code : { source, start, end, text: code, ...random(2) ? { name: `n${random(3)}` } : {} },
					);
				}
			}
			const pieces: TestPiece[] = [];
			rewrite.render(0, length, piece => pieces.push(piece));
			// Node, 22 and 24, gives the last segment of mappings that do not end with a line the name of a segment before it.
			check([...pieces, '\n']);
		}
	});
});

describe('renderWithDecodedSourceMap', () => {
	test('gives the text and map of renderWithSourceMap, with the mappings decoded', () => {
		const rewrite = createSourceRewrite<TestSource, { name?: string }>(main);
		rewrite.replace(6, 7, { source: main, start: 6, end: 7, text: 'b', name: 'a' });
		rewrite.insertAfter(0, '// generated\n');
		const renderAll = (sink: (piece: TestPiece) => void) => rewrite.render(0, main.content.length, sink);
		const decoded = renderWithDecodedSourceMap(renderAll, (source: TestSource) => source.name);
		expect(decoded).toEqual(decodedOf(renderWithSourceMap(renderAll, (source: TestSource) => source.name)));
		expect(decoded.map.mappings).toEqual([
			[[0]],
			[[0, 0, 0, 0], [5, 0, 0, 5], [6, 0, 0, 6, 0], [7, 0, 0, 7], [8, 0, 0, 8], [9, 0, 0, 9], [10, 0, 0, 10], [11, 0, 0, 11]],
			[[0, 0, 1, 0], [3, 0, 1, 3], [4, 0, 1, 4], [5, 0, 1, 5], [6, 0, 1, 6]],
			[],
		]);
	});

	test('mappings that end with a segment without a source end with an empty line', () => {
		const { map } = renderDecoded([{ source: main, start: 0, end: 12 }, ' new']);
		expect(map.mappings.at(-2)!.at(-1)).toEqual([12]);
		expect(map.mappings.at(-1)).toEqual([]);
		expect(map.mappings.length).toBe(render([{ source: main, start: 0, end: 12 }, ' new']).map.mappings.split(';').length);
		expect(renderDecoded([{ source: main, start: 0, end: 12 }]).map.mappings).toHaveLength(1);
		expect(renderDecoded([]).map).toEqual({ version: 3, sources: [], sourcesContent: [], names: [], mappings: [[]] });
	});

	test('throws what renderWithSourceMap throws, on the same ranges', () => {
		const bad: TestPiece[][] = [
			...[[-1, 2], [1.5, 2], [3, 2], [0, 22], [Number.NaN, 2], [0, Infinity]].flatMap(([start, end]) => [
				[{ source: main, start: start!, end: end! }],
				['new', { source: main, start: start!, end: end!, text: 'x' }],
			]),
			[{ start: 0, end: 1 } as TestPiece],
			[{ source: null, start: 0, end: 1, text: 'x' } as unknown as TestPiece],
			[{ source: { name: 'empty' }, start: 0, end: 0 } as TestPiece],
		];
		for (const pieces of bad) {
			const error = thrown(() => render(pieces));
			expect(error).toBeDefined();
			expect(thrown(() => renderDecoded(pieces))).toBe(error);
		}
	});

	test('needs no TextDecoder', async () => {
		vi.stubGlobal('TextDecoder', undefined);
		vi.resetModules();
		try {
			const { renderWithDecodedSourceMap: decoded, renderWithSourceMap: encoded } = await import('../src/sourceMap');
			const pieces: TestPiece[] = [{ source: main, start: 0, end: 6 }, 'x'];
			expect(decoded<TestSource>(sink => pieces.forEach(sink), source => source.name)).toEqual(
				decodedOf(render(pieces)),
			);
			expect(() => encoded<TestSource>(sink => pieces.forEach(sink), source => source.name)).toThrow(
				'renderWithSourceMap needs the global TextDecoder of the WHATWG Encoding Standard, which is not defined here.',
			);
		}
		finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('encodeMappings', () => {
	test('writes each line of segments as v3 mappings, by fields relative to the segment before', () => {
		expect(encodeMappings([[[0, 0, 0, 0], [4]], [], [[2, 0, 1, 3, 0], [3, 1, 0, 0, 1]], [[0, 0, 2, 0, 0]]])).toBe(
			'AAAA,I;;EACGA,CCDHC;ADEAD',
		);
		expect(encodeMappings([[[16, 0, 0, 0]]])).toBe('gBAAA');
		expect(encodeMappings([[[2 ** 30 - 1]]])).toBe('+/////B');
		expect(encodeMappings([[]])).toBe('');
		expect(encodeMappings([])).toBe('');
	});

	test('throws on a field that is not an integer from 0 to 2 ** 30 - 1', () => {
		for (const value of [-1, -(2 ** 30), 1.5, 2 ** 30, 2 ** 31, 2 ** 32 + 1, Number.NaN, Infinity, -Infinity]) {
			expect(() => encodeMappings([[[0]], [[1, 0, value, 0]]])).toThrow(
				`The segment [1,0,${value},0] of line 1 has a field out of 0..2 ** 30 - 1.`,
			);
		}
	});

	test('where no TextDecoder is defined, it throws', async () => {
		vi.stubGlobal('TextDecoder', undefined);
		vi.resetModules();
		try {
			const { encodeMappings: withoutDecoder } = await import('../src/sourceMap');
			expect(() => withoutDecoder([[[0]]])).toThrow(
				'encodeMappings needs the global TextDecoder of the WHATWG Encoding Standard, which is not defined here.',
			);
		}
		finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('decodeMappings', () => {
	test('reads each line of v3 mappings as segments, by fields relative to the segment before', () => {
		expect(decodeMappings('AAAA,I;;EACGA,CCDHC;ADEAD')).toEqual(
			[[[0, 0, 0, 0], [4]], [], [[2, 0, 1, 3, 0], [3, 1, 0, 0, 1]], [[0, 0, 2, 0, 0]]],
		);
		expect(decodeMappings('gBAAA')).toEqual([[[16, 0, 0, 0]]]);
		expect(decodeMappings('+/////B')).toEqual([[[2 ** 30 - 1]]]);
		expect(decodeMappings('CAAA,DAAA')).toEqual([[[1, 0, 0, 0], [0, 0, 0, 0]]]);
		expect(decodeMappings('')).toEqual([[]]);
		expect(decodeMappings(';')).toEqual([[], []]);
	});

	test('gives back the mappings that encodeMappings writes', () => {
		const mappings = 'AAAA,I;;EACGA,CCDHC;ADEAD;;';
		expect(encodeMappings(decodeMappings(mappings))).toBe(mappings);
	});

	test('throws on an empty segment', () => {
		for (const mappings of [',A', 'A,', 'A,,A', 'A,;', ';,']) {
			expect(thrown(() => decodeMappings(mappings))).toMatch(/^SyntaxError: Line \d of the mappings has an empty segment\.$/);
		}
	});

	test('throws on a segment of other than 1, 4 or 5 fields', () => {
		expect(thrown(() => decodeMappings('A;AA'))).toBe(
			'SyntaxError: A segment of line 1 of the mappings has 2 fields, where a segment has 1, 4 or 5.',
		);
		expect(thrown(() => decodeMappings('AAA'))).toBe(
			'SyntaxError: A segment of line 0 of the mappings has 3 fields, where a segment has 1, 4 or 5.',
		);
		expect(thrown(() => decodeMappings('AAAAAA'))).toBe(
			'SyntaxError: A segment of line 0 of the mappings has more than 5 fields.',
		);
	});

	test('throws on a field that is not a base64 VLQ', () => {
		expect(thrown(() => decodeMappings('AAAA,g'))).toBe(
			'SyntaxError: The field at 5 of the mappings, on line 0, is not a base64 VLQ.',
		);
		expect(thrown(() => decodeMappings('A;g,A'))).toBe(
			'SyntaxError: The field at 2 of the mappings, on line 1, is not a base64 VLQ.',
		);
		expect(thrown(() => decodeMappings('A!'))).toBe(
			'SyntaxError: The field at 1 of the mappings, on line 0, is not a base64 VLQ.',
		);
		expect(thrown(() => decodeMappings('Aé'))).toBe(
			'SyntaxError: The field at 1 of the mappings, on line 0, is not a base64 VLQ.',
		);
	});

	test('throws on a field that ends out of 0..2 ** 30 - 1', () => {
		expect(thrown(() => decodeMappings('D'))).toBe(
			'RangeError: The segment [-1] of line 0 has a field out of 0..2 ** 30 - 1.',
		);
		expect(thrown(() => decodeMappings('A;AADA'))).toBe(
			'RangeError: The segment [0,0,-1,0] of line 1 has a field out of 0..2 ** 30 - 1.',
		);
		expect(thrown(() => decodeMappings('ggggggggB'))).toBe(
			`RangeError: The segment [${2 ** 39}] of line 0 has a field out of 0..2 ** 30 - 1.`,
		);
		expect(thrown(() => decodeMappings('+/////B,C'))).toBe(
			`RangeError: The segment [${2 ** 30}] of line 0 has a field out of 0..2 ** 30 - 1.`,
		);
	});
});
