// The checks of a range that the text render, the map render and the edits of a rewrite share, so that all of them take
// and refuse the same ranges.

/** What is wrong with a range: the class of its error, and the rest of the sentence that starts with the range. */
export type RangeProblem = [type: TypeErrorConstructor | RangeErrorConstructor, problem: string];

/** A range as it arrives, before it is known to be one. */
export interface UncheckedRange {
	start: number;
	end: number;
	text?: unknown;
	name?: unknown;
	source?: { content?: unknown } | null;
}

export function isRange(start: number, end: number, length: number) {
	return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length;
}

/** The problem of a range without a source: the only one whose range no source names. */
export const noSource: RangeProblem = [TypeError, 'has no source'];

/**
 * What is wrong with the range `piece`, if anything: no source with a string `content`, a `start` and `end` that are
 * not integers with 0 <= `start` <= `end` <= the length of the content, or a `text` or a `name` that is neither
 * undefined nor a string. A range with `text` is checked like one without: its range is where its text maps to.
 */
export function rangeProblem(piece: UncheckedRange): RangeProblem | undefined {
	const content = piece.source?.content;
	if (typeof content !== 'string') {
		return noSource;
	}
	if (!isRange(piece.start, piece.end, content.length)) {
		return [RangeError, `is out of 0..${content.length}`];
	}
	const { text, name } = piece;
	if (text !== undefined && typeof text !== 'string') {
		return [TypeError, 'has a text that is not a string'];
	}
	if (name !== undefined && typeof name !== 'string') {
		return [TypeError, 'has a name that is not a string'];
	}
	return undefined;
}

/** `value` as an error message names it. */
export function describe(value: unknown) {
	return typeof value === 'function'
		? 'a function'
		: typeof value === 'symbol'
		? 'a symbol'
		: typeof value === 'bigint'
		? `${value}n`
		: typeof value === 'string'
		? JSON.stringify(value)
		: typeof value === 'object' && value !== null
		? Array.isArray(value) ? 'an array' : 'an object'
		: String(value);
}

/** The error of a piece that is neither a string nor an object. */
export function notPiece(piece: unknown) {
	return new TypeError(`A piece is a string or a range, not ${describe(piece)}.`);
}
