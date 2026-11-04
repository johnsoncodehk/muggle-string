import type { Piece, Source } from './types.js';

/** A source map of generated text to its sources, in the v3 format. */
export interface SourceMap {
	version: 3;
	sources: string[];
	sourcesContent: string[];
	names: string[];
	mappings: string;
}

/**
 * A segment of the `mappings` of a decoded source map, in zero-based numbers: the column in the generated line; for
 * a segment with a source, the index of its source in `sources`, then its line and column there; for a named one,
 * the index of its name in `names`.
 */
export type SourceMapSegment =
	| [column: number]
	| [column: number, source: number, sourceLine: number, sourceColumn: number]
	| [column: number, source: number, sourceLine: number, sourceColumn: number, name: number];

/** A source map whose `mappings` are the segments of each generated line, in the order of their columns. */
export interface DecodedSourceMap {
	version: 3;
	sources: string[];
	sourcesContent: string[];
	names: string[];
	mappings: SourceMapSegment[][];
}

/** Where a render puts the segments of its map, by absolute numbers, and what it makes of them at the end. */
interface SegmentWriter<Mappings> {
	/** A segment with a source, and a name unless `name` is -1. */
	mapped(column: number, source: number, line: number, sourceColumn: number, name: number): void;
	/** A segment without a source. */
	unmapped(column: number): void;
	newLine(): void;
	end(): Mappings;
}

const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Made at the first call that needs them, so that importing the module only defines its functions and constants.
let base64Codes: Uint8Array | undefined;
let decoder: { decode(input: Uint8Array): string } | undefined;
let space: RegExp | undefined;
let word: RegExp | undefined;

const comma = 44;
const semicolon = 59;
const chunkSize = 65536;

const enum CharClass {
	Space,
	Word,
	Other,
}

/**
 * The generated text of the pieces that `render` passes to its sink, and a v3 source map of it to their sources, which
 * `sourceName` names, with their content, in the order that the pieces first reach them. Kept text maps to itself at the
 * start of each piece, line, word (a run of Unicode letters, marks and digits), run of whitespace and other char, as
 * `_`, `$` and `-`, which syntaxes differ on joining into names, so a position at a token boundary maps exactly in any
 * syntax whose tokens do not start inside such a word;
 * the `text` of a range maps as a whole to the start of the range, at the start of each of its lines but an empty last
 * one; new text maps nowhere, and where it starts a line or follows mapped text on one, a segment without a source
 * ends the mapping before it. The `name` of a range with `text` is the original name of the symbol that its generated
 * text starts with, as of a symbol that `text` renames; it goes in `names`, for the first segment of the range on a
 * char. Kept text is its own name, so the `name` of a range without `text` goes nowhere.
 *
 * A range without a source, an object with a string `content`, or whose `start` and `end` are not integers with
 * 0 <= `start` <= `end` <= the length of the content, throws when it reaches the sink.
 */
export function renderWithSourceMap<S extends Source>(
	render: (sink: (piece: Piece<{ source: S; name?: string }>) => void) => void,
	sourceName: (source: S) => string,
): { text: string; map: SourceMap } {
	// before the render, which may render slices that render only once
	const latin1 = decoder ??= createDecoder('renderWithSourceMap');
	return renderWith(render, sourceName, new ByteWriter(latin1));
}

/**
 * The v3 `mappings` of decoded `mappings`, the segments of each line, as `renderWithSourceMap` writes them, so that it
 * gives the `mappings` of `renderWithSourceMap` for the `mappings` of `renderWithDecodedSourceMap`. A field that is not
 * an integer from 0 to 2 ** 30 - 1, beyond any string length, throws. Where no `TextDecoder` is defined, it throws.
 */
export function encodeMappings(mappings: readonly (readonly SourceMapSegment[])[]): string {
	const writer = new ByteWriter(decoder ??= createDecoder('encodeMappings'));
	for (let line = 0; line < mappings.length; line++) {
		if (line) {
			writer.newLine();
		}
		for (const segment of mappings[line]!) {
			for (let field = 0; field < segment.length; field++) {
				const value = segment[field]!;
				if (value >>> 0 !== value || value >= 2 ** 30) {
					throw new RangeError(`The segment [${segment}] of line ${line} has a field out of 0..2 ** 30 - 1.`);
				}
			}
			if (segment.length === 1) {
				writer.unmapped(segment[0]);
			}
			else {
				writer.mapped(segment[0], segment[1], segment[2], segment[3], segment.length === 5 ? segment[4] : -1);
			}
		}
	}
	return writer.end();
}

/**
 * The generated text and source map that `renderWithSourceMap` gives for the same `render` and `sourceName`, with
 * `mappings` decoded: encoding them line by line as v3 mappings gives the `mappings` of `renderWithSourceMap`, its
 * empty last line included. The segments follow its rules, and it throws where it throws. It needs no `TextDecoder`.
 */
