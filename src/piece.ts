// The checks of a piece that the text render and the edits of a rewrite share, so that both take and refuse the same
// pieces.

/** What is wrong with a range: the class of its error, and the rest of the sentence that starts with the range. */
export type RangeProblem = [type: TypeErrorConstructor | RangeErrorConstructor, problem: string];

/** A range as it arrives, before it is known to be one. */
export interface UncheckedRange {
	start: number;
	end: number;
	text?: unknown;
	source?: { content?: unknown } | null;
}

export function isRange(start: number, end: number, length: number) {
	return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length;
}

/** The problem of a range without a source: the only one whose range no source names. */
export const noSource: RangeProblem = [TypeError, 'has no source'];

/**
 * What is wrong with the range `piece`, if anything: a range without `text`, or whose `text` is null, that has no
 * source with a string `content`, or whose `start` and `end` are not integers with 0 <= `start` <= `end` <= the length
 * of the content. A range with `text` is its text.
 */
export function rangeProblem(piece: UncheckedRange): RangeProblem | undefined {
	if (piece.text != null) {
		return undefined;
	}
	const content = piece.source?.content;
	if (typeof content !== 'string') {
		return noSource;
	}
	if (!isRange(piece.start, piece.end, content.length)) {
		return [RangeError, `is out of 0..${content.length}`];
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
