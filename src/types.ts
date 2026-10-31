/**
 * Generated text: new text, which maps nowhere, or the range `start`..`end` of a source text. A range without `text`
 * is a copy of the text there; `text` is generated text that stands for the range, mapped as its consumer decides. An empty
 * range is an anchor. `Origin` is what a range carries beyond its offsets: nothing for a producer of one source and no
 * data, whose consumer knows the source; `{ source, data }` for a rewrite, whose code can mix sources and whose
 * ranges read their text from `source.content`.
 */
export type Piece<Origin = unknown> = string | (Origin & {
	start: number;
	end: number;
	text?: string;
});

/** A source text of a rewrite, by the identity that the ranges of its pieces carry. */
export interface RewriteSource {
	readonly content: string;
}
