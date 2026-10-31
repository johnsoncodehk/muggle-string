import type { Piece, RewriteSource } from './types';

/** A source map of generated text to its sources, in the v3 format. */
export interface SourceMap {
	version: 3;
	sources: string[];
	sourcesContent: string[];
	names: string[];
	mappings: string;
}

const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The generated text of the pieces that `render` passes to its sink, and a v3 source map of it to their sources, which
 * `name` names, with their content, in the order that the pieces first reach them. Each kept char maps to itself; the
 * `text` of a range maps as a whole to the start of the range, at the start of each of its lines but an empty last
 * one; new text maps nowhere, and where it follows mapped text on a line, a segment without a source ends that mapping.
 */
export function renderWithSourceMap<Source extends RewriteSource>(
	render: (sink: (piece: Piece<{ source: Source }>) => void) => void,
	name: (source: Source) => string,
): { text: string; map: SourceMap } {
	const sources = new Map<Source, { index: number; lineStarts: number[] }>();
	const map: SourceMap = { version: 3, sources: [], sourcesContent: [], names: [], mappings: '' };
	let text = '';
	let mappings = '';
	let column = 0;
	let lineHasSegment = false;
	let lineEndsMapped = false;
	let lastColumn = 0;
	let lastSource = 0;
	let lastLine = 0;
	let lastSourceColumn = 0;

	const segment = (fields: string) => {
		mappings += (lineHasSegment ? ',' : '') + encode(column - lastColumn) + fields;
		lastColumn = column;
		lineHasSegment = true;
	};
	const mapTo = (source: number, line: number, sourceColumn: number) => {
		segment(encode(source - lastSource) + encode(line - lastLine) + encode(sourceColumn - lastSourceColumn));
		lastSource = source;
		lastLine = line;
		lastSourceColumn = sourceColumn;
		lineEndsMapped = true;
	};
	const newLine = () => {
		mappings += ';';
		column = 0;
		lastColumn = 0;
		lineHasSegment = false;
		lineEndsMapped = false;
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
			if (lineEndsMapped && piece[0] !== '\n') {
				segment('');
				lineEndsMapped = false;
			}
			advance(piece);
			text += piece;
			return;
		}
		const { index, lineStarts } = sourceOf(piece.source);
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
			for (let offset = piece.start; offset < piece.end; offset++) {
				if (content.charCodeAt(offset) === 10) {
					newLine();
					line++;
					sourceColumn = 0;
				}
				else {
					mapTo(index, line, sourceColumn);
					column++;
					sourceColumn++;
				}
			}
			text += content.slice(piece.start, piece.end);
		}
		else if (piece.text) {
			const code = piece.text;
			let lineStart = 0;
			for (let lineEnd = code.indexOf('\n'); lineEnd >= 0 && lineEnd < code.length - 1; lineEnd = code.indexOf('\n', lineEnd + 1)) {
				mapTo(index, line, sourceColumn);
				newLine();
				lineStart = lineEnd + 1;
			}
			mapTo(index, line, sourceColumn);
			advance(code.slice(lineStart));
			text += code;
		}
	});

	map.mappings = mappings;
	return { text, map };
}

function encode(value: number) {
	let rest = value < 0 ? (-value << 1) | 1 : value << 1;
	let code = '';
	do {
		let digit = rest & 31;
		rest >>>= 5;
		if (rest) {
			digit |= 32;
		}
		code += base64[digit];
	}
	while (rest);
	return code;
}
