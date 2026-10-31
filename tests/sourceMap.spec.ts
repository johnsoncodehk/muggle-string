import { originalPositionFor, TraceMap, traceSegment } from '@jridgewell/trace-mapping';
import { describe, expect, test } from 'vitest';
import { createSourceRewrite, type Piece, renderWithSourceMap, rewritePieceText, type SourceMap } from '../src';

interface TestSource {
	name: string;
	content: string;
}

type TestPiece = Piece<{ source: TestSource }>;

function render(pieces: TestPiece[]) {
	return renderWithSourceMap<TestSource>(sink => pieces.forEach(sink), source => source.name);
}

/**
 * Where each generated char of `pieces` must map, by line and column: a kept char to itself, the `text` of a range to
 * the start of the range at the start of each of its lines but an empty last one, and anything else nowhere.
 */
function expected(pieces: TestPiece[]) {
	const result: ({ source: string; offset: number } | null)[][] = [[]];
	for (const piece of pieces) {
		const text = rewritePieceText(piece);
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
				line.push({ source: piece.source.name, offset: piece.start + i });
			}
			else {
				const lineStart = i === 0 || text[i - 1] === '\n';
				line.push(lineStart ? { source: piece.source.name, offset: piece.start } : undefined as never);
			}
		}
	}
	return result;
}

function offsetOf(map: SourceMap, source: string, line: number, column: number) {
	const content = map.sourcesContent[map.sources.indexOf(source)]!;
	const lines = content.split('\n');
	return lines.slice(0, line).reduce((offset, text) => offset + text.length + 1, 0) + column;
}

/** Checks the map of `pieces` at every generated char against `expected`, by greatest lower bound. */
function check(pieces: TestPiece[]) {
	const { text, map } = render(pieces);
	expect(text).toBe(pieces.map(rewritePieceText).join(''));
	const trace = new TraceMap(map as never);
	expected(pieces).forEach((chars, line) => {
		let inText: { source: string; offset: number } | null = null;
		chars.forEach((want, column) => {
			const got = originalPositionFor(trace, { line: line + 1, column });
			const at = got.source === null ? null : { source: got.source, offset: offsetOf(map, got.source, got.line - 1, got.column) };
			if (want === undefined) {
				// a later char of a line of the text of a range maps where the line starts
				expect(at, `${line}:${column}`).toEqual(inText);
				return;
			}
			expect(at, `${line}:${column}`).toEqual(want);
			inText = want;
		});
	});
	return { text, map };
}

const main: TestSource = { name: 'main.js', content: 'const a = 1;\nlog(a);\n' };
const other: TestSource = { name: 'other.js', content: 'x\ny\nz' };

describe('renderWithSourceMap', () => {
	test('kept text maps each char to itself, across lines', () => {
		const { map } = check([{ source: main, start: 0, end: main.content.length }]);
		expect(map).toEqual({
			version: 3,
			sources: ['main.js'],
			sourcesContent: [main.content],
			names: [],
			mappings: 'AAAA,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC;AACX,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC;',
		});
	});

	test('new text maps nowhere, and ends the mapping of the text before it on its line', () => {
		const { map } = check([{ source: main, start: 0, end: 5 }, ' /* new */', { source: main, start: 5, end: 12 }]);
		const trace = new TraceMap(map as never);
		expect(traceSegment(trace, 0, 5)).toEqual([5]);
		expect(traceSegment(trace, 0, 14)).toEqual([5]);
		expect(traceSegment(trace, 0, 15)).toEqual([15, 0, 0, 5]);
	});

	test('new text at the start of a line maps nowhere without a segment', () => {
		const { map } = check([{ source: main, start: 0, end: 13 }, 'new\n', { source: main, start: 13, end: 21 }]);
		expect(map.mappings.split(';')[1]).toBe('');
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
		expect(map.mappings).toBe('AAAA;');
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