export function renderWithDecodedSourceMap<S extends Source>(
	render: (sink: (piece: Piece<{ source: S; name?: string }>) => void) => void,
	sourceName: (source: S) => string,
): { text: string; map: DecodedSourceMap } {
	return renderWith(render, sourceName, new ArrayWriter());
}

/** The render of both maps, which decides every segment of them and gives each to `writer`. */
function renderWith<S extends Source, Mappings>(
	render: (sink: (piece: Piece<{ source: S; name?: string }>) => void) => void,
	sourceName: (source: S) => string,
	writer: SegmentWriter<Mappings>,
) {
	const sources = new Map<S, { index: number; lineStarts: number[]; length: number }>();
	const sourceNames: string[] = [];
	const sourcesContent: string[] = [];
	const names: string[] = [];
	let text = '';
	let column = 0;
	let lineHasSegment = false;
	let lineEndsMapped = false;
	let endsWithoutSource = false;
	let pieceName: string | undefined;
	const nameIndexes = new Map<string, number>();

	const segment = () => {
		writer.unmapped(column);
		lineHasSegment = true;
	};
	const mapTo = (source: number, line: number, sourceColumn: number, named = true) => {
		let name = -1;
		if (named && pieceName !== undefined) {
			let known = nameIndexes.get(pieceName);
			if (known === undefined) {
				known = nameIndexes.size;
				nameIndexes.set(pieceName, known);
				names.push(pieceName);
			}
			name = known;
			pieceName = undefined;
		}
		writer.mapped(column, source, line, sourceColumn, name);
		lineHasSegment = true;
		lineEndsMapped = true;
		endsWithoutSource = false;
	};
	const newLine = () => {
		writer.newLine();
		column = 0;
		lineHasSegment = false;
		lineEndsMapped = false;
		endsWithoutSource = false;
	};
	const advance = (code: string) => {
		let lineStart = 0;
		for (let index = code.indexOf('\n'); index >= 0; index = code.indexOf('\n', index + 1)) {
			newLine();
			lineStart = index + 1;
		}
		column += code.length - lineStart;
	};
	const sourceOf = (piece: Exclude<Piece<{ source: S }>, string>) => {
		const { source } = piece;
		let known = sources.get(source);
		if (!known) {
			const content = source?.content;
			if (typeof content !== 'string') {
				throw new TypeError(`The range ${piece.start}..${piece.end} has no source.`);
			}
			const lineStarts = [0];
			for (let index = content.indexOf('\n'); index >= 0; index = content.indexOf('\n', index + 1)) {
				lineStarts.push(index + 1);
			}
			known = { index: sources.size, lineStarts, length: content.length };
			sources.set(source, known);
			sourceNames.push(sourceName(source));
			sourcesContent.push(content);
		}
		return known;
	};

	render(piece => {
		if (typeof piece === 'string') {
			let lineStart = 0;
			while (true) {
				const lineEnd = piece.indexOf('\n', lineStart);
				const end = lineEnd < 0 ? piece.length : lineEnd;
				if (end > lineStart && (lineEndsMapped || !lineHasSegment)) {
					segment();
					lineEndsMapped = false;
					endsWithoutSource = true;
				}
				column += end - lineStart;
				if (lineEnd < 0) {
					break;
				}
				newLine();
				lineStart = lineEnd + 1;
			}
			text += piece;
			return;
		}
		const { index, lineStarts, length: sourceLength } = sourceOf(piece);
		const { start, end } = piece;
		// `>>> 0` keeps only integers from 0 to 2 ** 32 - 1, beyond any string length
		if (start >>> 0 !== start || end >>> 0 !== end || start > end || end > sourceLength) {
			throw new RangeError(`The range ${start}..${end} of ${sourceNames[index]} is out of 0..${sourceLength}.`);
		}
		pieceName = piece.text === undefined ? undefined : piece.name;
		let line = 0;
		let high = lineStarts.length - 1;
		while (line < high) {
			const mid = (line + high + 1) >> 1;
			if (lineStarts[mid]! <= piece.start) {
				line = mid;
			}
			else {
				high = mid - 1;
			}
		}
		let sourceColumn = piece.start - lineStarts[line]!;
		if (piece.text === undefined) {
			const { content } = piece.source;
			let previous = -1;
			for (let offset = piece.start; offset < piece.end; offset++) {
				const code = content.charCodeAt(offset);
				if (code === 10) {
					newLine();
					line++;
					sourceColumn = 0;
					previous = -1;
					continue;
				}
				if (code >= 0xdc00 && code <= 0xdfff && previous !== -1) {
					const high = content.charCodeAt(offset - 1);
					if (high >= 0xd800 && high <= 0xdbff) {
						column++;
						sourceColumn++;
						continue;
					}
				}
				const kind = classOf(content, offset, code);
				if (kind !== previous || kind === CharClass.Other) {
					mapTo(index, line, sourceColumn);
				}
				previous = kind;
				column++;
				sourceColumn++;
			}
			text += content.slice(piece.start, piece.end);
		}
		else if (piece.text) {
			const code = piece.text;
			let lineStart = 0;
			for (let lineEnd = code.indexOf('\n'); lineEnd >= 0 && lineEnd < code.length - 1; lineEnd = code.indexOf('\n', lineEnd + 1)) {
				mapTo(index, line, sourceColumn, lineEnd > lineStart);
				newLine();
				lineStart = lineEnd + 1;
			}
			mapTo(index, line, sourceColumn, code[lineStart] !== '\n');
			advance(code.slice(lineStart));
			text += code;
		}
		pieceName = undefined;
	});

	// Node reads a segment without a source that ends the mappings as one that keeps the source position before it
	if (endsWithoutSource) {
		newLine();
	}
	const map = { version: 3 as const, sources: sourceNames, sourcesContent, names, mappings: writer.end() };
	return { text, map };
}

