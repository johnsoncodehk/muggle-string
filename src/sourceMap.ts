import type { Piece, RewriteSource } from './types.js';

/** A source map of generated text to its sources, in the v3 format. */
export interface SourceMap {
	version: 3;
	sources: string[];
	sourcesContent: string[];
	names: string[];
	mappings: string;
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
 * `name` names, with their content, in the order that the pieces first reach them. Kept text maps to itself at the
 * start of each piece, line, word (a run of Unicode letters, marks and digits), run of whitespace and other char, as
 * `_`, `$` and `-`, which syntaxes differ on joining into names, so a position at a token boundary maps exactly in any
 * syntax whose tokens do not start inside such a word;
 * the `text` of a range maps as a whole to the start of the range, at the start of each of its lines but an empty last
 * one; new text maps nowhere, and where it starts a line or follows mapped text on one, a segment without a source
 * ends the mapping before it. The `name` of a range with `text` is the original name of the symbol that its generated
 * text starts with, as of a symbol that `text` renames; it goes in `names`, for the first segment of the range on a
 * char. Kept text is its own name, so the `name` of a range without `text` goes nowhere.
 */
export function renderWithSourceMap<Source extends RewriteSource>(
	render: (sink: (piece: Piece<{ source: Source; name?: string }>) => void) => void,
	name: (source: Source) => string,
): { text: string; map: SourceMap } {
	// before the render, which may render slices that render only once
	const latin1 = decoder ??= createDecoder();
	const sources = new Map<Source, { index: number; lineStarts: number[] }>();
	const map: SourceMap = { version: 3, sources: [], sourcesContent: [], names: [], mappings: '' };
	let text = '';
	const digits = base64Codes ??= Uint8Array.from(base64, char => char.charCodeAt(0));
	const chunks: string[] = [];
	const buffer = new Uint8Array(chunkSize);
	let length = 0;
	let column = 0;
	let lineHasSegment = false;
	let lineEndsMapped = false;
	let endsWithoutSource = false;
	let lastColumn = 0;
	let lastSource = 0;
	let lastLine = 0;
	let lastSourceColumn = 0;
	let lastName = 0;
	let pieceName: string | undefined;
	const names = new Map<string, number>();

	const encode = (value: number) => {
		let rest = value < 0 ? (-value << 1) | 1 : value << 1;
		do {
			let digit = rest & 31;
			rest >>>= 5;
			if (rest) {
				digit |= 32;
			}
			buffer[length++] = digits[digit]!;
		}
		while (rest);
	};
	// A segment takes at most a comma and five fields of 7 digits.
	const reserve = () => {
		if (length > chunkSize - 36) {
			chunks.push(latin1.decode(buffer.subarray(0, length)));
			length = 0;
		}
	};
	const segment = () => {
		reserve();
		if (lineHasSegment) {
			buffer[length++] = comma;
		}
		encode(column - lastColumn);
		lastColumn = column;
		lineHasSegment = true;
	};
	const mapTo = (source: number, line: number, sourceColumn: number, named = true) => {
		segment();
		encode(source - lastSource);
		encode(line - lastLine);
		encode(sourceColumn - lastSourceColumn);
		if (named && pieceName !== undefined) {
			let known = names.get(pieceName);
			if (known === undefined) {
				known = names.size;
				names.set(pieceName, known);
				map.names.push(pieceName);
			}
			encode(known - lastName);
			lastName = known;
			pieceName = undefined;
		}
		lastSource = source;
		lastLine = line;
		lastSourceColumn = sourceColumn;
		lineEndsMapped = true;
		endsWithoutSource = false;
	};
	const newLine = () => {
		reserve();
		buffer[length++] = semicolon;
		column = 0;
		lastColumn = 0;
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
	const sourceOf = (source: Source) => {
		let known = sources.get(source);
		if (!known) {
			const { content } = source;
			const lineStarts = [0];
			for (let index = content.indexOf('\n'); index >= 0; index = content.indexOf('\n', index + 1)) {
				lineStarts.push(index + 1);
			}
			known = { index: sources.size, lineStarts };
			sources.set(source, known);
			map.sources.push(name(source));
			map.sourcesContent.push(content);
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
		const { index, lineStarts } = sourceOf(piece.source);
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

	chunks.push(latin1.decode(buffer.subarray(0, length)));
	const mappings = chunks.join('');
	// Node reads a segment without a source that ends the mappings as one that keeps the source position before it
	map.mappings = endsWithoutSource ? mappings + ';' : mappings;
	return { text, map };
}

declare const TextDecoder: (new(label: string) => { decode(input: Uint8Array): string }) | undefined;

/** The decoder of the ASCII digits of the mappings, from the `TextDecoder` of the WHATWG Encoding Standard. */
function createDecoder() {
	if (typeof TextDecoder !== 'function') {
		throw new Error(
			'renderWithSourceMap needs the global TextDecoder of the WHATWG Encoding Standard, which is not defined here.',
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
