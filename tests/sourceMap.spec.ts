import { originalPositionFor, TraceMap, traceSegment } from '@jridgewell/trace-mapping';
import { SourceMap as NodeSourceMap } from 'node:module';
import { describe, expect, test, vi } from 'vitest';
import { createSourceRewrite, type Piece, renderWithSourceMap, rewritePieceText, type SourceMap } from '../src';

interface TestSource {
	name: string;
	content: string;
}

type TestPiece = Piece<{ source: TestSource; name?: string }>;
type Position = { source: string; offset: number; name: string | null };

function render(pieces: TestPiece[]) {
	return renderWithSourceMap<TestSource>(sink => pieces.forEach(sink), source => source.name);
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
 * trace-mapping and the one across lines of Node, which reads a segment without a source as no original position.
 */
function check(pieces: TestPiece[]) {
	const { text, map } = render(pieces);
	expect(text).toBe(pieces.map(rewritePieceText).join(''));
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

	test('mappings are the same where no TextDecoder is defined', async () => {
		const pieces: TestPiece[] = [
			{ source: main, start: 13, end: 21 },
			{ source: main, start: 6, end: 7, text: 'b', name: 'a' },
			{ source: main, start: 0, end: 13 },
		];
		const long: TestSource = { name: 'long.js', content: 'ab c;\n'.repeat(4000) };
		const longPieces: TestPiece[] = [{ source: long, start: 0, end: long.content.length }];
		vi.stubGlobal('TextDecoder', undefined);
		vi.resetModules();
		try {
			const { renderWithSourceMap: withoutDecoder } = await import('../src/sourceMap');
			for (const each of [pieces, longPieces]) {
				expect(withoutDecoder<TestSource>(sink => each.forEach(sink), source => source.name)).toEqual(render(each));
			}
		}
		finally {
			vi.unstubAllGlobals();
		}
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
});
