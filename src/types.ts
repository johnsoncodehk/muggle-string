/**
 * Generated text: new text, which maps nowhere, or the range `start`..`end` of a source text. A range without `text`
 * is a copy of the text there; `text` is generated text that stands for the range, mapped as its consumer decides. An empty
 * range is an anchor. `Origin` is what a range carries beyond its offsets, as fields of the range itself: nothing for a
 * producer of one source, whose consumer knows the source; for a rewrite, whose code can mix sources, its `source`,
 * whose `content` a range without `text` copies, beside the fields of its consumer.
 */
export type Piece<Origin = unknown> = string | (Origin & {
	start: number;
	end: number;
	text?: string;
});

/** A source text, by the identity that the ranges of pieces carry: a range without `text` copies its `content`. */
export interface Source {
	readonly content: string;
}