/** The writer of v3 mappings, as the bytes of their digits in a reused buffer, decoded by chunk. */
class ByteWriter implements SegmentWriter<string> {
	digits = base64Codes ??= Uint8Array.from(base64, char => char.charCodeAt(0));
	chunks: string[] = [];
	buffer = new Uint8Array(chunkSize);
	length = 0;
	lineHasSegment = false;
	lastColumn = 0;
	lastSource = 0;
	lastLine = 0;
	lastSourceColumn = 0;
	lastName = 0;

	constructor(readonly latin1: { decode(input: Uint8Array): string }) {}

	encode(value: number) {
		let rest = value < 0 ? (-value << 1) | 1 : value << 1;
		const { buffer, digits } = this;
		let length = this.length;
		do {
			let digit = rest & 31;
			rest >>>= 5;
			if (rest) {
				digit |= 32;
			}
			buffer[length++] = digits[digit]!;
		}
		while (rest);
		this.length = length;
	}

	// A segment takes at most a comma and five fields of 7 digits.
	reserve() {
		if (this.length > chunkSize - 36) {
			this.chunks.push(this.latin1.decode(this.buffer.subarray(0, this.length)));
			this.length = 0;
		}
	}

	unmapped(column: number) {
		this.reserve();
		if (this.lineHasSegment) {
			this.buffer[this.length++] = comma;
		}
		this.encode(column - this.lastColumn);
		this.lastColumn = column;
		this.lineHasSegment = true;
	}

	mapped(column: number, source: number, line: number, sourceColumn: number, name: number) {
		this.unmapped(column);
		this.encode(source - this.lastSource);
		this.encode(line - this.lastLine);
		this.encode(sourceColumn - this.lastSourceColumn);
		if (name !== -1) {
			this.encode(name - this.lastName);
			this.lastName = name;
		}
		this.lastSource = source;
		this.lastLine = line;
		this.lastSourceColumn = sourceColumn;
	}

	newLine() {
		this.reserve();
		this.buffer[this.length++] = semicolon;
		this.lastColumn = 0;
		this.lineHasSegment = false;
	}

	end() {
		this.chunks.push(this.latin1.decode(this.buffer.subarray(0, this.length)));
		return this.chunks.join('');
	}
}

/** The writer of decoded mappings, as an array of the segments of each line. */
class ArrayWriter implements SegmentWriter<SourceMapSegment[][]> {
	line: SourceMapSegment[] = [];
	lines = [this.line];

	mapped(column: number, source: number, sourceLine: number, sourceColumn: number, name: number) {
		this.line.push(
			name === -1 ? [column, source, sourceLine, sourceColumn] : [column, source, sourceLine, sourceColumn, name],
		);
	}

	unmapped(column: number) {
		this.line.push([column]);
	}

	newLine() {
		this.lines.push(this.line = []);
	}

	end() {
		return this.lines;
	}
}

declare const TextDecoder: (new(label: string) => { decode(input: Uint8Array): string }) | undefined;

/** The decoder of the ASCII digits of the mappings, from the `TextDecoder` of the WHATWG Encoding Standard. */
function createDecoder(caller: string) {
	if (typeof TextDecoder !== 'function') {
		throw new Error(
			`${caller} needs the global TextDecoder of the WHATWG Encoding Standard, which is not defined here.`,
		);
	}
	return new TextDecoder('latin1');
}

function classOf(content: string, offset: number, code: number) {
	if (code < 128) {
		return code === 32 || (code >= 9 && code <= 13)
			? CharClass.Space
			: (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
			? CharClass.Word
			: CharClass.Other;
	}
	const spaces = space ??= /\s/y;
	spaces.lastIndex = offset;
	if (spaces.test(content)) {
		return CharClass.Space;
	}
	const words = word ??= /[\p{L}\p{M}\p{N}]/uy;
	words.lastIndex = offset;
	return words.test(content) ? CharClass.Word : CharClass.Other;
}
